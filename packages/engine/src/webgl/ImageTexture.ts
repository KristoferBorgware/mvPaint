// The fallback's image textures.
//
// The image LANE has not landed yet, but the textures have to exist before it does: an Image
// node is constructed with one, and its width and height are what the node's default size, its
// UVs, its bounds and its hit test are all derived from (see image/imageUv.ts). A scene that
// could not build a texture on this path could not be built at all - it would throw in
// populate() rather than merely drawing one lane short.
//
// So this uploads properly and reports its size properly, and the lane will bind it when it
// arrives. Sampler state is set per texture rather than cached per combination the way the
// WebGPU path does it, because WebGL has no sampler objects in a bind group to cache - wrap
// and filter are texture parameters, and one texture is drawn one way.

import {
  assertSvgFits,
  isSvgSource,
  rasterizeSvgPixels,
  resizeSvgDocument,
  resolveSvgPixelSize,
  type ImageFilter,
  type ImageSampling,
  type ImageTexture,
  type ImageTextureFactory,
  type ImageWrap,
  type SvgRasterOptions,
} from '../image/ImageTexture'

// Read off the context rather than the global constructor, so importing this module is safe
// wherever there is no WebGL2RenderingContext to reach for.
const wrapMode = (gl: WebGL2RenderingContext, wrap: ImageWrap): number =>
  wrap === 'repeat' ? gl.REPEAT : wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE
const filterMode = (gl: WebGL2RenderingContext, filter: ImageFilter): number =>
  filter === 'nearest' ? gl.NEAREST : gl.LINEAR

export class GlImageTexture implements ImageTexture {
  readonly width: number
  readonly height: number

  private readonly gl: WebGL2RenderingContext
  private texture: WebGLTexture | null
  private applied: string | null = null

  private constructor(gl: WebGL2RenderingContext, texture: WebGLTexture, width: number, height: number) {
    this.gl = gl
    this.texture = texture
    this.width = width
    this.height = height
  }

  static fromSource(
    gl: WebGL2RenderingContext,
    source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas,
  ): GlImageTexture {
    return GlImageTexture.upload(gl, source.width, source.height, (target) => {
      // flipY stays OFF: with it off, the source's first row lands at v = 0, which is exactly
      // where the WebGPU path puts it too - so one set of UVs serves both.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.texSubImage2D(target, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource)
    })
  }

  static fromPixels(
    gl: WebGL2RenderingContext,
    pixels: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
  ): GlImageTexture {
    if (width <= 0 || height <= 0) throw new Error(`GlImageTexture.fromPixels: ${width}x${height} has no area`)
    const needed = width * height * 4
    if (pixels.length < needed) {
      throw new Error(`GlImageTexture.fromPixels: ${pixels.length} bytes for ${width}x${height} RGBA, need ${needed}`)
    }
    const data = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length)
    return GlImageTexture.upload(gl, width, height, (target) => {
      // No 256-byte row padding here, unlike the WebGPU path: WebGL takes tightly packed rows
      // once UNPACK_ALIGNMENT allows it, and RGBA8 rows are 4-byte aligned by construction.
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.texSubImage2D(target, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data)
    })
  }

  /** Binds to a texture unit, applying the sampler state if it has changed. */
  bind(unit: number, sampling: ImageSampling): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    const key = `${sampling.wrapX}|${sampling.wrapY}|${sampling.filter}`
    if (this.applied === key) return
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapMode(gl, sampling.wrapX))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapMode(gl, sampling.wrapY))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterMode(gl, sampling.filter))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode(gl, sampling.filter))
    this.applied = key
  }

  destroy(): void {
    if (this.texture) this.gl.deleteTexture(this.texture)
    this.texture = null
  }

  private static upload(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    write: (target: number) => void,
  ): GlImageTexture {
    const texture = gl.createTexture()
    if (!texture) throw new Error('GlImageTexture: could not create a texture')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    // Immutable storage, then a sub-image write. It is WebGL2's way of declaring the texture's
    // shape up front, and it is what makes NPOT repeat/mirror legal without mipmaps - which
    // the WebGPU path gets for nothing and an image lane very much needs.
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height)
    write(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)
    return new GlImageTexture(gl, texture, width, height)
  }
}

/** The factory a WebGL2 renderer hands its scenes (`handle.images`). */
export function glImageFactory(gl: WebGL2RenderingContext, maxTextureSize: number): ImageTextureFactory {
  return {
    async load(url: string) {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`images.load: ${url} responded ${response.status}`)
      const contentType = response.headers.get('content-type') ?? ''
      if (isSvgSource(url, contentType)) return this.fromSvg(await response.text(), { label: url })
      const bitmap = await createImageBitmap(await response.blob())
      try {
        return GlImageTexture.fromSource(gl, bitmap)
      } finally {
        bitmap.close()
      }
    },
    fromSource: (source) => GlImageTexture.fromSource(gl, source),
    fromPixels: (pixels, width, height) => GlImageTexture.fromPixels(gl, pixels, width, height),
    async fromSvg(svgText: string, options: SvgRasterOptions = {}) {
      const { width, height } = resolveSvgPixelSize(svgText, options)
      assertSvgFits(width, height, maxTextureSize)
      const pixels = await rasterizeSvgPixels(resizeSvgDocument(svgText, width, height), width, height)
      return GlImageTexture.fromPixels(gl, pixels, width, height)
    },
  }
}
