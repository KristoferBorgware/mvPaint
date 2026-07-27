/// <reference path="./opentype-js.d.ts" />
// (opentype.js ships no types of its own; the reference above travels with this
// module so every consumer picks the declarations up without tsconfig changes.)

// VectorFont / VectorFontBook - the second way this engine renders text: parse a TTF at
// runtime with opentype.js and turn each glyph's contours into real polygon meshes, which
// then go through the ordinary mesh lane exactly as a Path does. The MSDF path
// (FontAtlas.ts) is untouched and still the default; the two are alternatives, not layers.
//
// What differs from MSDF, concretely:
//   - No atlas, no texture, no generation step - the .ttf is the only asset, so any font
//     works without being processed first, and the character set isn't fixed in advance.
//   - Geometry is resolution-independent by construction rather than by a distance field,
//     so there is no atlas size / field range to trade against zoom.
//   - Text becomes ordinary mesh geometry, which means it picks per-glyph (not per-bounding
//     box) and casts a real blurred shadow through the shared shadow atlas, both for free.
//   - It costs triangles instead of texels: a glyph is a few hundred vertices rather than
//     four, so a page of small text is far heavier here than in the atlas.
//
// This module is deliberately free of asset imports and DOM APIs, so it parses fonts under
// node in the self-tests as readily as in the browser; vectorFonts.ts is the thin browser
// loader that fetches the bundled Inter TTFs and hands their buffers here.
//
// Metrics are exposed as the same FontMetrics the MSDF path uses, in FONT UNITS (so
// `size` is the font's unitsPerEm and the shaper's `renderSize / size` scale falls out
// unchanged). They are filled in ON DEMAND - ensure() measures exactly the code points and
// kerning pairs a piece of text needs, rather than walking a font's few thousand glyphs up
// front for the handful a label uses.

// opentype.js is reached ONLY through the dynamic import inside parse() below; everything
// else here refers to it with `import type`, which erases. That keeps the parser - a quarter
// of a megabyte, most of the browser bundle's weight - out of the main chunk, so an app that
// draws only MSDF text never downloads it. It is the same reasoning that keeps the TTFs
// themselves lazy (see vectorFonts.ts).
import type { Font as OpenTypeFont, Glyph as OpenTypeGlyph } from 'opentype.js/dist/opentype.mjs'
import type { Point2 } from '../render/meshFormat'
import type { Contour } from '../render/stroke'
import { classifyContours } from '../svg/contours'
import { triangulateGroup } from '../svg/triangulate'
import type { FontStyle } from './FontAtlas'
import { DEFAULT_CURVE_TOLERANCE_EM, glyphContours } from './glyphOutline'
import type { FontMetrics, Glyph } from './msdfMetrics'
import type { FontProvider, ResolvedStyle } from './layout'

/** A glyph's fillable geometry, in y-up font units - cached once and scaled per draw. */
export interface VectorGlyphMesh {
  /** Closed rings: what the contour stroker outlines, and what the fill was cut from. */
  contours: Contour[]
  /** Fill triangulation: vertices plus triangle indices into them. */
  vertices: Point2[]
  indices: number[]
}

export interface VectorFontOptions {
  /** Curve flatness as a fraction of the em square; see DEFAULT_CURVE_TOLERANCE_EM. */
  curveToleranceEm?: number
}

// Kerning pairs are keyed the same way msdfMetrics keys them, so the shaper's lookup is
// identical whichever font kind it is walking.
function kerningKey(first: number, second: number): number {
  return first * 0x110000 + second
}

export class VectorFont {
  /** Font units per em - the space `metrics` and every cached glyph mesh live in. */
  readonly unitsPerEm: number
  /** Shared with the shaper; its glyph and kerning maps grow as ensure() is called. */
  readonly metrics: FontMetrics

  private readonly font: OpenTypeFont
  private readonly tolerance: number
  private readonly meshes = new Map<number, VectorGlyphMesh>()
  // Code points already looked up, including the ones the font turned out not to have -
  // without this a missing glyph would be re-resolved on every ensure().
  private readonly measured = new Set<number>()
  private readonly kerned = new Set<number>()

  private constructor(font: OpenTypeFont, options: VectorFontOptions) {
    this.font = font
    this.unitsPerEm = font.unitsPerEm
    this.tolerance = (options.curveToleranceEm ?? DEFAULT_CURVE_TOLERANCE_EM) * font.unitsPerEm

    // Kerning lives in GPOS for most modern faces, and opentype only builds its default
    // kerning tables when the positioning engine has been initialized. Without this,
    // getKerningValue silently returns 0 for every pair and text just looks slightly loose.
    font.position.init()

    const hhea = font.tables.hhea
    const ascender = hhea?.ascender ?? font.ascender
    const descender = hhea?.descender ?? font.descender
    const lineGap = hhea?.lineGap ?? 0
    const post = font.tables.post
    const os2 = font.tables.os2
    const em = font.unitsPerEm

    this.metrics = {
      size: em,
      // The shaper measures a line as base (top to baseline) plus (lineHeight - base).
      base: ascender,
      lineHeight: ascender - descender + lineGap,
      // No atlas backs these glyphs; the fields exist because FontMetrics is shared with
      // the MSDF path, and nothing in the vector path reads them.
      atlasWidth: 0,
      atlasHeight: 0,
      distanceRange: 0,
      decoration: {
        // Em fractions with +y up, which is exactly how the font tables store them.
        underlineOffset: (post?.underlinePosition ?? -0.1 * em) / em,
        underlineThickness: (post?.underlineThickness ?? 0.05 * em) / em,
        strikeOffset: (os2?.yStrikeoutPosition ?? 0.25 * em) / em,
        strikeThickness: (os2?.yStrikeoutSize ?? 0.05 * em) / em,
      },
      glyphs: new Map<number, Glyph>(),
      kernings: new Map<number, number>(),
    }
  }

  /**
   * Parse a TTF/OTF buffer. Rejects if the data isn't a font opentype.js understands.
   *
   * Async only because the parser is loaded on demand (see the import note at the top);
   * parsing itself is synchronous once it's there.
   *
   * The ESM build is imported by path, deliberately: opentype.js 2.0.0 ships no `exports`
   * map, so node resolves its CommonJS bundle (which exposes only a default) while a bundler
   * resolves the ESM one (which exposes only named exports), and no single specifier works
   * in both. Naming the ESM file gets the same module everywhere - which matters because the
   * self-tests parse real fonts under node and the app parses them in a browser. The
   * dependency is pinned to an exact version for the same reason.
   */
  static async parse(data: ArrayBuffer, options: VectorFontOptions = {}): Promise<VectorFont> {
    const { parse } = await import('opentype.js/dist/opentype.mjs')
    return new VectorFont(parse(data), options)
  }

  /**
   * Measure everything `text` needs into `metrics`: one entry per distinct code point, plus
   * the kerning for each adjacent pair. Call before shaping - the shaper reads the maps
   * directly and treats a code point that isn't in them as whitespace.
   *
   * Pairs are recorded in both orders because a right-to-left run is laid out from a
   * reversed entry list, so the pair the shaper asks about is the reverse of the one in
   * the source string.
   */
  ensure(text: string): void {
    let previous = -1
    for (const char of text) {
      const cp = char.codePointAt(0) ?? 0
      this.measure(cp, char)
      if (previous >= 0) {
        this.measureKerning(previous, cp)
        this.measureKerning(cp, previous)
      }
      previous = cp
    }
  }

  /**
   * The glyph's fill geometry and contours in font units, built and cached on first use, or
   * undefined for a code point this font has no outline for (including whitespace, whose
   * advance still comes from `metrics`).
   */
  mesh(codePoint: number): VectorGlyphMesh | undefined {
    const cached = this.meshes.get(codePoint)
    if (cached) return cached
    if (!this.metrics.glyphs.has(codePoint)) return undefined

    const glyph = this.glyphFor(String.fromCodePoint(codePoint))
    if (!glyph) return undefined

    const contours = glyphContours(glyph, this.unitsPerEm, this.tolerance)
    const vertices: Point2[] = []
    const indices: number[] = []
    // Rings are grouped into solids-with-holes exactly as an SVG path's are, then earcut
    // triangulates each group; the groups' index spaces are rebased into one flat mesh.
    for (const group of classifyContours(contours)) {
      const triangulated = triangulateGroup(group)
      const base = vertices.length
      for (const v of triangulated.vertices) vertices.push(v)
      for (const i of triangulated.indices) indices.push(base + i)
    }

    const built: VectorGlyphMesh = { contours, vertices, indices }
    this.meshes.set(codePoint, built)
    return built
  }

  private glyphFor(char: string): OpenTypeGlyph | undefined {
    const glyph = this.font.charToGlyph(char)
    // charToGlyph falls back to .notdef rather than reporting a miss. Drawing the tofu box
    // would differ from the MSDF path, which simply has no entry for an unmapped character
    // and spaces it - so treat index 0 as "not in this font" and keep the two consistent.
    return glyph && glyph.index !== 0 ? glyph : undefined
  }

  private measure(codePoint: number, char: string): void {
    if (this.measured.has(codePoint)) return
    this.measured.add(codePoint)

    const glyph = this.glyphFor(char)
    if (!glyph) return

    const box = glyph.getBoundingBox()
    // A blank glyph (space, and anything else with no outline) has no meaningful box;
    // opentype reports an inverted or non-finite one. It still advances the pen.
    const blank = !Number.isFinite(box.x1) || !Number.isFinite(box.y2) || box.x2 <= box.x1 || box.y2 <= box.y1
    this.metrics.glyphs.set(codePoint, {
      // No atlas to sample: the outline is the source of truth for this font kind.
      u0: 0,
      v0: 0,
      u1: 0,
      v1: 0,
      width: blank ? 0 : box.x2 - box.x1,
      height: blank ? 0 : box.y2 - box.y1,
      xoffset: blank ? 0 : box.x1,
      // BMFont's y-down convention, which the shaper expects: how far below the line's top
      // the glyph's own top sits.
      yoffset: blank ? 0 : this.metrics.base - box.y2,
      xadvance: glyph.advanceWidth ?? 0,
    })
  }

  private measureKerning(first: number, second: number): void {
    const key = kerningKey(first, second)
    if (this.kerned.has(key)) return
    this.kerned.add(key)

    const left = this.glyphFor(String.fromCodePoint(first))
    const right = this.glyphFor(String.fromCodePoint(second))
    if (!left || !right) return
    const amount = this.font.getKerningValue(left, right)
    if (amount !== 0) this.metrics.kernings.set(key, amount)
  }
}

/** One style's font data, as handed to VectorFontBook.load. */
export interface VectorFontSource {
  style: FontStyle
  data: ArrayBuffer
}

// Same order the MSDF book uses, so a style's index means the same thing in both.
const STYLE_ORDER: readonly FontStyle[] = ['regular', 'bold', 'italic', 'bold-italic']

/**
 * The four Inter styles as parsed outlines - the vector counterpart of FontBook, and a
 * FontProvider, so the SAME shaper lays out both text kinds. It owns no GPU resources at
 * all, which is the other half of why the two paths can coexist: nothing here has to be
 * created before a device exists or destroyed with one.
 */
export class VectorFontBook implements FontProvider {
  private readonly fonts: (VectorFont | undefined)[] // indexed by STYLE_ORDER

  private constructor(fonts: (VectorFont | undefined)[]) {
    this.fonts = fonts
  }

  /** Parse a set of styles. Missing ones are synthesized from what's present (see resolve). */
  static async load(sources: readonly VectorFontSource[], options: VectorFontOptions = {}): Promise<VectorFontBook> {
    const fonts: (VectorFont | undefined)[] = STYLE_ORDER.map(() => undefined)
    const known = sources.filter((source) => STYLE_ORDER.includes(source.style))
    const parsed = await Promise.all(known.map((source) => VectorFont.parse(source.data, options)))
    known.forEach((source, i) => {
      fonts[STYLE_ORDER.indexOf(source.style)] = parsed[i]
    })
    if (!fonts.some((font) => font)) throw new Error('VectorFontBook: no usable font in sources')
    return new VectorFontBook(fonts)
  }

  /** Stable index for a style - the `atlasIndex` a shaped quad carries. */
  indexOf(style: FontStyle): number {
    return STYLE_ORDER.indexOf(style)
  }

  /**
   * Resolve a requested style to a parsed font, flagging whatever has to be synthesized -
   * the same fallback ladder FontBook.resolve walks, so faux bold/italic behave identically
   * on both paths. With all four Inter styles loaded this always returns the real font.
   */
  resolve(style: FontStyle): ResolvedStyle {
    const wantBold = style.includes('bold')
    const wantItalic = style.includes('italic')
    const candidates: FontStyle[] = [style, wantItalic ? 'italic' : 'regular', wantBold ? 'bold' : 'regular', 'regular']
    for (const candidate of candidates) {
      const index = STYLE_ORDER.indexOf(candidate)
      const font = index >= 0 ? this.fonts[index] : undefined
      if (font) {
        return {
          metrics: font.metrics,
          atlasIndex: index,
          fauxBold: wantBold && !candidate.includes('bold'),
          fauxItalic: wantItalic && !candidate.includes('italic'),
        }
      }
    }
    // load() guarantees at least one style, so the fallback scan below always lands.
    const index = this.fonts.findIndex((font) => font)
    return { metrics: this.fonts[index]!.metrics, atlasIndex: index, fauxBold: wantBold, fauxItalic: wantItalic }
  }

  /** The font behind a resolved style's index - where a shaped quad's outline comes from. */
  fontByIndex(index: number): VectorFont | undefined {
    return this.fonts[index]
  }

  /** Measure `text` into the font a style resolves to, before shaping it. */
  prepare(style: FontStyle, text: string): void {
    this.fontByIndex(this.resolve(style).atlasIndex)?.ensure(text)
  }
}
