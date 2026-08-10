// The MSDF atlases as one WebGL2 array texture - the fallback path's MSDFFontBook.
//
// Same arrangement as the WebGPU one (webgpu/MSDFFontBook.ts) and for the same reason: all four
// styles live as layers of a single TEXTURE_2D_ARRAY, a run picks its layer from its object
// record, and a paragraph mixing regular, bold and italic therefore draws in ONE call instead
// of one per style. That win is worth as much here as there - more, if anything, since a
// program switch on this path costs more than a pipeline switch does on the other.
//
// It takes the application's atlases exactly as the WebGPU book does - bytes from the global
// resource cache, decoded and uploaded here, all of it before a frame runs - treats an absent
// set the same way (no atlases, a 1x1 placeholder texture), and places each style at its
// STYLE_ORDER layer - so which fonts a scene draws with does not depend on which render path
// it got.
//
// The metrics half is not duplicated at all: it comes from text/msdfProvider.ts, which needs
// no device and is the same object the WebGPU path resolves through.

import { normalizeMetrics, type FontMetrics } from '../text/msdfMetrics'
import { sharedAtlasBytes } from '../resources/fontSources'
import {
  atlasLayerSize,
  atlasMipLevels,
  resolveStyle,
  STYLE_ORDER,
  type FontStyle,
  type MsdfAtlasSource,
} from '../text/msdfProvider'
import { bumpFontEpoch, bumpTextShapingEpoch } from '../shapes/contentEpoch'
import type { FontProvider, ResolvedStyle } from '../text/layout'

export class GlMSDFFontBook implements FontProvider {
  /** Layers of the array texture - one per style the renderer can select, loaded or not. */
  readonly layerCount = STYLE_ORDER.length

  private readonly gl: WebGL2RenderingContext
  private texture: WebGLTexture | null
  private metrics: FontMetrics[] // indexed by STYLE_ORDER, i.e. by array layer
  private atlases: readonly MsdfAtlasSource[]

  private constructor(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    metrics: FontMetrics[],
    atlases: readonly MsdfAtlasSource[],
  ) {
    this.gl = gl
    this.texture = texture
    this.metrics = metrics
    this.atlases = atlases
  }

  /** The atlases currently loaded, in the order they were supplied. */
  get sources(): readonly MsdfAtlasSource[] {
    return this.atlases
  }

  /**
   * Fetch each style's PNG and upload it to its STYLE_ORDER layer.
   *
   * A partial set is allowed, and so is none at all: `sources` omitted or empty gives a book
   * with no atlases, which fetches nothing and draws no text until setMSDFFonts() supplies some.
   * See webgpu/MSDFFontBook.ts - the contract is identical on both paths.
   */
  static async load(gl: WebGL2RenderingContext, sources?: readonly MsdfAtlasSource[]): Promise<GlMSDFFontBook> {
    const atlases = sources ?? []
    const built = await buildGlAtlas(gl, atlases)
    return new GlMSDFFontBook(gl, built.texture, built.metrics, atlases)
  }

  /**
   * Replace the atlases at any point after the renderer exists - the same contract, and the
   * same replace-don't-merge semantics, as the WebGPU book's setMSDFFonts. See webgpu/MSDFFontBook.ts.
   *
   * The swap is atomic: a failed fetch throws and leaves the old texture bound and drawing.
   */
  async setMSDFFonts(sources: readonly MsdfAtlasSource[]): Promise<void> {
    const built = await buildGlAtlas(this.gl, sources)
    if (this.texture) this.gl.deleteTexture(this.texture)
    this.texture = built.texture
    this.metrics = built.metrics
    this.atlases = sources
    bumpFontEpoch()
    bumpTextShapingEpoch()
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

/**
 * One atlas set -> an array texture and the metrics indexed by array layer.
 *
 * Shared by load() and setMSDFFonts(), and nothing is assigned to the book here - the caller swaps
 * the result in once every fetch has succeeded, which is what makes a failed replacement leave
 * the old atlas in place.
 */
async function buildGlAtlas(
  gl: WebGL2RenderingContext,
  atlases: readonly MsdfAtlasSource[],
): Promise<{ texture: WebGLTexture; metrics: FontMetrics[] }> {
  // An empty set means no atlases - see the WebGPU book. texStorage3D runs either way, at the
  // 1x1 atlasLayerSize gives for an empty set, because the text program samples a texture
  // whether or not anything was loaded into it; nothing is fetched and no metrics come back,
  // so every style is unresolvable.
  const layerSize = atlasLayerSize(atlases)

  const texture = gl.createTexture()
  if (!texture) throw new Error('GlMSDFFontBook: could not create the atlas texture')
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture)
  // STYLE_ORDER.length layers whatever was supplied - a style's layer is its STYLE_ORDER
  // index, which is what a shaped quad names, so a partial set leaves gaps rather than
  // renumbering.
  // Mipped for the same reason the WebGPU path is - see atlasMipLevels - and by the same count,
  // so a glyph minified on the fallback path is sampled exactly as it would have been on the
  // other one. Every level below the first is filled by generateMipmap() once the uploads land.
  gl.texStorage3D(
    gl.TEXTURE_2D_ARRAY,
    atlasMipLevels(layerSize),
    gl.RGBA8,
    layerSize.width,
    layerSize.height,
    STYLE_ORDER.length,
  )
  // Every layer starts zeroed, and a layer's untouched remainder stays that way - which the
  // shader reads as "fully outside the glyph", the same answer the distance field's outer
  // plateau gives. Layers must be identically sized, so each style's tightly-packed image is
  // written into the top-left of a layer sized for the largest; uvs are measured against the
  // LAYER, not the image (see text/msdfMetrics.ts), so nothing downstream has to know.
  // Between levels as well as within them, so text crossing a level boundary as the camera zooms
  // does it smoothly rather than snapping.
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  try {
    await Promise.all(
      atlases.map(async (source) => {
        const layer = STYLE_ORDER.indexOf(source.style)
        if (layer < 0) throw new Error(`GlMSDFFontBook: '${source.style}' is not one of ${STYLE_ORDER.join(', ')}.`)
        // The bytes come from the global cache - see webgpu/MSDFFontBook.ts for why the fetch is
        // shared and the decode is not.
        // colorSpaceConversion 'none': MSDF channels are distances, not sRGB colour, so any
        // conversion the browser might helpfully apply would corrupt them.
        const bitmap = await createImageBitmap(await sharedAtlasBytes(source.url), { colorSpaceConversion: 'none' })
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
    // After every layer's level 0 has landed, and never before: one call fills the chain of all
    // four layers from what is in them, so a layer still empty would be mipped as empty.
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture)
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY)
  } catch (cause) {
    // A replacement that fails leaves the book on its old texture, so this one has no owner.
    gl.deleteTexture(texture)
    throw cause
  }
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null)

  // Sparse by STYLE_ORDER index, matching the layers - a style that was not supplied reads
  // back undefined, which is what resolveStyle treats as "not loaded".
  const metrics: FontMetrics[] = []
  for (const source of atlases) metrics[STYLE_ORDER.indexOf(source.style)] = normalizeMetrics(source.json, layerSize)
  return { texture, metrics }
}
