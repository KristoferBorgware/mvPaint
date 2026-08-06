// The characters an atlas covers.
//
// Printable ASCII, U+0020..U+007E. Both generators take the set from here rather than each
// declaring its own: a scene that switches a node between the MSDF and the vector path draws
// the same characters either way, and a character missing from one is missing from both.
//
// It is also what decides how a face is assembled. A face spread over several files - a
// `latin` subset beside a `latin-ext` one - hands each code point to the first of its files
// that has a glyph for it, so widening this set is what makes a subset file contribute (see
// readFontFaces in fontSources.ts).
//
// Widening it means regenerating both kinds of atlas, and, if the glyphs stop fitting one
// page, raising TEXTURE_SIZE in the MSDF generator.

/** The code points every face is measured and packed against. */
export const CHARSET: readonly number[] = Array.from({ length: 0x7e - 0x20 + 1 }, (_, index) => 0x20 + index)

/** The same set as the string msdf-bmfont-xml's `charset` and TtfFont.ensure() take. */
export function charsetText(charset: readonly number[]): string {
  return String.fromCodePoint(...charset)
}
