// Polygon nesting: which of a set of flattened rings are solids and which are holes, by
// even-odd containment - a contour nested inside an even number of others is a solid (its own
// region), inside an odd number is a hole of its immediate (smallest) containing solid. This
// robustly covers well-defined shapes with holes (donuts, nested donuts).
//
// That is the EVEN-ODD rule. The other one a path can be filled with is nonzero, which decides
// solid from hole by the direction a ring is wound rather than by what contains it - see
// nonzero.ts, and FillRule below for which of the two a shape asks for.
//
// It lives beside the mesh formats rather than under svg/ because three unrelated things need
// it: filling an SVG path, filling a glyph outline, and deciding which side of a contour a
// stroke should expand onto (see stroke.ts, strokeAlign). None of those is about SVG.

import type { Vector2Like } from '../math/Vector2'
import type { Contour } from './stroke'

export interface ContourGroup {
  outer: Vector2Like[]
  holes: Vector2Like[][]
}

/**
 * Which rule decides what a set of rings fills.
 *
 * 'nonzero' reads the direction each ring is wound in: a ring laid over another wound the same
 * way is more solid, and only one wound the other way is a hole. It is SVG's own default and
 * the rule a font is drawn with. 'evenodd' reads containment: a ring inside another is a hole,
 * whichever way either is wound. The two agree on a shape whose holes are wound against its
 * outers, which is what an editor emits, and differ on same-winding nesting and on a ring that
 * crosses itself.
 */
export type FillRule = 'nonzero' | 'evenodd'

/** Shoelace signed area; positive = counter-clockwise. */
export function signedArea(points: readonly Vector2Like[]): number {
  let sum = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += (points[j].x - points[i].x) * (points[j].y + points[i].y)
  }
  return sum / 2
}

/** Ray-casting point-in-polygon (handles concave); boundary cases are undefined. */
export function pointInPolygon(px: number, py: number, poly: readonly Vector2Like[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y
    const xj = poly[j].x, yj = poly[j].y
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

// A point on the ring (first-edge midpoint) - for non-touching contours it lies inside
// exactly the rings that contain this ring, which is all the nesting test needs.
function sampleOnRing(ring: readonly Vector2Like[]): Vector2Like {
  return { x: (ring[0].x + ring[1].x) / 2, y: (ring[0].y + ring[1].y) / 2 }
}

/**
 * How many other rings each ring is nested inside - 0 for an outermost one, 1 for a hole in
 * it, 2 for an island inside that hole, and so on. Even is a solid, odd is a hole.
 *
 * Split out from classifyContours because the stroker asks the same question for a different
 * reason: an inside/outside stroke expands away from, or into, the FILL, and on a hole ring
 * the fill is on the opposite side to the one the ring's own winding would suggest.
 */
export function nestingDepths(rings: readonly (readonly Vector2Like[])[]): number[] {
  const n = rings.length
  const depth = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    const s = sampleOnRing(rings[i])
    for (let j = 0; j < n; j++) {
      if (i !== j && pointInPolygon(s.x, s.y, rings[j])) depth[i]++
    }
  }
  return depth
}

/**
 * The even-odd grouping of a set of contours: each solid region with the holes inside it.
 *
 * A contour of three or more points is a region whether or not it is closed. Filling closes an
 * open subpath implicitly (SVG 1.1 §11.4, and ShapeContext.fill() reads it the same way), so
 * `closed` speaks for the stroke - where the closing segment is drawn or is not - and says
 * nothing about the area.
 */
export function classifyContours(contours: readonly Contour[]): ContourGroup[] {
  const rings = contours
    .filter((c) => c.points.length >= 3)
    .map((c) => c.points as Vector2Like[])
  const n = rings.length
  if (n === 0) return []

  const absArea = rings.map((r) => Math.abs(signedArea(r)))
  const depth = nestingDepths(rings)
  const containedBy: number[][] = rings.map(() => [])

  for (let i = 0; i < n; i++) {
    const s = sampleOnRing(rings[i])
    for (let j = 0; j < n; j++) {
      if (i !== j && pointInPolygon(s.x, s.y, rings[j])) containedBy[i].push(j)
    }
  }

  const groups: ContourGroup[] = []
  const groupOfRing = new Array<number>(n).fill(-1)

  // Even depth = solid region (its own group).
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 === 0) {
      groupOfRing[i] = groups.length
      groups.push({ outer: rings[i], holes: [] })
    }
  }
  // Odd depth = hole; assign to its immediate parent (smallest containing solid, at depth-1).
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 !== 0) {
      let parent = -1
      let parentArea = Infinity
      for (const j of containedBy[i]) {
        if (depth[j] === depth[i] - 1 && absArea[j] < parentArea) {
          parent = j
          parentArea = absArea[j]
        }
      }
      if (parent >= 0 && groupOfRing[parent] >= 0) {
        groups[groupOfRing[parent]].holes.push(rings[i])
      }
    }
  }

  return groups
}
