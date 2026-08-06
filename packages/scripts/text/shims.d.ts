// Ambient declarations for the font tools these generators call, none of which ship
// TypeScript types. The generators run under tsx, which does not typecheck; these keep an
// editor and `npm run typecheck` honest without pulling real type packages into an app build.

declare module 'msdf-bmfont-xml'

declare module 'wawoff2' {
  /**
   * WOFF2 bytes in, sfnt (TTF/OTF) bytes out.
   *
   * A .woff2 is a brotli-compressed sfnt whose glyf and loca tables are stored in a
   * re-encoded form, so unpacking one is more than an inflate. This is Google's woff2
   * compiled to WebAssembly, which does both halves.
   */
  export function decompress(data: Uint8Array): Promise<Uint8Array>

  /** The other direction, which only the self-test asks for. */
  export function compress(data: Uint8Array): Promise<Uint8Array>
}

// opentype.js reached by its bare specifier, which under node resolves to the CommonJS build
// and its default export. That is the right one here: these tools only ever run under node.
// @mvpaint/ttf imports 'opentype.js/dist/opentype.mjs' instead, because it also runs in a
// browser - a separate specifier with its own declarations, which travel with that package.
//
// Narrow on purpose: the members below are what identifying a face and measuring its coverage
// needs. A body-less `declare module` would make the library `any` and turn a rename on
// upgrade into a runtime surprise instead of a type error.
declare module 'opentype.js' {
  export interface Font {
    unitsPerEm: number
    /** Glyphs in the file. Two files that cover the charset equally are ranked by this. */
    numGlyphs: number
    tables: {
      /** `macStyle` bit 0 is bold, bit 1 italic - what a font says its style is. */
      head: { macStyle: number }
      /**
       * `fsSelection` bit 0 is italic, bit 5 bold; the same claim in the OS/2 table.
       * `usWeightClass` is 100..900, 400 being regular and 700 bold.
       */
      os2?: { fsSelection?: number; usWeightClass?: number }
    }
    /** 0 for a character the font has no glyph for. */
    charToGlyphIndex(char: string): number
    /** An English `name` table record, or undefined when the font carries none. */
    getEnglishName(name: string): string | undefined
  }

  const opentype: {
    /** Parses TTF/OTF bytes. Throws on data it does not recognise. */
    parse(buffer: ArrayBuffer): Font
  }
  export default opentype
}
