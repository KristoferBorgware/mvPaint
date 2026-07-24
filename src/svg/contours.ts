// Classify a set of flattened contours into filled regions with holes, using even-odd
// containment nesting: a contour nested inside an even number of others is a solid
// (its own region), inside an odd number is a hole of its immediate (smallest)
// containing solid. This robustly covers well-defined shapes with holes (donuts, nested
// donuts). Nonzero-winding fill rule is a possible follow-up.

import type { Point2 } from '../render/meshFormat'
import type { Contour } from '../render/stroke'

export interface ContourGroup {
  outer: Point2[]
  holes: Point2[][]
}

/** Shoelace signed area; positive = counter-clockwise. */
export function signedArea(points: readonly Point2[]): number {
  let sum = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += (points[j].x - points[i].x) * (points[j].y + points[i].y)
  }
  return sum / 2
}

/** Ray-casting point-in-polygon (handles concave); boundary cases are undefined. */
export function pointInPolygon(px: number, py: number, poly: readonly Point2[]): boolean {
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
function sampleOnRing(ring: readonly Point2[]): Point2 {
  return { x: (ring[0].x + ring[1].x) / 2, y: (ring[0].y + ring[1].y) / 2 }
}

export function classifyContours(contours: readonly Contour[]): ContourGroup[] {
  // Only closed contours with real area participate in fill.
  const rings = contours
    .filter((c) => c.closed && c.points.length >= 3)
    .map((c) => c.points as Point2[])
  const n = rings.length
  if (n === 0) return []

  const absArea = rings.map((r) => Math.abs(signedArea(r)))
  const depth = new Array<number>(n).fill(0)
  const containedBy: number[][] = rings.map(() => [])

  for (let i = 0; i < n; i++) {
    const s = sampleOnRing(rings[i])
    for (let j = 0; j < n; j++) {
      if (i !== j && pointInPolygon(s.x, s.y, rings[j])) {
        depth[i]++
        containedBy[i].push(j)
      }
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
