// The nonzero winding rule, for outlines that are drawn with it.
//
// A font builds a letter out of overlapping pieces. The bar of a 't' is a rectangle laid across
// the stem, the two strokes of a 'w' cross at the bottom of each V, and the arch of an 'n' runs
// into its stem - all with the same winding direction, all resolved by the nonzero rule into one
// filled region. Roughly a third of Inter's glyphs are built this way.
//
// contours.ts answers a different question - which ring is nested inside which - and that is the
// even-odd rule. Under it a same-winding piece laid over another reads as a hole and is punched
// out: the bar of a 't' disappears and the letter draws as an 'l'. A ring that crosses ITSELF is
// worse, because earcut takes a simple polygon and a self-crossing one is not one, so the fill
// comes back as an arbitrary mess of triangles.
//
// Two steps here answer the question the way the outline was drawn:
//
//   simpleLoops    cut a ring at its self-crossings into loops that cross nothing, so what
//                  reaches the triangulator is always a simple polygon;
//   windingGroups  decide solid from hole by DIRECTION rather than by nesting, so a piece laid
//                  over another is a second solid and only a ring wound the other way is a hole.
//
// Overlapping solids are left overlapping. Two triangulations painting the same pixel twice in
// the same colour is the union, which is what the nonzero rule asks for, and finding the true
// outline of that union is polygon-boolean work this does not need to do.
//
// The limit is winding numbers beyond ±1: a ring wound the other way INSIDE an overlap is a hole
// here and is filled under a strict nonzero reading. No text face does that.

import type { Vector2Like } from '../math/Vector2'
import { pointInPolygon, signedArea, type ContourGroup } from './contours'

/**
 * How far along a segment two crossings must be from its ends to count. Parametric, so it is the
 * same test whatever the coordinates are measured in - font units here, and an em is a thousand
 * or two of them.
 */
const EDGE_EPSILON = 1e-9

/** Coordinates within this of each other are the same point when loops are matched up. */
const POINT_EPSILON = 1e-6

/**
 * Where two segments cross, strictly inside both, or null.
 *
 * A shared endpoint is not a crossing. Consecutive edges of a ring meet at every vertex, and
 * treating that as a crossing would cut the ring at each one.
 */
function crossing(a: Vector2Like, b: Vector2Like, c: Vector2Like, d: Vector2Like): Vector2Like | null {
  const rx = b.x - a.x
  const ry = b.y - a.y
  const sx = d.x - c.x
  const sy = d.y - c.y
  const denom = rx * sy - ry * sx
  // Parallel, including two collinear segments lying along each other: no single crossing point
  // to cut at, and a collinear overlap leaves the ring simple as far as the triangulator cares.
  if (denom === 0) return null
  const dx = c.x - a.x
  const dy = c.y - a.y
  const t = (dx * sy - dy * sx) / denom
  const u = (dx * ry - dy * rx) / denom
  if (t <= EDGE_EPSILON || t >= 1 - EDGE_EPSILON) return null
  if (u <= EDGE_EPSILON || u >= 1 - EDGE_EPSILON) return null
  return { x: a.x + rx * t, y: a.y + ry * t }
}

/** How far along `a`->`b` the point `p` lies, for ordering several crossings on one edge. */
function parameterOf(a: Vector2Like, b: Vector2Like, p: Vector2Like): number {
  const rx = b.x - a.x
  const ry = b.y - a.y
  return Math.abs(rx) > Math.abs(ry) ? (p.x - a.x) / rx : (p.y - a.y) / ry
}

function pointKey(p: Vector2Like): string {
  const q = 1 / POINT_EPSILON
  return `${Math.round(p.x * q)},${Math.round(p.y * q)}`
}

/**
 * One ring cut into loops that cross neither themselves nor each other.
 *
 * The ring is walked once with the crossings inserted as vertices; arriving at a point the walk
 * has already stood on closes a loop, which is lifted off and the walk carries on from that
 * point. Each loop keeps the direction it was traversed in, which is what windingGroups then
 * reads: the overlap between two pieces comes off wound the same way as the ring and is another
 * solid, while a piece the ring genuinely doubles back over comes off reversed and is a hole.
 *
 * A ring that crosses nothing comes back as itself, and that is the common path - two thirds of
 * a text face's glyphs never reach the loop-lifting below.
 */
export function simpleLoops(points: readonly Vector2Like[]): Vector2Like[][] {
  const n = points.length
  if (n < 3) return []

  const cuts: { at: number; point: Vector2Like }[][] = points.map(() => [])
  let found = false
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    for (let k = i + 2; k < n; k++) {
      // The last edge runs back to the first vertex, so it is adjacent to edge 0 and the two
      // share that vertex rather than crossing at it.
      if (i === 0 && k === n - 1) continue
      const c = points[k]
      const d = points[(k + 1) % n]
      const hit = crossing(a, b, c, d)
      if (!hit) continue
      // The SAME point object on both edges, so the walk below matches them up exactly rather
      // than to within a rounding error.
      cuts[i].push({ at: parameterOf(a, b, hit), point: hit })
      cuts[k].push({ at: parameterOf(c, d, hit), point: hit })
      found = true
    }
  }
  if (!found) return [points.slice()]

  const walk: Vector2Like[] = []
  for (let i = 0; i < n; i++) {
    walk.push(points[i])
    cuts[i].sort((x, y) => x.at - y.at)
    for (const cut of cuts[i]) walk.push(cut.point)
  }

  const loops: Vector2Like[][] = []
  const open: Vector2Like[] = []
  const standingAt = new Map<string, number>()
  for (const point of walk) {
    const key = pointKey(point)
    const seen = standingAt.get(key)
    if (seen === undefined) {
      standingAt.set(key, open.length)
      open.push(point)
      continue
    }
    // Back where the walk already stood: everything since is a closed loop of its own.
    const loop = open.slice(seen)
    for (let i = seen; i < open.length; i++) standingAt.delete(pointKey(open[i]))
    open.length = seen
    if (loop.length >= 3) loops.push(loop)
    standingAt.set(key, open.length)
    open.push(point)
  }
  if (open.length >= 3) loops.push(open)
  return loops
}

/**
 * Rings grouped into solids-with-holes by the direction each is wound in.
 *
 * Which direction means solid is not fixed: it is whichever way the LARGEST ring goes, since the
 * largest ring of a glyph is always one of its outer boundaries. Everything wound that way is a
 * solid of its own; everything wound the other way is a hole, cut from the smallest solid that
 * contains it.
 *
 * A hole inside nothing is dropped. It has no region to be absent from, and handing earcut a
 * hole its outer ring does not contain produces triangles that are neither.
 */
export function windingGroups(rings: readonly (readonly Vector2Like[])[]): ContourGroup[] {
  const usable = rings.filter((ring) => ring.length >= 3)
  if (usable.length === 0) return []

  const areas = usable.map(signedArea)
  let largest = 0
  for (let i = 1; i < usable.length; i++) {
    if (Math.abs(areas[i]) > Math.abs(areas[largest])) largest = i
  }
  const solidSign = Math.sign(areas[largest]) || 1

  const groups: ContourGroup[] = []
  const groupOfRing = new Map<number, number>()
  usable.forEach((ring, i) => {
    if (Math.sign(areas[i]) !== solidSign) return
    groupOfRing.set(i, groups.length)
    groups.push({ outer: ring as Vector2Like[], holes: [] })
  })

  usable.forEach((ring, i) => {
    if (Math.sign(areas[i]) === solidSign) return
    // The midpoint of the first edge: for a ring that crosses nothing it lies inside exactly the
    // rings that contain this one, which is all the containment test needs.
    const sx = (ring[0].x + ring[1].x) / 2
    const sy = (ring[0].y + ring[1].y) / 2
    let parent = -1
    let parentArea = Infinity
    usable.forEach((other, k) => {
      if (k === i || Math.sign(areas[k]) !== solidSign) return
      const area = Math.abs(areas[k])
      if (area >= parentArea || !pointInPolygon(sx, sy, other)) return
      parent = k
      parentArea = area
    })
    if (parent >= 0) groups[groupOfRing.get(parent)!].holes.push(ring as Vector2Like[])
  })

  return groups
}
