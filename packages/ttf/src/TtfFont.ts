/// <reference path="./opentype-js.d.ts" />
// (opentype.js ships no types of its own; the reference above travels with this
// module so every consumer picks the declarations up without tsconfig changes.)

// TtfFont / TtfFontBook - vector glyphs from a font FILE, at runtime: parse a TTF/OTF with
// opentype.js and turn each glyph's contours into polygon meshes, which then go through the
// engine's mesh lane exactly as a Path does.
//
// This is the opt-in half of the vector text path, and it lives outside the engine on purpose.
// The engine draws vector text from a polygon atlas (see the engine's text/PolygonFont.ts):
// outlines flattened once, offline, and shipped as data. That covers every application whose
// fonts are known when it is built - which is nearly all of them - and it keeps a quarter of a
// megabyte of font parser out of every bundle.
//
// What it does not cover is a font the application has never seen: a file the user just
// dropped in, a font picker over a directory, a document that names its own typeface. That
// needs a real parser, and this package is it. It satisfies the engine's VectorFonts
// interface, so a VectorText cannot tell the difference:
//
//   const fonts = await TtfFontBook.load([{ style: 'regular', data: await file.arrayBuffer() }])
//   scene.root.addChild(new VectorText({ fonts, runs: [{ text: 'Hello' }] }))
//
// Metrics are exposed as the same FontMetrics the MSDF path uses, in FONT UNITS (so `size` is
// the font's unitsPerEm and the shaper's `renderSize / size` scale falls out unchanged). They
// are filled in ON DEMAND - ensure() measures exactly the code points and kerning pairs a piece
// of text needs, rather than walking a font's few thousand glyphs up front for the handful a
// label uses. That is the one place this differs from an atlas, which arrives measured.

// opentype.js is reached ONLY through the dynamic import inside parse() below; everything else
// here refers to it with `import type`, which erases. So even an application that installs this
// package downloads the parser at the moment it first parses a font, not on load.
import type { Font as OpenTypeFont, Glyph as OpenTypeGlyph } from 'opentype.js/dist/opentype.mjs'

// Imported by module path rather than from '@mvpaint/engine'. The engine's public entry point
// pulls in `?url` imports for the atlas PNGs, which only a bundler can resolve - so importing
// it here would make this package, and its self-test, unrunnable under node. The modules named
// below are pure: geometry, metrics and the style ladder, no assets and no device.
import type { FontMetrics, Glyph } from '@mvpaint/engine/src/text/msdfMetrics'
import { resolveStyle, STYLE_ORDER, type FontStyle } from '@mvpaint/engine/src/text/msdfProvider'
import type { ResolvedStyle } from '@mvpaint/engine/src/text/layout'
import {
  meshFromContours,
  type VectorFonts,
  type VectorGlyphFont,
  type VectorGlyphMesh,
} from '@mvpaint/engine/src/text/vectorGlyphs'
import { DEFAULT_CURVE_TOLERANCE_EM, glyphContours } from './glyphOutline'

export interface TtfFontOptions {
  /** Curve flatness as a fraction of the em square; see DEFAULT_CURVE_TOLERANCE_EM. */
  curveToleranceEm?: number
}

// Kerning pairs are keyed the same way the engine's metrics key them, so the shaper's lookup
// is identical whichever font kind it is walking.
function kerningKey(first: number, second: number): number {
  return first * 0x110000 + second
}

export class TtfFont implements VectorGlyphFont {
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

  private constructor(font: OpenTypeFont, options: TtfFontOptions) {
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
   * self-test parses real fonts under node and an application parses them in a browser. The
   * dependency is pinned to an exact version for the same reason.
   */
  static async parse(data: ArrayBuffer, options: TtfFontOptions = {}): Promise<TtfFont> {
    const { parse } = await import('opentype.js/dist/opentype.mjs')
    return new TtfFont(parse(data), options)
  }

  /**
   * Measure everything `text` needs into `metrics`: one entry per distinct code point, plus
   * the kerning for each adjacent pair. Called before shaping - the shaper reads the maps
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

    // The same rings-to-triangles step the atlas path uses, so a glyph parsed here and the
    // same glyph read from a polygon atlas become identical geometry.
    const built = meshFromContours(glyphContours(glyph, this.unitsPerEm, this.tolerance))
    this.meshes.set(codePoint, built)
    return built
  }

  /** The glyph's flattened outline in y-up font units, or undefined if it has none. */
  contours(codePoint: number): VectorGlyphMesh['contours'] | undefined {
    const glyph = this.glyphFor(String.fromCodePoint(codePoint))
    return glyph ? glyphContours(glyph, this.unitsPerEm, this.tolerance) : undefined
  }

  /** Whether this font has a real glyph for a code point - what an atlas generator asks. */
  hasGlyph(codePoint: number): boolean {
    return this.glyphFor(String.fromCodePoint(codePoint)) !== undefined
  }

  /** The kerning between two code points, in font units, measuring it if it is not yet known. */
  kerning(first: number, second: number): number {
    this.measureKerning(first, second)
    return this.metrics.kernings.get(kerningKey(first, second)) ?? 0
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

/** One style's font data, as handed to TtfFontBook.load. */
export interface TtfFontSource {
  style: FontStyle
  data: ArrayBuffer
}

/**
 * A set of parsed styles - what a VectorText draws from, and the runtime counterpart of the
 * engine's PolygonFontBook. It owns no GPU resources, so nothing here has to be created before
 * a device exists or destroyed with one.
 */
export class TtfFontBook implements VectorFonts {
  private readonly fonts: (TtfFont | undefined)[] // indexed by STYLE_ORDER

  private constructor(fonts: (TtfFont | undefined)[]) {
    this.fonts = fonts
  }

  /** Parse a set of styles. Missing ones are synthesized from what's present (see resolve). */
  static async load(sources: readonly TtfFontSource[], options: TtfFontOptions = {}): Promise<TtfFontBook> {
    const fonts: (TtfFont | undefined)[] = STYLE_ORDER.map(() => undefined)
    const known = sources.filter((source) => STYLE_ORDER.includes(source.style))
    const parsed = await Promise.all(known.map((source) => TtfFont.parse(source.data, options)))
    known.forEach((source, i) => {
      fonts[STYLE_ORDER.indexOf(source.style)] = parsed[i]
    })
    if (!fonts.some((font) => font)) throw new Error('TtfFontBook: no usable font in sources')
    return new TtfFontBook(fonts)
  }

  /** Stable index for a style - the `atlasIndex` a shaped quad carries. */
  indexOf(style: FontStyle): number {
    return STYLE_ORDER.indexOf(style)
  }

  /**
   * Resolve a requested style to a parsed font, flagging whatever has to be synthesized - the
   * same fallback ladder every other font book walks, so faux bold/italic behave identically
   * whichever path is drawing.
   */
  resolve(style: FontStyle): ResolvedStyle {
    const found = resolveStyle(style, (index) => this.fonts[index])
    // resolveStyle's last resort is index 0 ('regular'), which a book loaded with one other
    // style does not have. load() guarantees at least one, so fall back to whichever it is.
    const index = found.value ? found.atlasIndex : this.fonts.findIndex((font) => font)
    return {
      metrics: (found.value ?? this.fonts[index]!).metrics,
      atlasIndex: index,
      fauxBold: found.fauxBold,
      fauxItalic: found.fauxItalic,
    }
  }

  /** The font behind a resolved style's index - where a shaped quad's outline comes from. */
  fontByIndex(index: number): TtfFont | undefined {
    return this.fonts[index]
  }

  /** Measure `text` into the font a style resolves to, before shaping it. */
  prepare(style: FontStyle, text: string): void {
    this.fontByIndex(this.resolve(style).atlasIndex)?.ensure(text)
  }
}
