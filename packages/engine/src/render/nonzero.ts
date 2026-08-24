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
// Three pieces here answer the question the way the outline was drawn:
//
//   simpleLoops     cut a ring at its self-crossings into loops that cross nothing, so what
//                   reaches the triangulator is always a simple polygon;
//   windingGroups   decide solid from hole by DIRECTION rather than by nesting, so a piece laid
//                   over another is a second solid and only a ring wound the other way is a hole;
//   unionBoundary   the silhouette of what a set of rings fills, every internal seam gone.
//
// nonzeroGroups and evenOddGroups are what a shape asks for, and are the three composed: the
// silhouette, cut into loops, grouped. The EVEN-ODD one is here rather than beside the nesting
// test in contours.ts because the walk is the same and only the question asked at each side of a
// piece differs - is the winding non-zero, or is the crossing count odd. Two walks would be two
// chances to disagree about a shape neither rule is in doubt about.
//
// windingGroups on its own leaves overlapping solids overlapping: two triangulations painting one
// pixel twice in the same colour is the union at full alpha, which is all a glyph needs. A path
// goes through the silhouette first, so an overlap is one region with one boundary and is filled
// once - which is what an alpha below 1 needs.
//
// The limit is winding numbers beyond ±1: a ring wound the other way INSIDE an overlap is a hole
// in windingGroups and is filled under a strict nonzero reading. No text face does that, and the
// groupings below read the number rather than the direction, so it holds there too.

import type { Vector2Like } from '../math/Vector2'
import { pointInPolygon, signedArea, type ContourGroup, type FillRule } from './contours'
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
  // A box per edge, so the pass below rejects almost every pair on four comparisons. The pass is
  // over every pair of edges either way, and a flattened curve is hundreds of short edges nearly
  // none of which are anywhere near each other - the work saved is the crossing solve, which is
  // two subtractions per coordinate, a determinant and two divisions.
  const loX = new Float64Array(n)
  const loY = new Float64Array(n)
  const hiX = new Float64Array(n)
  const hiY = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    loX[i] = Math.min(a.x, b.x)
    loY[i] = Math.min(a.y, b.y)
    hiX[i] = Math.max(a.x, b.x)
    hiY[i] = Math.max(a.y, b.y)
  }

  let found = false
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    for (let k = i + 2; k < n; k++) {
      // The last edge runs back to the first vertex, so it is adjacent to edge 0 and the two
      // share that vertex rather than crossing at it.
      if (i === 0 && k === n - 1) continue
      if (hiX[i] < loX[k] || hiX[k] < loX[i] || hiY[i] < loY[k] || hiY[k] < loY[i]) continue
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
 * WHICH SIDE HAS MATERIAL is the only place the fill rule enters: under 'nonzero' a point is
 * material where its winding number is not zero, under 'evenodd' where it sits inside an odd
 * number of the rings. Everything else - the cutting, the keeping, the chaining - is one walk,
 * so the two rules cannot differ about anything except the thing they are.
 *
 * The rule decides it rather than containment, so a counter comes through as a hole in the
 * silhouette (material on one side, none on the other) without being a special case.
 */
export function unionBoundary(contours: readonly Contour[], rule: FillRule = 'nonzero'): Contour[] {
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

  // Inside, by the rule being read. Even-odd toggles once per ring the point is within, which
  // is the ray-casting test contours.ts already does one ring at a time.
  const material =
    rule === 'evenodd'
      ? (px: number, py: number): boolean => {
          let inside = false
          for (const ring of rings) if (pointInPolygon(px, py, ring)) inside = !inside
          return inside
        }
      : (px: number, py: number): boolean => windingAt(px, py, rings) !== 0

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
        const left = material(mx + nx, my + ny)
        const right = material(mx - nx, my - ny)
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

/**
 * The regions a set of contours fills, under either rule: each solid with the holes inside it,
 * ready for a triangulator.
 *
 * windingGroups above answers this for a glyph, where every outer boundary is wound the same way
 * and the largest ring says which way that is. A drawing carries no such promise - two subpaths
 * of one `d` are often wound against each other, and neither rule cares which way either runs -
 * so the rings go through unionBoundary first. What comes back is the SILHOUETTE of the filled
 * region: every stretch of edge with material on both sides is gone, and what remains is wound
 * consistently, which is the promise windingGroups needs.
 *
 * Going through the silhouette rather than reading each ring on its own is what makes a shared
 * boundary work. Two subpaths that meet along an edge and run opposite ways are both filled -
 * each is wound once - but that shared edge is interior to the pair, and a ring is not one thing
 * or the other: part of its outline is silhouette and part is seam. Only the pieces can be
 * classified, and unionBoundary classifies pieces.
 *
 * It also leaves no overlap behind. Two solids drawn over each other paint the same triangle
 * twice, which is invisible at full alpha and doubles the ink at any other; the silhouette has
 * one boundary and fills once.
 *
 * A set whose silhouette comes back empty - everything cancelled, or geometry too degenerate to
 * walk - falls back to the rings as they were written, which is the reading that at least draws
 * something.
 *
 * The walk is skipped entirely for rings that never meet, where containment says the same thing
 * for less - see edgesMeet and containmentRegions below, and the case table in nonzero.test.ts,
 * which covers both readings under both rules.
 */
function fillRegions(contours: readonly Contour[], rule: FillRule): ContourGroup[] {
  const rings = contours.filter((c) => c.points.length >= 3).map((c) => c.points as Vector2Like[])
  if (rings.length === 0) return []

  // NOTHING MEETING ANYTHING IS THE ORDINARY CASE, and it does not need a walk. Where no edge
  // crosses or touches another, every ring is a simple polygon that is wholly inside another or
  // wholly outside it - an icon is a ring with two counters in it, a letter is a bowl and a
  // stem - and the rule can be read from what contains what. The walk below exists for the
  // arrangements containment cannot describe, and those are the minority of a drawing.
  if (!edgesMeet(rings)) return containmentRegions(rings, rule)

  const silhouette = unionBoundary(contours.filter((c) => c.points.length >= 3), rule)
  const outline = silhouette.length > 0 ? silhouette : contours.filter((c) => c.points.length >= 3)
  return windingGroups(outline.flatMap((contour) => simpleLoops(contour.points)))
}

/**
 * Whether any two edges of the set meet - cross, or run into one another end-on - counting a
 * ring against itself as well as against its neighbours. Adjacent edges of one ring share a
 * vertex by construction and are not a meeting.
 *
 * This is the question that decides whether containment can answer the fill: rings that never
 * meet are nested or apart, and nothing else. It is the same pairwise pass unionBoundary opens
 * with, stopping at the first hit rather than collecting them, and every pair whose boxes miss
 * is rejected on four comparisons - which is nearly every pair, since the edges of a flattened
 * curve are short and mostly nowhere near each other.
 */
function edgesMeet(rings: readonly (readonly Vector2Like[])[]): boolean {
  interface Edge { a: Vector2Like; b: Vector2Like; ring: number; index: number; last: number
    loX: number; loY: number; hiX: number; hiY: number }
  const edges: Edge[] = []
  let extent = 0
  rings.forEach((raw, r) => {
    // Consecutive repeats first, and the closing point where a path drew back to its start before
    // saying `z`. They are edges of no length, and they push the ring's real first and last edges
    // apart in the index space the adjacency test below reads - which would report an ordinary
    // ring as touching itself at the vertex it closes on.
    const ring = raw.filter((p, i) => i === 0 || p.x !== raw[i - 1].x || p.y !== raw[i - 1].y)
    while (ring.length > 1 && ring[ring.length - 1].x === ring[0].x && ring[ring.length - 1].y === ring[0].y) {
      ring.pop()
    }
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      edges.push({
        a, b, ring: r, index: i, last: ring.length - 1,
        loX: Math.min(a.x, b.x), loY: Math.min(a.y, b.y),
        hiX: Math.max(a.x, b.x), hiY: Math.max(a.y, b.y),
      })
      extent = Math.max(extent, Math.abs(a.x), Math.abs(a.y))
    }
  })
  const touch = Math.max(extent * 1e-9, Number.MIN_VALUE)

  /**
   * Whether either end of `two` lies ON `one`, ENDPOINTS INCLUDED - which is what a crossing test
   * cannot see and what a shared boundary is made of. Two rings that run along each other, or
   * meet at a corner, or are written twice, touch only at points a crossing rejects as a shared
   * endpoint, and reading those from containment is exactly what goes wrong: the point a
   * containment test samples can land on the other ring's boundary, where inside and outside are
   * the same answer.
   */
  const meetsEndOn = (one: Edge, two: Edge): boolean => {
    const dx = one.b.x - one.a.x
    const dy = one.b.y - one.a.y
    const lengthSquared = dx * dx + dy * dy
    // A segment of no length - which a flattened curve leaves at a seam - is a point, and a point
    // is no boundary to share. Whether it lies on the OTHER edge is the same call the other way
    // round, which the caller makes.
    if (lengthSquared === 0) return false
    const length = Math.sqrt(lengthSquared)
    for (const vertex of [two.a, two.b]) {
      const at = ((vertex.x - one.a.x) * dx + (vertex.y - one.a.y) * dy) / lengthSquared
      if (at < 0 || at > 1) continue
      const off = Math.abs((vertex.x - one.a.x) * dy - (vertex.y - one.a.y) * dx) / length
      if (off <= touch) return true
    }
    return false
  }

  for (let i = 0; i < edges.length; i++) {
    for (let k = i + 1; k < edges.length; k++) {
      const one = edges[i]
      const two = edges[k]
      if (one.hiX < two.loX || two.hiX < one.loX || one.hiY < two.loY || two.hiY < one.loY) continue
      if (one.ring === two.ring) {
        // Consecutive edges share a vertex, and so do the last and the first.
        const step = Math.abs(one.index - two.index)
        if (step === 1 || step === one.last) continue
      }
      if (crossing(one.a, one.b, two.a, two.b)) return true
      if (meetsEndOn(one, two) || meetsEndOn(two, one)) return true
    }
  }
  return false
}

/**
 * The fill of rings that never meet, read from what contains what.
 *
 * Every ring here is simple, and every pair is nested or apart, so the region just inside a ring
 * and the region just outside it each have one answer: under 'evenodd' whether the number of
 * rings around the point is odd, under 'nonzero' whether their windings sum to something other
 * than zero. A ring with material on one side of it is a boundary - an outer where the material
 * is within, a hole where it is without - and a ring with the same answer on both sides bounds
 * nothing and is dropped.
 *
 * THIS READING IS ONLY GOOD IN THAT REGIME. Where two rings share a boundary, part of a ring's
 * outline has material on both sides and part does not, so the ring is not one thing or the
 * other and no per-ring answer exists - see fillRegions, which sends those to the walk.
 */
function containmentRegions(rings: readonly Vector2Like[][], rule: FillRule): ContourGroup[] {
  const areas = rings.map((ring) => signedArea(ring))
  // The midpoint of a ring's first edge: for rings that never meet it lies inside exactly the
  // rings that contain this one.
  const samples = rings.map((ring) => ({ x: (ring[0].x + ring[1].x) / 2, y: (ring[0].y + ring[1].y) / 2 }))

  const around: number[][] = rings.map((_, i) =>
    rings.map((_, j) => j).filter((j) => j !== i && pointInPolygon(samples[i].x, samples[i].y, rings[j])),
  )

  const material = (containing: readonly number[], own: number | null): boolean => {
    if (rule === 'evenodd') return (containing.length + (own === null ? 0 : 1)) % 2 === 1
    let winding = own === null ? 0 : Math.sign(own)
    for (const j of containing) winding += Math.sign(areas[j])
    return winding !== 0
  }

  const groups: ContourGroup[] = []
  const outerOf = new Map<number, number>()
  const holes: number[] = []
  rings.forEach((ring, i) => {
    const outside = material(around[i], null)
    const inside = material(around[i], areas[i])
    if (inside === outside) return
    if (inside) {
      outerOf.set(i, groups.length)
      groups.push({ outer: ring, holes: [] })
    } else {
      holes.push(i)
    }
  })

  for (const i of holes) {
    // The smallest solid the ring sits in. A hole inside nothing has no region to be absent from,
    // and earcut takes a hole its outer ring contains.
    let parent = -1
    let parentArea = Infinity
    for (const j of around[i]) {
      const area = Math.abs(areas[j])
      if (!outerOf.has(j) || area >= parentArea) continue
      parent = j
      parentArea = area
    }
    if (parent >= 0) groups[outerOf.get(parent)!].holes.push(rings[i])
  }
  return groups
}

/**
 * The regions a set of contours fills under the NONZERO rule - material wherever the winding
 * number is not zero. SVG's default, and the rule a font is drawn with.
 */
export function nonzeroGroups(contours: readonly Contour[]): ContourGroup[] {
  return fillRegions(contours, 'nonzero')
}

/**
 * The regions a set of contours fills under the EVEN-ODD rule - material wherever a point sits
 * inside an odd number of the rings, whichever way any of them runs.
 *
 * classifyContours in contours.ts answers the same question by NESTING, and gives the same answer
 * wherever one ring contains another or misses it entirely - a donut, a nested donut, a letter
 * with a counter. Where two rings OVERLAP without either containing the other it has nowhere to
 * put the lens between them: the lens is inside both, so it is not filled, and what remains is
 * neither ring but the two crescents around it. That is a region with a boundary rather than a
 * ring with a hole, which is what this walk produces and a depth count cannot.
 */
export function evenOddGroups(contours: readonly Contour[]): ContourGroup[] {
  return fillRegions(contours, 'evenodd')
}
