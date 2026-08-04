// The polygon atlas: glyph outlines as data, and the runtime that draws from them.
//
// This is the vector text path's asset, and the exact counterpart of the MSDF PNG - one file
// per style, generated offline (packages/scripts/text/polygon). What it holds is what a font
// parser would have produced and nothing else: each glyph's outline already flattened to line
// segments in font units, its box and advance, the kerning pairs, and the four decoration
// metrics.
//
// The reader is here; the data is NOT. The engine ships one asset, the MSDF atlas, and outlines
// are the application's to supply and to fetch when it wants them - see @mvpaint/assets for
// this repository's, which is the shape an application's own asset module takes.
//
// WHY IT IS A FILE RATHER THAN A PARSE. Flattening 'A' of Inter Regular is a fixed computation
// with a fixed answer, and it was being done in every browser, on every load, behind a quarter
// of a megabyte of TTF parser that had to be downloaded first. Doing it once, offline, removes
// the parser from the engine entirely and makes the assets smaller than the fonts they replace
// - an atlas is one style's outlines at the charset the application draws, where a TTF carries
// every glyph, every table and the curves themselves.
//
// WHAT IT COSTS. The charset is fixed at generation time, exactly as the MSDF atlas's is: a
// code point outside it has no outline here and the shaper spaces it. An application that must
// draw arbitrary text in an arbitrary font - a user-supplied file, a font picker - wants
// @mvpaint/ttf instead, which parses at runtime and satisfies the same VectorFonts interface.
//
// FLOAT-FREE ON PURPOSE. Coordinates are whole font units. At Inter's 2048 units per em that
// is a rounding error of 1/2048 em - three hundredths of a pixel at 64px text, well under the
// curve tolerance the outline was flattened at - and it makes the file a fraction of the size
// of the same numbers written as floats.

import type { Vector2Like } from '../math/Vector2'
import type { Contour } from '../render/stroke'
import type { BmDecoration, FontMetrics, Glyph } from './msdfMetrics'
import { resolveStyle, STYLE_ORDER, type FontStyle } from './msdfProvider'
import type { ResolvedStyle } from './layout'
import { meshFromContours, EMPTY_GLYPH_MESH, type VectorFonts, type VectorGlyphFont, type VectorGlyphMesh } from './vectorGlyphs'

/** The current file format's tag. A mismatch is a loud error, not a silent misread. */
export const POLYGON_ATLAS_FORMAT = 'mvpaint-polygons@1'

/** One glyph in the atlas. Box fields are absent for a blank glyph, which still advances. */
export interface PolygonGlyphJson {
  codePoint: number
  /** Pen advance, font units. */
  advance: number
  /** Outline box: left edge and width/height in font units... */
  x?: number
  width?: number
  height?: number
  /** ...and the top edge measured DOWNWARD from the line's top, as BMFont stores it. */
  y?: number
  /** Closed rings, each a flat [x0, y0, x1, y1, ...] in y-up font units. */
  rings?: number[][]
}

/** One style's atlas document, as written by the offline generator. */
export interface PolygonFontJson {
  format: string
  face: string
  /** The unit system every number below is in. */
  unitsPerEm: number
  /** Ascender: the shaper measures a line as base plus (lineHeight - base). */
  base: number
  lineHeight: number
  /** What the outlines were flattened at, as a fraction of the em - for the record. */
  curveToleranceEm: number
  decoration: BmDecoration
  glyphs: PolygonGlyphJson[]
  /** [first, second, amount] triples; only non-zero pairs are stored. */
  kernings: [number, number, number][]
}

/** Keyed exactly as msdfMetrics keys them, so the shaper's lookup is identical either way. */
function kerningKey(first: number, second: number): number {
  return first * 0x110000 + second
}

/**
 * One style, read from an atlas document.
 *
 * Metrics are built up front - they are already measured, so there is nothing to defer and the
 * shaper can run the instant the file lands. Outlines are NOT: a ring is a few hundred points,
 * and turning them into objects and triangles is worth doing only for the glyphs a page
 * actually draws. mesh() does it on first use and caches.
 */
export class PolygonFont implements VectorGlyphFont {
  readonly unitsPerEm: number
  readonly metrics: FontMetrics

  private readonly rings = new Map<number, number[][]>()
  private readonly meshes = new Map<number, VectorGlyphMesh>()

  constructor(json: PolygonFontJson) {
    if (json.format !== POLYGON_ATLAS_FORMAT) {
      throw new Error(`PolygonFont: unsupported atlas format ${JSON.stringify(json.format)}`)
    }
    this.unitsPerEm = json.unitsPerEm

    const glyphs = new Map<number, Glyph>()
    for (const glyph of json.glyphs) {
      glyphs.set(glyph.codePoint, {
        // No atlas to sample: the outline is the source of truth for this font kind. The
        // fields exist because FontMetrics is shared with the MSDF path.
        u0: 0,
        v0: 0,
        u1: 0,
        v1: 0,
        width: glyph.width ?? 0,
        height: glyph.height ?? 0,
        xoffset: glyph.x ?? 0,
        yoffset: glyph.y ?? 0,
        xadvance: glyph.advance,
      })
      if (glyph.rings) this.rings.set(glyph.codePoint, glyph.rings)
    }

    const kernings = new Map<number, number>()
    for (const [first, second, amount] of json.kernings) {
      kernings.set(kerningKey(first, second), amount)
    }

    this.metrics = {
      size: json.unitsPerEm,
      base: json.base,
      lineHeight: json.lineHeight,
      atlasWidth: 0,
      atlasHeight: 0,
      distanceRange: 0,
      decoration: json.decoration,
      glyphs,
      kernings,
    }
  }

  /** Nothing to do: an atlas arrives measured. Present so both font kinds are interchangeable. */
  ensure(_text: string): void {}

  mesh(codePoint: number): VectorGlyphMesh | undefined {
    const cached = this.meshes.get(codePoint)
    if (cached) return cached
    if (!this.metrics.glyphs.has(codePoint)) return undefined

    const rings = this.rings.get(codePoint)
    // A measured glyph with no rings is whitespace: a real glyph with no geometry, which is
    // NOT the same as a miss - a miss would make the shaper substitute a space's advance for
    // this character's own.
    const built = rings ? meshFromContours(rings.map(toContour)) : EMPTY_GLYPH_MESH
    this.meshes.set(codePoint, built)
    return built
  }
}

/** A flat [x, y, x, y, ...] ring as the closed Contour the stroker and earcut speak. */
function toContour(flat: readonly number[]): Contour {
  const points: Vector2Like[] = []
  for (let i = 0; i + 1 < flat.length; i += 2) points.push({ x: flat[i], y: flat[i + 1] })
  return { points, closed: true }
}

/** One style's document, as handed to PolygonFontBook. */
export interface PolygonFontSource {
  style: FontStyle
  json: PolygonFontJson
}

/**
 * The four styles as outlines - the vector counterpart of FontBook, and a FontProvider, so the
 * SAME shaper lays out both text kinds. It owns no GPU resources at all, which is why the two
 * paths can coexist: nothing here has to be created before a device exists or destroyed with
 * one.
 */
export class PolygonFontBook implements VectorFonts {
  private readonly fonts: (PolygonFont | undefined)[] // indexed by STYLE_ORDER

  constructor(sources: readonly PolygonFontSource[]) {
    const fonts: (PolygonFont | undefined)[] = STYLE_ORDER.map(() => undefined)
    for (const source of sources) {
      const index = STYLE_ORDER.indexOf(source.style)
      if (index >= 0) fonts[index] = new PolygonFont(source.json)
    }
    if (!fonts.some((font) => font)) throw new Error('PolygonFontBook: no usable style in sources')
    this.fonts = fonts
  }

  indexOf(style: FontStyle): number {
    return STYLE_ORDER.indexOf(style)
  }

  /**
   * Resolve a requested style to a loaded font, flagging whatever has to be synthesized - the
   * same fallback ladder FontBook and the MSDF provider walk, so faux bold/italic behave
   * identically on every path.
   */
  resolve(style: FontStyle): ResolvedStyle {
    const found = resolveStyle(style, (index) => this.fonts[index])
    // resolveStyle's last resort is index 0 ('regular'), which is always present in the MSDF
    // set but need not be here - a book may be loaded with one style. The constructor
    // guarantees at least one, so fall back to whichever that is.
    const index = found.value ? found.atlasIndex : this.fonts.findIndex((font) => font)
    return {
      metrics: (found.value ?? this.fonts[index]!).metrics,
      atlasIndex: index,
      fauxBold: found.fauxBold,
      fauxItalic: found.fauxItalic,
    }
  }

  fontByIndex(index: number): PolygonFont | undefined {
    return this.fonts[index]
  }

  /** Everything is measured already; here so an atlas book and a parsing one are the same shape. */
  prepare(_style: FontStyle, _text: string): void {}
}
