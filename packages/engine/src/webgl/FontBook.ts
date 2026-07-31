// The four Inter MSDF atlases as one WebGL2 array texture - the fallback's FontBook.
//
// Same arrangement as the WebGPU one (webgpu/FontBook.ts) and for the same reason: all four
// styles live as layers of a single TEXTURE_2D_ARRAY, a run picks its layer from its object
// record, and a paragraph mixing regular, bold and italic therefore draws in ONE call instead
// of one per style. That win is worth as much here as there - more, if anything, since a
// program switch on this path costs more than a pipeline switch does on the other.
//
// The metrics half is not duplicated at all: it comes from text/msdfProvider.ts, which needs
// no device and is the same object the WebGPU path resolves through.

import { normalizeMetrics, type FontMetrics } from '../text/msdfMetrics'
import { ATLAS_LAYER_SIZE, resolveStyle, STYLE_ORDER, type FontStyle } from '../text/msdfProvider'
import { MSDF_ATLAS_SOURCES } from '../text/msdfAtlasImages'
import type { FontProvider, ResolvedStyle } from '../text/layout'

export class GlFontBook implements FontProvider {
  /** Layers of the array texture, i.e. how many styles are loaded. */
  readonly layerCount = MSDF_ATLAS_SOURCES.length

  private readonly gl: WebGL2RenderingContext
  private texture: WebGLTexture | null
  private readonly metrics: FontMetrics[] // indexed by STYLE_ORDER, i.e. by array layer

  private constructor(gl: WebGL2RenderingContext, texture: WebGLTexture, metrics: FontMetrics[]) {
    this.gl = gl
    this.texture = texture
    this.metrics = metrics
  }

  /** Fetch all four PNGs and upload one per layer. */
  static async load(gl: WebGL2RenderingContext): Promise<GlFontBook> {
    const texture = gl.createTexture()
    if (!texture) throw new Error('GlFontBook: could not create the atlas texture')
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture)
    gl.texStorage3D(
      gl.TEXTURE_2D_ARRAY,
      1,
      gl.RGBA8,
      ATLAS_LAYER_SIZE.width,
      ATLAS_LAYER_SIZE.height,
      MSDF_ATLAS_SOURCES.length,
    )
    // Every layer starts zeroed, and a layer's untouched remainder stays that way - which the
    // shader reads as "fully outside the glyph", the same answer the distance field's outer
    // plateau gives. Layers must be identically sized, so each style's tightly-packed image is
    // written into the top-left of a layer sized for the largest; uvs are measured against the
    // LAYER, not the image (see text/msdfMetrics.ts), so nothing downstream has to know.
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    await Promise.all(
      MSDF_ATLAS_SOURCES.map(async (source, layer) => {
        const response = await fetch(source.url)
        if (!response.ok) throw new Error(`GlFontBook: ${source.url} responded ${response.status}`)
        // colorSpaceConversion 'none': MSDF channels are distances, not sRGB colour, so any
        // conversion the browser might helpfully apply would corrupt them.
        const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none' })
        try {
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture)
          // flipY off: with it off the image's first row lands at v = 0, which is where the
          // generator's uvs put it - the same convention the WebGPU path gets by default.
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
          gl.texSubImage3D(
            gl.TEXTURE_2D_ARRAY,
            0,
            0,
            0,
            layer,
            bitmap.width,
            bitmap.height,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            bitmap,
          )
        } finally {
          bitmap.close()
        }
      }),
    )
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null)

    const metrics = MSDF_ATLAS_SOURCES.map((s) => normalizeMetrics(s.json, ATLAS_LAYER_SIZE))
    return new GlFontBook(gl, texture, metrics)
  }

  /** Stable atlas index for a style - its array layer in the shared texture. */
  indexOf(style: FontStyle): number {
    return STYLE_ORDER.indexOf(style)
  }

  /**
   * Resolve a requested style to a loaded atlas, synthesizing what is missing - the same
   * fallback ladder the WebGPU book walks, so faux bold and faux italic behave identically on
   * either path.
   */
  resolve(style: FontStyle): ResolvedStyle {
    const r = resolveStyle(style, (i) => this.metrics[i])
    return { metrics: r.value, atlasIndex: r.atlasIndex, fauxBold: r.fauxBold, fauxItalic: r.fauxItalic }
  }

  bind(unit: number): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture)
  }

  destroy(): void {
    if (this.texture) this.gl.deleteTexture(this.texture)
    this.texture = null
  }
}
