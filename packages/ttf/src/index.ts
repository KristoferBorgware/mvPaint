// Public entry point for @mvpaint/ttf: vector glyphs from a font file, at runtime.
//
// The engine draws vector text from a polygon atlas generated offline, and needs no font
// parser to do it. This package is the opt-in alternative for the case an atlas cannot cover -
// a font the application has not seen until the user hands it over - and satisfies the same
// VectorFonts interface, so nothing downstream of the shaper knows the difference.

export * from './TtfFont'
export * from './glyphOutline'
