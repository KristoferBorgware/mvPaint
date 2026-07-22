// General-purpose contour stroker. Offsets an ordered point list (open or closed) by
// strokeWidth/2 to each side and meshes the resulting ribbon, with Canvas2D-style
// joins (miter/round/bevel) and caps (butt/round/square). This is the one engine every
// stroked shape should call into - a rectangle's 4 corners, a circle's rim samples, a
// hand-authored polyline, or a loop extracted from a triangulated SVG path.
//
// A mesh with holes is just several independent closed contours (the outer boundary
// plus one loop per hole); strokeContours() strokes each one separately - stroking
// doesn't care about winding or which loop is a "hole".
//
// Known simplification: at a joint, the CONVEX side gets a proper join (miter/round/
// bevel); the CONCAVE side is filled by a single triangle straight to the ORIGINAL path
// point, not a true inner-miter intersection. That means the inner boundary at sharp
// corners extends slightly farther inward than a perfect double-miter would (all the
// way to the path itself) rather than stopping at the ideal offset distance - a
// superset of the correct coverage, never a gap, so it's visually harmless for opaque
// strokes; it can also overlap neighboring geometry on very sharp reflex turns (same
// fill color, so no visible seam either way). A fully correct, self-intersection-free
// inner offset is real-vector-library-sized work (Clipper2-style polygon booleans) and
// out of scope here. Vertices are also not deduplicated across adjacent segments/
// joints - a bit of extra geometry traded for a simple, easy-to-verify algorithm.

import type { MeshSink, RGBA } from './meshFormat'

export type LineJoin = 'miter' | 'round' | 'bevel'
export type LineCap = 'butt' | 'round' | 'square'

export interface Point2 {
  x: number
  y: number
}

export interface StrokeOptions {
  width: number
  color: RGBA
  /** Loop back to the start (a boundary/contour) vs. an open path with caps. Default true. */
  closed?: boolean
  join?: LineJoin
  cap?: LineCap
  /**
   * Canvas2D-style miter limit: the ratio of miter length to half the stroke width
   * beyond which a miter join falls back to a bevel. Default 10 (Canvas2D's default).
   */
  miterLimit?: number
  /** Segments used to tessellate a round join or round cap. Default 8. */
  roundSegments?: number
}

export interface Contour {
  points: readonly Point2[]
  closed?: boolean
}

const TWO_PI = Math.PI * 2

function normalize(dx: number, dy: number): [number, number] {
  const len = Math.hypot(dx, dy) || 1
  return [dx / len, dy / len]
}

/** Perpendicular of a unit direction; sign only needs to be internally consistent. */
function perp(dx: number, dy: number): [number, number] {
  return [dy, -dx]
}

/** Emits a round fan from `center`, sweeping `sweep` radians starting at `startAngle`. */
function emitArc(
  sink: MeshSink,
  color: RGBA,
  center: Point2,
  radius: number,
  startAngle: number,
  sweep: number,
  steps: number,
  hubIdx: number,
  firstIdx: number,
): void {
  let prevIdx = firstIdx
  for (let k = 1; k <= steps; k++) {
    const a = startAngle + (sweep * k) / steps
    const x = center.x + Math.cos(a) * radius
    const y = center.y + Math.sin(a) * radius
    const idx = sink.vertex(x, y, color)
    sink.triangle(hubIdx, prevIdx, idx)
    prevIdx = idx
  }
}

/** Emits a round or square cap at `p`, given the OUTWARD-facing side normal there. */
function strokeCap(
  sink: MeshSink,
  color: RGBA,
  p: Point2,
  normal: [number, number],
  s: number,
  cap: LineCap,
  roundSegments: number,
): void {
  if (cap === 'butt') return // the segment quad already ends flush at p.

  const [nx, ny] = normal
  const p0 = { x: p.x + nx * s, y: p.y + ny * s }
  const p1 = { x: p.x - nx * s, y: p.y - ny * s }
  // Outward direction = normal rotated +90°.
  const dx = -ny
  const dy = nx

  if (cap === 'square') {
    const e0 = { x: p0.x + dx * s, y: p0.y + dy * s }
    const e1 = { x: p1.x + dx * s, y: p1.y + dy * s }
    const i0 = sink.vertex(p0.x, p0.y, color)
    const i1 = sink.vertex(p1.x, p1.y, color)
    const ie0 = sink.vertex(e0.x, e0.y, color)
    const ie1 = sink.vertex(e1.x, e1.y, color)
    sink.triangle(i0, ie0, ie1)
    sink.triangle(i0, ie1, i1)
    return
  }

  // round: a half-circle from +normal to -normal, sweeping +π (which always passes
  // through the outward direction, since outward is exactly +90° from +normal).
  const hubIdx = sink.vertex(p.x, p.y, color)
  const firstIdx = sink.vertex(p0.x, p0.y, color)
  const startAngle = Math.atan2(ny, nx)
  emitArc(sink, color, p, s, startAngle, Math.PI, Math.max(2, roundSegments), hubIdx, firstIdx)
}

/**
 * Strokes a single contour into `sink`. Points are consumed as given (already in the
 * space the shape wants to draw in - typically its own local space, pre-transform).
 */
export function strokePolyline(points: readonly Point2[], sink: MeshSink, options: StrokeOptions): void {
  const {
    width,
    color,
    closed = true,
    join = 'miter',
    cap = 'butt',
    miterLimit = 10,
    roundSegments = 8,
  } = options
  const s = width / 2
  const n = points.length
  if (n < 2 || s <= 0) return

  const segCount = closed ? n : n - 1
  if (segCount < 1) return

  // Per-edge unit direction and its perpendicular normal.
  const dirs: [number, number][] = []
  const norms: [number, number][] = []
  for (let i = 0; i < segCount; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    const d = normalize(b.x - a.x, b.y - a.y)
    dirs.push(d)
    norms.push(perp(d[0], d[1]))
  }

  // --- straight segment quads: every edge, offset by its own normal at both ends ----
  for (let e = 0; e < segCount; e++) {
    const a = points[e]
    const b = points[(e + 1) % n]
    const [nx, ny] = norms[e]
    const ia0 = sink.vertex(a.x + nx * s, a.y + ny * s, color)
    const ia1 = sink.vertex(a.x - nx * s, a.y - ny * s, color)
    const ib0 = sink.vertex(b.x + nx * s, b.y + ny * s, color)
    const ib1 = sink.vertex(b.x - nx * s, b.y - ny * s, color)
    sink.triangle(ia0, ib0, ib1)
    sink.triangle(ia0, ib1, ia1)
  }

  // --- joints: interior vertices for an open path, every vertex for a closed loop ---
  const jointStart = closed ? 0 : 1
  const jointCount = closed ? n : n - 2

  for (let i = 0; i < jointCount; i++) {
    const vi = (jointStart + i) % n
    const inEdge = closed ? (vi - 1 + segCount) % segCount : vi - 1
    const outEdge = closed ? vi % segCount : vi
    const [dInX, dInY] = dirs[inEdge]
    const [dOutX, dOutY] = dirs[outEdge]
    const cross = dInX * dOutY - dInY * dOutX // >0 left turn, <0 right turn, ~0 straight
    if (Math.abs(cross) < 1e-9) continue // collinear: the segment quads already meet flush.

    const outerSign = cross > 0 ? 1 : -1
    const p = points[vi]
    const [inNx, inNy] = norms[inEdge]
    const [outNx, outNy] = norms[outEdge]
    const outerIn = { x: p.x + inNx * s * outerSign, y: p.y + inNy * s * outerSign }
    const outerOut = { x: p.x + outNx * s * outerSign, y: p.y + outNy * s * outerSign }
    const innerIn = { x: p.x - inNx * s * outerSign, y: p.y - inNy * s * outerSign }
    const innerOut = { x: p.x - outNx * s * outerSign, y: p.y - outNy * s * outerSign }

    const pIdx = sink.vertex(p.x, p.y, color)

    // Concave side: direct fill (see the module-level note on overlap at sharp turns).
    const iInIdx = sink.vertex(innerIn.x, innerIn.y, color)
    const iOutIdx = sink.vertex(innerOut.x, innerOut.y, color)
    sink.triangle(pIdx, iInIdx, iOutIdx)

    // Convex side: miter (falling back to bevel past the limit), round, or bevel.
    if (join === 'miter') {
      const bisector = normalize(inNx * outerSign + outNx * outerSign, inNy * outerSign + outNy * outerSign)
      const cosHalf = bisector[0] * inNx * outerSign + bisector[1] * inNy * outerSign
      const miterRatio = cosHalf > 1e-6 ? 1 / cosHalf : Infinity
      if (miterRatio <= miterLimit) {
        const miterLen = s * miterRatio
        const mIdx = sink.vertex(p.x + bisector[0] * miterLen, p.y + bisector[1] * miterLen, color)
        const oInIdx = sink.vertex(outerIn.x, outerIn.y, color)
        const oOutIdx = sink.vertex(outerOut.x, outerOut.y, color)
        sink.triangle(pIdx, oInIdx, mIdx)
        sink.triangle(pIdx, mIdx, oOutIdx)
        continue
      }
      // Past the miter limit: fall through to a bevel.
    }

    if (join === 'round') {
      const a0 = Math.atan2(outerIn.y - p.y, outerIn.x - p.x)
      let a1 = Math.atan2(outerOut.y - p.y, outerOut.x - p.x)
      let sweep = a1 - a0
      while (sweep > Math.PI) sweep -= TWO_PI
      while (sweep < -Math.PI) sweep += TWO_PI
      const steps = Math.max(1, Math.ceil((Math.abs(sweep) / Math.PI) * roundSegments))
      const oInIdx = sink.vertex(outerIn.x, outerIn.y, color)
      emitArc(sink, color, p, s, a0, sweep, steps, pIdx, oInIdx)
      continue
    }

    // bevel (default, and the miter-limit fallback)
    const oInIdx = sink.vertex(outerIn.x, outerIn.y, color)
    const oOutIdx = sink.vertex(outerOut.x, outerOut.y, color)
    sink.triangle(pIdx, oInIdx, oOutIdx)
  }

  // --- caps (open paths only) -------------------------------------------------------
  if (!closed) {
    // Start cap: outward = reverse of the first edge's direction, i.e. the negated normal.
    strokeCap(sink, color, points[0], [-norms[0][0], -norms[0][1]], s, cap, roundSegments)
    // End cap: outward = the last edge's own forward direction.
    strokeCap(sink, color, points[n - 1], norms[segCount - 1], s, cap, roundSegments)
  }
}

/** Strokes several independent contours (e.g. an outer boundary plus hole loops). */
export function strokeContours(contours: readonly Contour[], sink: MeshSink, options: StrokeOptions): void {
  for (const contour of contours) {
    strokePolyline(contour.points, sink, { ...options, closed: contour.closed ?? options.closed })
  }
}
