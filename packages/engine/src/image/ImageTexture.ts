// ImageTexture - one decoded image on the GPU, plus the bind groups the image lane binds it
// through.
//
// Wrapping (clamp / repeat / mirror) and filtering are SAMPLER state, and a sampler is part
// of a bind group, so a texture drawn clamped and the same texture drawn tiled are two bind
// groups over one texture. They are built on demand and cached here, keyed by the
// combination, because an application typically uses one or two across a whole scene - which
// keeps the batcher's draw ranges merged (see ImageBatcher).
//
// Doing the wrap in the shader instead would make it a per-object property and never need a
// second bind group, but fract()-style wrapping and linear filtering disagree at the seam:
// the filter blends across the discontinuity and leaves a visible line at every tile edge.
// Hardware address modes do not have that problem, so the sampler is the right place for it.

import { createAtlasBindGroupLayout } from '../render/layouts'
import { resizeSvgDocument, resolveSvgPixelSize, type SvgSizeOptions } from './svgSize'

/** How texture coordinates outside [0,1] resolve. Maps to GPUAddressMode. */
export type ImageWrap = 'clamp' | 'repeat' | 'mirror'

/** How a texel is sampled: smooth for photographs, sharp for pixel art. */
export type ImageFilter = 'linear' | 'nearest'

/** The sampler state one bind group covers. */
export interface ImageSampling {
  wrapX: ImageWrap
  wrapY: ImageWrap
  filter: ImageFilter
}

export const DEFAULT_SAMPLING: ImageSampling = { wrapX: 'clamp', wrapY: 'clamp', filter: 'linear' }

const ADDRESS_MODE: Record<ImageWrap, GPUAddressMode> = {
  clamp: 'clamp-to-edge',
  repeat: 'repeat',
  mirror: 'mirror-repeat',
}

function samplingKey(s: ImageSampling): string {
  return `${s.wrapX}|${s.wrapY}|${s.filter}`
}

/** What an SVG rasterization may be told, beyond its size. */
export interface SvgRasterOptions extends SvgSizeOptions {
  layout?: GPUBindGroupLayout
  label?: string
}

const SVG_TYPE = 'image/svg+xml'

/**
 * Draws an SVG document with the browser's decoder and returns its pixels, RGBA8.
 *
 * The document arrives as a blob URL rather than a data URL: it avoids base64-encoding the
 * whole file, and being same-origin it does not taint the canvas it is drawn onto. decode()
 * is what reports a malformed document - an <img> that fails to parse otherwise just stays
 * blank, with no error anywhere.
 *
 * It goes through a canvas and comes back as pixels rather than being handed to the GPU as
 * an external image, so the upload is writeTexture, which every implementation supports.
 * That costs one copy of the image through system memory, once, at load.
 *
 * The width and height are passed to drawImage even though the document has already been
 * resized to match: whether an <img> rasterizes an SVG at its intrinsic size or at the size
 * it is drawn varies, and giving both the same number means the answer does not matter.
 */
async function rasterizeSvgPixels(svgText: string, width: number, height: number): Promise<Uint8ClampedArray> {
  const url = URL.createObjectURL(new Blob([svgText], { type: `${SVG_TYPE};charset=utf-8` }))
  try {
    const img = document.createElement('img')
    img.decoding = 'async'
    img.src = url
    try {
      await img.decode()
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`svg raster: the document could not be decoded - check that it is well-formed SVG (${detail})`)
    }

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('svg raster: a 2D context could not be created to draw into')
    ctx.drawImage(img, 0, 0, width, height)
    return ctx.getImageData(0, 0, width, height).data
  } finally {
    URL.revokeObjectURL(url)
  }
}

export class ImageTexture {
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
  static async load(device: GPUDevice, url: string, layout = createAtlasBindGroupLayout(device)): Promise<ImageTexture> {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`ImageTexture.load: ${url} responded ${response.status}`)

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes(SVG_TYPE) || /\.svgz?(?:[?#]|$)/i.test(url)) {
      return ImageTexture.fromSvg(device, await response.text(), { layout, label: url })
    }

    const bitmap = await createImageBitmap(await response.blob())
    try {
      return ImageTexture.fromSource(device, bitmap, layout, url)
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
  ): ImageTexture {
    const width = source.width
    const height = source.height
    const texture = device.createTexture({
      label: `image:${label}`,
      size: [width, height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    device.queue.copyExternalImageToTexture({ source }, { texture }, [width, height])
    return new ImageTexture(device, layout, texture, width, height)
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
  ): ImageTexture {
    if (width <= 0 || height <= 0) throw new Error(`ImageTexture.fromPixels: ${width}x${height} has no area`)
    const needed = width * height * 4
    if (pixels.length < needed) {
      throw new Error(`ImageTexture.fromPixels: ${pixels.length} bytes for a ${width}x${height} RGBA image, need ${needed}`)
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

    return new ImageTexture(device, layout, texture, width, height)
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
   *
   * The browser rasterizes an <img>-loaded SVG in its restricted mode: no scripts, no
   * animation, and no external references - webfonts, external stylesheets and linked images
   * are not fetched, so text falls back to whatever font is already available. Everything
   * the document needs has to be inline.
   */
  static async fromSvg(device: GPUDevice, svgText: string, options: SvgRasterOptions = {}): Promise<ImageTexture> {
    const { width, height } = resolveSvgPixelSize(svgText, options)

    const limit = device.limits?.maxTextureDimension2D
    if (limit !== undefined && (width > limit || height > limit)) {
      throw new Error(
        `svg raster: ${width}x${height} exceeds this device's maximum texture size of ${limit} - lower scale or the requested size`,
      )
    }

    const pixels = await rasterizeSvgPixels(resizeSvgDocument(svgText, width, height), width, height)
    return ImageTexture.fromPixels(
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
