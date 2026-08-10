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
import type { Contour } from './stroke'

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

/** A piece of one edge, after every crossing on it has cut it up. */
interface BoundarySegment {
  from: Vector2Like
  to: Vector2Like
}

/** Winding number of a point against a set of rings - the nonzero rule, computed straight. */
function windingAt(px: number, py: number, rings: readonly (readonly Vector2Like[])[]): number {
  let winding = 0
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j]
      const b = ring[i]
      if (a.y <= py) {
        if (b.y > py && (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y) > 0) winding++
      } else if (b.y <= py && (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y) < 0) {
        winding--
      }
    }
  }
  return winding
}

/**
 * Which piece the walk leaves a junction on.
 *
 * Where the silhouette crosses itself, several pieces leave one point and picking the wrong one
 * traverses the boundary inside-out - the counter of a 'D' comes out wound like an outer, and the
 * letter fills solid. The one to take is the first going CLOCKWISE from the way the walk came in,
 * which is the piece that hugs the material rather than cutting across it. Everywhere else there
 * is one candidate and this is a lookup.
 */
function nextAround(
  arriving: BoundarySegment,
  candidates: BoundarySegment[] | undefined,
  used: ReadonlySet<BoundarySegment>,
): BoundarySegment | undefined {
  if (!candidates) return undefined
  const free = candidates.filter((segment) => !used.has(segment))
  if (free.length <= 1) return free[0]

  // Measured from the way back the walk came, so the sharpest turn is the smallest angle and
  // carrying straight on is close to a half turn.
  const bx = arriving.from.x - arriving.to.x
  const by = arriving.from.y - arriving.to.y
  let best: BoundarySegment | undefined
  let bestAngle = -Infinity
  for (const segment of free) {
    const dx = segment.to.x - segment.from.x
    const dy = segment.to.y - segment.from.y
    let angle = Math.atan2(bx * dy - by * dx, bx * dx + by * dy)
    if (angle <= 0) angle += Math.PI * 2
    if (angle > bestAngle) {
      bestAngle = angle
      best = segment
    }
  }
  return best
}

/**
 * The outline of the UNION of a set of rings: the silhouette, with every internal seam gone.
 *
 * This is what a stroke has to follow. The rings themselves are the pieces a letter was BUILT
 * from, and stroking those draws the joins between them - the bar of a 't' outlined as a
 * rectangle running through the stem, an 'e' with a line out of the side of its bowl - which is
 * scaffolding the letter was never meant to show.
 *
 * Every edge is cut at each crossing, and each piece is then asked one question: stepping a
 * hair's breadth off it to either side, is the winding number zero on exactly one of them. A
 * piece with filled material on both sides is a seam and goes; a piece with material on one side
 * is boundary and stays. What survives is chained back into closed rings by its endpoints, which
 * match exactly because the crossings that made them were computed once and shared.
 *
 * Winding decides it rather than containment, so a counter comes through as a hole in the
 * silhouette (material on one side, none on the other) without being a special case.
 */
export function unionBoundary(contours: readonly Contour[]): Contour[] {
  const rings = contours.map((contour) => contour.points).filter((points) => points.length >= 3)
  if (rings.length === 0) return []

  // One flat list of edges, so a crossing between two rings is found by the same pass as one
  // within a ring. `crossing` rejects shared endpoints, which is every consecutive pair.
  // Each edge carries its own box, so the two quadratic passes below reject almost every pair on
  // four comparisons - a letter's edges are short and nearly all of them are nowhere near each
  // other.
  interface Edge {
    a: Vector2Like
    b: Vector2Like
    loX: number
    loY: number
    hiX: number
    hiY: number
    cuts: { at: number; point: Vector2Like }[]
  }
  const edges: Edge[] = []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      edges.push({
        a,
        b,
        loX: Math.min(a.x, b.x),
        loY: Math.min(a.y, b.y),
        hiX: Math.max(a.x, b.x),
        hiY: Math.max(a.y, b.y),
        cuts: [],
      })
      if (a.x < minX) minX = a.x
      if (a.x > maxX) maxX = a.x
      if (a.y < minY) minY = a.y
      if (a.y > maxY) maxY = a.y
    }
  }
  // How far off an edge to stand when asking which side is filled, and how far a point may be
  // from a line and still be called on it. Relative to the outline's own size, since this is
  // asked of glyphs in font units and of paths in whatever the caller uses.
  const step = Math.max((Math.max(maxX - minX, maxY - minY) || 1) * 1e-6, Number.MIN_VALUE)

  for (let i = 0; i < edges.length; i++) {
    for (let k = i + 1; k < edges.length; k++) {
      const one = edges[i]
      const two = edges[k]
      if (one.hiX < two.loX || two.hiX < one.loX || one.hiY < two.loY || two.hiY < one.loY) continue
      const hit = crossing(edges[i].a, edges[i].b, edges[k].a, edges[k].b)
      if (!hit) continue
      edges[i].cuts.push({ at: parameterOf(edges[i].a, edges[i].b, hit), point: hit })
      edges[k].cuts.push({ at: parameterOf(edges[k].a, edges[k].b, hit), point: hit })
    }
  }

  // Crossings alone are not enough. Pieces of a letter meet along shared lines as often as they
  // cross - the stem of a 'D' stands on the same baseline as its bowl, and the two edges lie
  // ALONG each other rather than through each other, which no crossing finds. So every edge is
  // also cut wherever another edge's endpoint touches it. Without this the pieces of the
  // silhouette never meet at a shared point and the walk below cannot get from one to the next.
  const touchTolerance = step
  for (const edge of edges) {
    const dx = edge.b.x - edge.a.x
    const dy = edge.b.y - edge.a.y
    const lengthSquared = dx * dx + dy * dy
    if (lengthSquared === 0) continue
    const length = Math.sqrt(lengthSquared)
    for (const ring of rings) {
      for (const vertex of ring) {
        if (vertex.x < edge.loX - touchTolerance || vertex.x > edge.hiX + touchTolerance) continue
        if (vertex.y < edge.loY - touchTolerance || vertex.y > edge.hiY + touchTolerance) continue
        const at = ((vertex.x - edge.a.x) * dx + (vertex.y - edge.a.y) * dy) / lengthSquared
        if (at <= EDGE_EPSILON || at >= 1 - EDGE_EPSILON) continue
        const offLine = Math.abs((vertex.x - edge.a.x) * dy - (vertex.y - edge.a.y) * dx) / length
        if (offLine > touchTolerance) continue
        edge.cuts.push({ at, point: vertex })
      }
    }
  }

  const kept: BoundarySegment[] = []
  const already = new Set<string>()
  const add = (segment: BoundarySegment): void => {
    const key = `${pointKey(segment.from)}>${pointKey(segment.to)}`
    if (already.has(key)) return
    already.add(key)
    kept.push(segment)
  }
  for (const edge of edges) {
    edge.cuts.sort((x, y) => x.at - y.at)
    let from = edge.a
    for (const cut of [...edge.cuts, { at: 1, point: edge.b }]) {
      const to = cut.point
      const dx = to.x - from.x
      const dy = to.y - from.y
      const length = Math.hypot(dx, dy)
      if (length > 0) {
        // The midpoint is the point on the piece furthest from whatever cut it, so it is where
        // the two sides are least likely to be confused with each other.
        const mx = (from.x + to.x) / 2
        const my = (from.y + to.y) / 2
        const nx = (-dy / length) * step
        const ny = (dx / length) * step
        const left = windingAt(mx + nx, my + ny, rings) !== 0
        const right = windingAt(mx - nx, my - ny, rings) !== 0
        // Every kept piece is turned so the material is on the same side of it as every other's,
        // whichever piece it was cut from. That is what makes the rings come out of the walk
        // below already wound correctly - an outer one way, a counter the other - rather than
        // inheriting the direction of whichever piece of scaffolding happened to contribute it.
        // Where two pieces lie ALONG each other, the same stretch of boundary is contributed
        // twice. Kept once: two identical ways out of one point would send the walk round the
        // same ring twice and leave the second copy to be closed on its own.
        if (left && !right) add({ from, to })
        else if (right && !left) add({ from: to, to: from })
      }
      from = to
    }
  }
  if (kept.length === 0) return []

  const leaving = new Map<string, BoundarySegment[]>()
  for (const segment of kept) {
    const key = pointKey(segment.from)
    const list = leaving.get(key)
    if (list) list.push(segment)
    else leaving.set(key, [segment])
  }

  const out: Contour[] = []
  const used = new Set<BoundarySegment>()
  for (const start of kept) {
    if (used.has(start)) continue
    const points: Vector2Like[] = [start.from]
    let segment: BoundarySegment | undefined = start
    while (segment && !used.has(segment)) {
      used.add(segment)
      points.push(segment.to)
      segment = nextAround(segment, leaving.get(pointKey(segment.to)), used)
    }
    // The walk arrives back where it began, so the repeated first point is dropped - `closed`
    // already says the last vertex joins the first.
    if (points.length > 1 && pointKey(points[0]) === pointKey(points[points.length - 1])) points.pop()
    if (points.length >= 3) out.push({ points, closed: true })
  }
  return out
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
