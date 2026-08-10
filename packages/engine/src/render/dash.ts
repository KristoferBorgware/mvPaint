// Cutting a contour into dashes: the path arithmetic, with no ribbon-building in it.
//
// A dashed stroke is not a different kind of stroke. It is the SAME stroker run over several
// short open paths instead of one long one, which is what makes every join, cap, miter and
// gauge behave in a dash exactly as it does in a solid line - there is no second code path to
// disagree with the first. This module is the cut, and stroke.ts is what draws the pieces.
//
// The pattern is walked by ARC LENGTH along the path, so a dash keeps its length across a
// corner rather than restarting at each vertex, and a piece that spans a corner comes back with
// the corner's vertex still in it - which is what lets the stroker put a real join there.

import type { Vector2Like } from '../math/Vector2'

/**
 * The dash pattern in the form the walk wants: alternating on/off lengths, an even count.
 * Returns null for a pattern that should draw a solid line.
 *
 * An ODD list is doubled, so [10] is ten on and ten off. That is the canvas rule and the one a
 * caller writing `dash: [4]` means; the alternative - reading a lone entry as "on forever" -
 * gives back the solid line they were trying to break up.
 *
 * A negative, non-finite or all-zero list draws solid rather than throwing, also as canvas
 * does: a dash is decoration, and losing the pattern is a better failure than losing the line.
 */
export function normalizeDashPattern(dash: readonly number[] | undefined): number[] | null {
  if (!dash || dash.length === 0) return null
  let total = 0
  for (const entry of dash) {
    if (!Number.isFinite(entry) || entry < 0) return null
    total += entry
  }
  if (total <= 0) return null
  return dash.length % 2 === 1 ? [...dash, ...dash] : [...dash]
}

/**
 * Cuts a contour into the OPEN sub-paths the pattern leaves drawn, each with at least two
 * points. `offset` is how far into the pattern the path starts.
 *
 * A closed ring is walked with its first point appended, so the closing edge is dashed like any
 * other. When the ring both begins and ends mid-dash, the two halves of that dash are rejoined
 * into one piece: they are one run of ink that the start point happens to fall inside, and
 * leaving them apart would show a pair of butt caps at a place the pattern never broke.
 */
export function dashContour(
  points: readonly Vector2Like[],
  closed: boolean,
  pattern: readonly number[],
  offset: number,
): Vector2Like[][] {
  const walk = closed ? [...points, points[0]] : points
  if (walk.length < 2) return []

  let period = 0
  for (const entry of pattern) period += entry

  // Where in the pattern distance 0 falls: which entry, and how far into it. Even entries are
  // on, odd ones off, which is what makes a doubled odd list come out alternating.
  let phase = offset % period
  if (phase < 0) phase += period
  let index = 0
  while (phase >= pattern[index]) {
    phase -= pattern[index]
    index = (index + 1) % pattern.length
  }
  let on = index % 2 === 0
  let remaining = pattern[index] - phase

  const startedOn = on
  const pieces: Vector2Like[][] = []
  let current: Vector2Like[] = on ? [walk[0]] : []

  for (let i = 0; i + 1 < walk.length; i++) {
    const a = walk[i]
    const b = walk[i + 1]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length === 0) continue

    let travelled = 0
    // Each turn of this consumes one whole pattern entry and switches side. `remaining` is
    // strictly positive for at least one entry per cycle (the total is positive), so a pattern
    // holding zeros advances rather than spinning.
    while (length - travelled > remaining) {
      travelled += remaining
      const t = travelled / length
      const cut = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      if (on) {
        current.push(cut)
        if (current.length >= 2) pieces.push(current)
        current = []
      } else {
        current = [cut]
      }
      on = !on
      index = (index + 1) % pattern.length
      remaining = pattern[index]
    }
    remaining -= length - travelled
    if (on) current.push(b)
  }
  if (on && current.length >= 2) pieces.push(current)

  if (closed && startedOn && on && pieces.length >= 2) {
    const first = pieces.shift() as Vector2Like[]
    const last = pieces.pop() as Vector2Like[]
    // The last piece ends where the first begins - the ring's start point - so one copy of it
    // is dropped on the way through.
    pieces.push([...last.slice(0, -1), ...first])
  }
  return pieces
}
