// Triangulate a solid region with holes via earcut. earcut takes a flat coordinate
// array (outer ring followed by hole rings) plus the start index of each hole, and
// returns triangle vertex indices into that array.

import type { Vector2Like } from '../math/Vector2'
import earcut from 'earcut'
import type { ContourGroup } from '../render/contours'

export interface Triangulation {
  /** Outer ring vertices followed by every hole ring's vertices, in order. */
  vertices: Vector2Like[]
  /** Triangle vertex indices into `vertices` (length is a multiple of 3). */
  indices: number[]
}

export function triangulateGroup(group: ContourGroup): Triangulation {
  const coords: number[] = []
  const vertices: Vector2Like[] = []
  const holeIndices: number[] = []

  for (const p of group.outer) {
    coords.push(p.x, p.y)
    vertices.push(p)
  }
  for (const hole of group.holes) {
    holeIndices.push(vertices.length)
    for (const p of hole) {
      coords.push(p.x, p.y)
      vertices.push(p)
    }
  }

  const indices = earcut(coords, holeIndices.length ? holeIndices : undefined, 2)
  return { vertices, indices }
}
