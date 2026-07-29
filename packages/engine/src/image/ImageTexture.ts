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

  /** Fetches and decodes an image, then uploads it. */
  static async load(device: GPUDevice, url: string, layout = createAtlasBindGroupLayout(device)): Promise<ImageTexture> {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`ImageTexture.load: ${url} responded ${response.status}`)
    const bitmap = await createImageBitmap(await response.blob())
    try {
      return ImageTexture.fromSource(device, bitmap, layout, url)
    } finally {
      bitmap.close()
    }
  }

  /**
   * Uploads anything copyExternalImageToTexture accepts. An ImageBitmap is the dependable
   * case; a canvas element is accepted by the type but browsers vary on whether one that was
   * never in the document can be copied from - Chromium refuses. For pixels you generated,
   * fromPixels() avoids that path entirely. The source is read once here and not retained.
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
