// Ambient typings for opentype.js, which ships none of its own (v2.0.0).
//
// Deliberately narrow: only the parsing entry point and the handful of members the vector
// text path actually reads. A `declare module 'opentype.js'` with no body would make the
// whole library `any` and silently swallow a rename or a signature change on upgrade;
// spelling out the subset means a break shows up as a type error instead of at runtime.

declare module 'opentype.js/dist/opentype.mjs' {
  /**
   * One outline segment, in the coordinate space `Glyph.getPath` was asked for. Fonts
   * store y upward, but paths come out in SVG's y-down convention - see text/glyphOutline.ts.
   */
  export interface PathCommand {
    type: 'M' | 'L' | 'C' | 'Q' | 'Z'
    x?: number
    y?: number
    x1?: number
    y1?: number
    x2?: number
    y2?: number
  }

  export interface Path {
    commands: PathCommand[]
  }

  export interface BoundingBox {
    x1: number
    y1: number
    x2: number
    y2: number
  }

  export interface Glyph {
    /** Index into the font's glyph table; what kerning lookups are keyed by. */
    index: number
    /** Advance in font units, or undefined for a glyph the font gives no advance. */
    advanceWidth?: number
    unicode?: number
    /**
     * The outline at `fontSize` units per em, placed at (x, y). Passing the font's own
     * unitsPerEm therefore yields raw font units.
     */
    getPath(x: number, y: number, fontSize: number): Path
    /** Outline extents in font units (an empty box for a blank glyph such as space). */
    getBoundingBox(): BoundingBox
  }

  /** GPOS state; `init()` is what populates the default kerning tables (see VectorFont). */
  export interface Position {
    init(): void
  }

  export interface Font {
    unitsPerEm: number
    ascender: number
    descender: number
    numGlyphs: number
    position: Position
    tables: {
      hhea?: { ascender: number; descender: number; lineGap: number }
      os2?: { yStrikeoutPosition?: number; yStrikeoutSize?: number }
      post?: { underlinePosition?: number; underlineThickness?: number }
    }
    /** Falls back to .notdef (index 0) for a code point the font has no glyph for. */
    charToGlyph(char: string): Glyph
    /** Kerning between two glyphs in font units; 0 when the pair has no entry. */
    getKerningValue(left: Glyph, right: Glyph): number
  }

  /**
   * Parses a TTF/OTF/WOFF buffer. Throws on data it doesn't recognise.
   *
   * Declared as a named export only. The library's CommonJS build also has a default, but
   * its ESM one - the build a bundler resolves to - does not, so importing the default
   * would work under node and break in the browser.
   */
  export function parse(buffer: ArrayBuffer): Font
}
