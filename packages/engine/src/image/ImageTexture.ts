// What an image IS to a scene, with no opinion about which API is holding it.
//
// An Image node carries a texture (shapes/Image.ts), so the type of that texture reaches the
// scene graph - and the scene graph owns no GPU resources and knows no GPU API. So the type
// here is an interface: a size, and the promise that it can be released. Everything a render
// path actually needs to BIND is its own business, declared on its own implementation
// (webgpu/ImageTexture.ts, and the WebGL fallback's own), never here.
//
// Wrapping and filtering live here rather than on an implementation because they are a
// property of the picture as the application describes it, not of the machinery: "this one
// tiles, that one is pixel art". Each render path maps them onto its own sampler state.
//
// Doing the wrap in the shader instead would make it a per-object property and never need a
// second sampler, but fract()-style wrapping and linear filtering disagree at the seam: the
// filter blends across the discontinuity and leaves a visible line at every tile edge.
// Hardware address modes do not have that problem, so the sampler is the right place for it.
//
// The SVG rasterizer sits here too. It produces PIXELS - <img> decode, draw, getImageData -
// and touches no GPU API at all, so both render paths hand its output to their own upload.

import type { SvgSizeOptions } from './svgSize'

/** How texture coordinates outside [0,1] resolve. */
export type ImageWrap = 'clamp' | 'repeat' | 'mirror'

/** How a texel is sampled: smooth for photographs, sharp for pixel art. */
export type ImageFilter = 'linear' | 'nearest'

/** The sampler state one cached binding covers. */
export interface ImageSampling {
  wrapX: ImageWrap
  wrapY: ImageWrap
  filter: ImageFilter
}

export const DEFAULT_SAMPLING: ImageSampling = { wrapX: 'clamp', wrapY: 'clamp', filter: 'linear' }

/** Cache key for one sampler combination - shared, so both paths key their caches alike. */
export function samplingKey(s: ImageSampling): string {
  return `${s.wrapX}|${s.wrapY}|${s.filter}`
}

/**
 * One decoded image on the GPU.
 *
 * Deliberately small: a size, which an Image node needs to resolve its default width/height
 * and its UVs (see image/imageUv.ts), and a release. A renderer that is handed one of these
 * knows which implementation it created and narrows to it; nothing in `shapes/` ever does.
 */
export interface ImageTexture {
  readonly width: number
  readonly height: number
  destroy(): void
}

/**
 * How a scene asks for an image texture without knowing which path will draw it.
 *
 * A renderer hands one of these out (`handle.images`) because
 * building a texture is the one piece of GPU work an application cannot avoid doing itself -
 * only it knows which pictures the scene wants. Four ways in, matching the four things an
 * application actually has: a URL, an already-decoded bitmap, raw pixels it computed, or an
 * SVG document it wants rasterized at a size of its choosing.
 */
export interface ImageTextureFactory {
  /**
   * Fetches and decodes an image, then uploads it. An SVG is rasterized at its own intrinsic
   * size - a document has no one right pixel size, so call `fromSvg` when the size or scale
   * should be yours to choose.
   */
  load(url: string): Promise<ImageTexture>
  /** Uploads an already-decoded bitmap or canvas. The source is read once and not retained. */
  fromSource(source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas, label?: string): ImageTexture
  /**
   * Uploads raw RGBA8 pixels, row-major from the top-left, 4 bytes per pixel, straight
   * (non-premultiplied) alpha - which is what getImageData already holds, and what the image
   * lane's blend expects.
   */
  fromPixels(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, label?: string): ImageTexture
  /**
   * Rasterizes an SVG document at a chosen size and uploads the result. What this produces is
   * pixels, fixed at that resolution - for something that must stay sharp at any zoom, load
   * the document as vectors instead (loadSvgDocument) and let it be geometry.
   */
  fromSvg(svgText: string, options?: SvgRasterOptions): Promise<ImageTexture>
}

/** What an SVG rasterization may be told, beyond its size. */
export interface SvgRasterOptions extends SvgSizeOptions {
  label?: string
}

export const SVG_TYPE = 'image/svg+xml'

/** True when a response or url is an SVG document rather than a raster image. */
export function isSvgSource(url: string, contentType: string): boolean {
  return contentType.includes(SVG_TYPE) || /\.svgz?(?:[?#]|$)/i.test(url)
}

/**
 * The pixel size an SVG document will be rasterized at, and the document resized to match.
 * Split out so each render path can check the size against its own device limit before
 * spending anything on the raster.
 */
export { resolveSvgPixelSize, resizeSvgDocument } from './svgSize'

/**
 * Draws an SVG document with the browser's decoder and returns its pixels, RGBA8.
 *
 * The document arrives as a blob URL rather than a data URL: it avoids base64-encoding the
 * whole file, and being same-origin it does not taint the canvas it is drawn onto. decode()
 * is what reports a malformed document - an <img> that fails to parse otherwise just stays
 * blank, with no error anywhere.
 *
 * It goes through a canvas and comes back as pixels rather than being handed to the GPU as
 * an external image, so the upload is a plain raw-pixel write, which every implementation
 * supports. That costs one copy of the image through system memory, once, at load.
 *
 * The width and height are passed to drawImage even though the document has already been
 * resized to match: whether an <img> rasterizes an SVG at its intrinsic size or at the size
 * it is drawn varies, and giving both the same number means the answer does not matter.
 *
 * The browser rasterizes an <img>-loaded SVG in its restricted mode: no scripts, no
 * animation, and no external references - webfonts, external stylesheets and linked images
 * are not fetched, so text falls back to whatever font is already available. Everything the
 * document needs has to be inline.
 */
export async function rasterizeSvgPixels(
  svgText: string,
  width: number,
  height: number,
): Promise<Uint8ClampedArray> {
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

/** Shared guard: an SVG whose chosen size exceeds what the device can hold. */
export function assertSvgFits(width: number, height: number, limit: number | undefined): void {
  if (limit !== undefined && (width > limit || height > limit)) {
    throw new Error(
      `svg raster: ${width}x${height} exceeds this device's maximum texture size of ${limit} - lower scale or the requested size`,
    )
  }
}
