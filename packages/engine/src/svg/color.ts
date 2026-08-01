// SVG paint, which is a colour plus one thing a colour cannot express: `none`, meaning the
// shape is not painted at all. That distinction is the only reason this exists separately from
// render/color.ts, which does the actual reading.
//
// The other difference is what happens to something unreadable. A colour written by hand in
// application code should throw - a mistyped colour that renders black looks like a design
// decision rather than a typo. A colour arriving in a document did not come from the person
// running the code, and one bad attribute should not stop a drawing from loading, so this
// returns null and lets the caller fall back.

import { parseColor as parseCssColor } from '../render/color'
import type { RGBA } from '../render/meshFormat'

/**
 * A colour from an SVG paint attribute.
 *
 * Null for `none` (the shape takes no paint here) and for anything unreadable; 'transparent'
 * is a real colour with alpha 0, which is a different thing - it paints, invisibly, and still
 * counts as a fill for the purposes of everything downstream.
 */
export function parseColor(input: string | null | undefined): RGBA | null {
  if (!input) return null
  const text = input.trim().toLowerCase()
  if (text === 'none') return null
  try {
    return parseCssColor(text)
  } catch {
    return null
  }
}
