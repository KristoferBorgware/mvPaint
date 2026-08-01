// Colours shared across the example scenes, so they read as one set of demos rather than
// each inventing its own palette.
//
// Written as strings, like nearly everything else in these scenes. A colour property takes
// either form - the [r, g, b, a] tuple in 0..1 or a string - and the string is the one worth
// reading: '#cc1f47' says what it is at a glance where four floats do not.

/** The engine converts these on assignment; nothing here has to be a tuple. */
export const NAVY = '#172147'
export const SLATE = '#454f66'
export const DARK = '#1a1a1f'
export const TEAL = '#007a80'
export const CRIMSON = '#cc1f47'
export const YELLOW = '#ffdb3d'
export const HIGHLIGHT = '#ffeb66'

/**
 * The same colour at a different alpha, for the handful of places that want one.
 *
 * A palette entry is a solid colour and stays one; this builds the translucent variant at the
 * call site rather than the palette carrying a second entry for every opacity anyone needs. It
 * only understands the six-digit hex the entries above are written in, which is all it is ever
 * given.
 */
export function withAlpha(hex: string, alpha: number): string {
  const byte = Math.max(0, Math.min(255, Math.round(alpha * 255)))
  return `${hex}${byte.toString(16).padStart(2, '0')}`
}
