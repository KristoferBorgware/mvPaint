// WebGpuImageTexture - one decoded image as a GPUTexture, plus the bind groups the WebGPU
// image lane binds it through.
//
// A texture drawn clamped and the same texture drawn tiled are two bind groups over one
// texture, because wrapping and filtering are SAMPLER state and a sampler is part of a bind
// group. They are built on demand and cached here, keyed by the combination, because an
// application typically uses one or two across a whole scene - which keeps the batcher's
// draw ranges merged (see webgpu/lanes/ImageBatcher.ts).
//
// Everything that is not about WebGPU - the sampling vocabulary, the ImageTexture interface
// an Image node holds, and the SVG rasterizer, which produces plain pixels - lives in
// image/ImageTexture.ts and is shared with the WebGL fallback path.

import { createAtlasBindGroupLayout } from './layouts'
import {
  assertSvgFits,
  isSvgSource,
  rasterizeSvgPixels,
  resizeSvgDocument,
  resolveSvgPixelSize,
  samplingKey,
  type ImageSampling,
  type ImageTexture,
  type ImageTextureFactory,
  type ImageWrap,
  type SvgRasterOptions,
} from '../image/ImageTexture'

const ADDRESS_MODE: Record<ImageWrap, GPUAddressMode> = {
  clamp: 'clamp-to-edge',
  repeat: 'repeat',
  mirror: 'mirror-repeat',
}

/** WebGPU-only extra: reuse a bind group layout instead of creating one per texture. */
export interface WebGpuSvgRasterOptions extends SvgRasterOptions {
  layout?: GPUBindGroupLayout
}

export class WebGpuImageTexture implements ImageTexture {
  readonly width: number
  readonly height: number

  private readonly device: GPUDevice
  private readonly layout: GPUBindGroupLayout
  private readonly texture: GPUTexture
  private readonly bindGroups = new Map<string, GPUBindGroup>()

  private constructor(device: GPUDevice, layout: GPUBindGroupLayout, texture: GPUTexture, width: number, height: number) {
    this.device = device
    this.layout = layout
    this.texture = texture
    this.width = width
    this.height = height
  }

  /**
   * Fetches and decodes an image, then uploads it.
   *
   * An SVG is rasterized at its own intrinsic size - createImageBitmap cannot take an SVG
   * blob directly, and a document has no one right pixel size anyway. Call fromSvg() when
   * the size or scale should be yours to choose.
   */
  static async load(device: GPUDevice, url: string, layout = createAtlasBindGroupLayout(device)): Promise<WebGpuImageTexture> {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`WebGpuImageTexture.load: ${url} responded ${response.status}`)

    const contentType = response.headers.get('content-type') ?? ''
    if (isSvgSource(url, contentType)) {
      return WebGpuImageTexture.fromSvg(device, await response.text(), { layout, label: url })
    }

    const bitmap = await createImageBitmap(await response.blob())
    try {
      return WebGpuImageTexture.fromSource(device, bitmap, layout, url)
    } finally {
      bitmap.close()
    }
  }

  /**
   * Uploads anything copyExternalImageToTexture accepts, letting the driver move the image
   * without it passing through system memory. The source is read once here and not retained.
   *
   * Support for that copy is not universal - a software adapter may reject every source it
   * is given, including ones the specification allows. fromPixels() uploads through
   * writeTexture instead and has no such gap, at the cost of a copy; fromSvg() uses it for
   * that reason.
   */
  static fromSource(
    device: GPUDevice,
    source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas,
    layout = createAtlasBindGroupLayout(device),
    label = 'image',
  ): WebGpuImageTexture {
    const width = source.width
    const height = source.height
    const texture = device.createTexture({
      label: `image:${label}`,
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    device.queue.copyExternalImageToTexture({ source }, { texture }, [width, height])
    return new WebGpuImageTexture(device, layout, texture, width, height)
  }

  /**
   * Uploads raw RGBA8 pixels, row-major from the top-left, 4 bytes per pixel. Unlike
   * fromSource this asks nothing of the browser's image pipeline, so it works for pixels
   * computed rather than decoded - a procedural texture, a decoded frame, a canvas read back
   * through getImageData().
   *
   * Rows are padded to the 256-byte multiple writeTexture requires for a multi-row copy,
   * which raw pixel data almost never satisfies on its own: any width that is not a multiple
   * of 64 pixels needs it.
   *
   * Pixels are taken as straight (non-premultiplied) alpha, which is what getImageData and
   * ImageData already hold, and what the image lane's blend expects.
   */
  static fromPixels(
    device: GPUDevice,
    pixels: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    layout = createAtlasBindGroupLayout(device),
    label = 'pixels',
  ): WebGpuImageTexture {
    if (width <= 0 || height <= 0) throw new Error(`WebGpuImageTexture.fromPixels: ${width}x${height} has no area`)
    const needed = width * height * 4
    if (pixels.length < needed) {
      throw new Error(`WebGpuImageTexture.fromPixels: ${pixels.length} bytes for a ${width}x${height} RGBA image, need ${needed}`)
    }

    const texture = device.createTexture({
      label: `image:${label}`,
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })

    const tightRow = width * 4
    const paddedRow = Math.ceil(tightRow / 256) * 256
    // Copied into a buffer this owns either way: a padded upload needs a new one, and the
    // unpadded case still needs the bytes in a plain ArrayBuffer for writeTexture's types.
    const data = new Uint8Array(paddedRow * height)
    for (let y = 0; y < height; y++) {
      data.set(pixels.subarray(y * tightRow, (y + 1) * tightRow), y * paddedRow)
    }
    device.queue.writeTexture({ texture }, data, { bytesPerRow: paddedRow, rowsPerImage: height }, [width, height])

    return new WebGpuImageTexture(device, layout, texture, width, height)
  }

  /**
   * Rasterizes an SVG document and uploads the result.
   *
   * The size is settled before anything is drawn: the requested width/height, or the
   * document's own, times `scale`. That size is written into the markup so the browser
   * rasterizes at it directly, rather than drawing small and being stretched afterwards.
   *
   * What this produces is pixels, so it is fixed at that resolution - zoom past `scale` and
   * it softens like any other image. Rasterize once for artwork that is drawn at a settled
   * size or repeated many times; for something that must stay sharp at any zoom, load the
   * document as vectors instead (loadSvgDocument) and let it be geometry.
   */
  static async fromSvg(device: GPUDevice, svgText: string, options: WebGpuSvgRasterOptions = {}): Promise<WebGpuImageTexture> {
    const { width, height } = resolveSvgPixelSize(svgText, options)

    assertSvgFits(width, height, device.limits?.maxTextureDimension2D)

    const pixels = await rasterizeSvgPixels(resizeSvgDocument(svgText, width, height), width, height)
    return WebGpuImageTexture.fromPixels(
      device,
      pixels,
      width,
      height,
      options.layout ?? createAtlasBindGroupLayout(device),
      options.label ?? 'svg',
    )
  }

  /** The bind group for one sampler combination, built once and reused. */
  bindGroupFor(sampling: ImageSampling): GPUBindGroup {
    const key = samplingKey(sampling)
    const existing = this.bindGroups.get(key)
    if (existing) return existing

    const sampler = this.device.createSampler({
      label: `image-sampler:${key}`,
      magFilter: sampling.filter,
      minFilter: sampling.filter,
      addressModeU: ADDRESS_MODE[sampling.wrapX],
      addressModeV: ADDRESS_MODE[sampling.wrapY],
    })
    const bindGroup = this.device.createBindGroup({
      label: `image:${key}`,
      layout: this.layout,
      entries: [
        { binding: 0, resource: this.texture.createView() },
        { binding: 1, resource: sampler },
      ],
    })
    this.bindGroups.set(key, bindGroup)
    return bindGroup
  }

  destroy(): void {
    this.bindGroups.clear()
    this.texture.destroy()
  }
}

/**
 * The factory a WebGPU renderer hands its scenes (`handle.images`).
 *
 * It closes over the device and ONE bind group layout, which is the point: every texture a
 * scene builds through it shares that layout, so the image lane can bind any of them without
 * a pipeline change. Building each texture with its own layout would work and cost a pipeline
 * per picture.
 */
export function webGpuImageFactory(device: GPUDevice, layout: GPUBindGroupLayout): ImageTextureFactory {
  return {
    load: (url) => WebGpuImageTexture.load(device, url, layout),
    fromSource: (source, label) => WebGpuImageTexture.fromSource(device, source, layout, label),
    fromPixels: (pixels, width, height, label) =>
      WebGpuImageTexture.fromPixels(device, pixels, width, height, layout, label),
    fromSvg: (svgText, options) => WebGpuImageTexture.fromSvg(device, svgText, { ...options, layout }),
  }
}
