// How long a flattened outline is, and where a given distance along it lands.
//
// Everything here measures the SEGMENTS, not the curve they approximate, so a shape flattened at
// a coarser tolerance measures very slightly short - a polygon inscribed in a curve is always
// the shorter of the two. At the 0.25-unit chord tolerance the flatteners use, the difference is
// far below what a caller placing a label or animating a dash along a path can see.
//
// Distances run through a contour list in order, each contour's closing segment included when it
// has one, so a multi-subpath outline is one continuous ruler.

import type { Vector2Like } from '../math/Vector2'
import type { Contour } from './stroke'

function segmentCount(points: readonly Vector2Like[], closed: boolean): number {
  if (points.length < 2) return 0
  return closed ? points.length : points.length - 1
}

/** The length of one point list, its closing segment included when `closed`. */
export function contourLength(points: readonly Vector2Like[], closed = false): number {
  let total = 0
  const n = segmentCount(points, closed)
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    total += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return total
}

/** Every contour's length added up - the ruler pointAtLength() reads along. */
export function contoursLength(contours: readonly Contour[]): number {
  let total = 0
  for (const c of contours) total += contourLength(c.points, c.closed ?? false)
  return total
}

/**
 * The point `distance` units along the outline, or null when there is no outline to walk.
 *
 * A distance past either end clamps to that end rather than extrapolating, which is what a
 * caller stepping a marker along a path in fixed increments wants at the last step.
 */
export function pointAtLength(contours: readonly Contour[], distance: number): Vector2Like | null {
  let first: Vector2Like | null = null
  let last: Vector2Like | null = null
  let remaining = Math.max(0, distance)

  for (const c of contours) {
    const points = c.points
    const n = segmentCount(points, c.closed ?? false)
    if (n === 0) continue
    first ??= points[0]
    for (let i = 0; i < n; i++) {
      const a = points[i]
      const b = points[(i + 1) % points.length]
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      last = b
      if (len === 0) continue
      if (remaining <= len) {
        const t = remaining / len
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      }
      remaining -= len
    }
  }
  // Past the end (or a zero-length outline of coincident points): the far end, or the near one
  // if the walk never found a segment at all.
  return last ?? first
}
