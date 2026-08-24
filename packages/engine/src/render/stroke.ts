// General-purpose contour stroker. Offsets an ordered point list (open or closed) to each
// side and meshes the resulting ribbon, with Canvas2D-style joins (miter/round/bevel) and
// caps (butt/round/square). This is the one engine every stroked shape should call into - a
// rectangle's 4 corners, a circle's rim samples, a hand-authored polyline, or a loop
// extracted from a triangulated SVG path.
//
// HOW FAR TO EACH SIDE is `align` (see StrokeAlign): half the width both ways for the
// classic centred stroke, or the whole width on one side for an inside/outside one. The
// two offsets are the only thing that differs - every join, miter, bevel and cap below
// reads them rather than a single half-width, so there is one stroker rather than three.
//
// A mesh with holes is just several independent closed contours (the outer boundary plus
// one loop per hole); strokeContours() strokes each one separately. A CENTRED stroke does
// not care about winding or which loop is a hole - the two offsets are equal, so no side
// has to be named. An inside/outside one cares about both, since it has to know where the
// material is: see strokeContours.
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

import type { Vector2Like } from '../math/Vector2'
import { dashContour, normalizeDashPattern } from './dash'
import type { MeshSink } from './meshFormat'
import { nestingDepths, signedArea } from './contours'

export type LineJoin = 'miter' | 'round' | 'bevel'
export type LineCap = 'butt' | 'round' | 'square'

/**
 * Which way a stroke expands from the path it follows.
 *
 * 'center' (the default, and what every stroke did before this existed) straddles the path,
 * half the width to each side - Canvas2D's only behaviour, and SVG's. The other two put the
 * whole ribbon on one side: 'inside' eats into the shape, so the outer edge of the stroke is
 * the shape's own outline and the node does not grow; 'outside' grows the shape by the full
 * width, leaving the fill untouched.
 *
 * The distinction is only meaningful where there IS an inside - a closed contour. An open path
 * strokes about its centre whatever this says, because "which side is the shape" has no answer
 * for a line.
 *
 * It changes the geometry, so it changes what the node measures: a 100-wide rect with a 20-wide
 * stroke is 120 across centred, 140 outside and 100 inside. That is the point of it - see
 * Shape.strokeAlign.
 */
export type StrokeAlign = 'center' | 'inside' | 'outside'

export interface StrokeOptions {
  width: number
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
  /**
   * Which side of the contour the ribbon expands onto. Default 'center'. Ignored on an open
   * path, which has no inside - see StrokeAlign.
   *
   * Given to strokeContours(), this is read as "inside/outside THE SHAPE", not "inside this
   * particular ring": a hole's ring is stroked the other way round, so the ribbon lands on the
   * material either way (see strokeContours).
   */
  align?: StrokeAlign
  /**
   * Alternating on/off lengths, in the space the points are given in. Omitted, or empty, draws
   * a solid line. An odd-length list is doubled - see normalizeDashPattern.
   *
   * The pattern is measured along the path rather than per edge, so a dash keeps its length
   * around a corner, and a dash that spans one still gets a proper join.
   */
  dash?: readonly number[]
  /** How far into the pattern the path starts. Default 0. */
  dashOffset?: number
  /**
   * The transform this ribbon will be seen through, when `width` is meant to survive it -
   * see StrokeGauge and Shape.strokeScaleEnabled. Omitted (the usual case), the ribbon is
   * `width` wide in the space the points are given in, and whatever transform is applied
   * later scales it along with everything else.
   */
  gauge?: StrokeGauge
}

/**
 * The linear (2x2) part of a transform a stroke is to be measured AFTER, rather than before.
 *
 * A stroke width is normally a local-space measurement like any other coordinate, so a node
 * at scale 3 gets a ribbon three times as thick - correct for a drawing, wrong for an outline
 * that is meant to stay one pixel while the thing it outlines is resized. Given a gauge, the
 * stroker measures the width where the gauge puts it and hands back local-space triangles
 * that arrive at exactly that width once the transform is applied.
 *
 * Written in the column-major convention the rest of the engine uses, so for a world matrix
 * `m` it is `{ a: m[0], b: m[1], c: m[4], d: m[5] }`: x' = a·x + c·y, y' = b·x + d·y. The
 * translation is deliberately absent, because a stroke is made of offsets and offsets do not
 * translate - only the linear part can change a ribbon's shape.
 *
 * Non-uniform scale and skew are handled exactly, not approximated: it is the whole reason
 * this is a matrix and not a single number. Dividing the width by an average scale would give
 * an outline that is too thick on one axis and too thin on the other, which is precisely the
 * case - dragging one edge handle of a selection - that the feature exists for.
 */
export interface StrokeGauge {
  a: number
  b: number
  c: number
  d: number
}

export interface Contour {
  points: readonly Vector2Like[]
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
  center: Vector2Like,
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
    const idx = sink.vertex(x, y, false)
    sink.triangle(hubIdx, prevIdx, idx)
    prevIdx = idx
  }
}

/**
 * Emits a round or square cap at `p`, given the OUTWARD-facing side normal there and how far
 * the ribbon reaches to each side.
 *
 * The two reaches are equal for every centred stroke, which is every open path a caller writes
 * by hand. They differ for a dash cut from an inside- or outside-aligned ring, which is a
 * one-sided ribbon - so the cap is built about the MIDDLE of the ribbon's end edge rather than
 * about the path point, and is half the ribbon's total width across. Both reduce to the
 * symmetric case exactly when the reaches match.
 */
function strokeCap(
  sink: MeshSink,
  p: Vector2Like,
  normal: [number, number],
  sPlus: number,
  sMinus: number,
  cap: LineCap,
  roundSegments: number,
): void {
  if (cap === 'butt') return // the segment quad already ends flush at p.

  const [nx, ny] = normal
  const p0 = { x: p.x + nx * sPlus, y: p.y + ny * sPlus }
  const p1 = { x: p.x - nx * sMinus, y: p.y - ny * sMinus }
  const reach = (sPlus + sMinus) / 2
  // Outward direction = normal rotated +90°.
  const dx = -ny
  const dy = nx

  if (cap === 'square') {
    const e0 = { x: p0.x + dx * reach, y: p0.y + dy * reach }
    const e1 = { x: p1.x + dx * reach, y: p1.y + dy * reach }
    const i0 = sink.vertex(p0.x, p0.y, false)
    const i1 = sink.vertex(p1.x, p1.y, false)
    const ie0 = sink.vertex(e0.x, e0.y, false)
    const ie1 = sink.vertex(e1.x, e1.y, false)
    sink.triangle(i0, ie0, ie1)
    sink.triangle(i0, ie1, i1)
    return
  }

  // round: a half-circle from +normal to -normal, sweeping +π (which always passes
  // through the outward direction, since outward is exactly +90° from +normal).
  const hub = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
  const hubIdx = sink.vertex(hub.x, hub.y, false)
  const firstIdx = sink.vertex(p0.x, p0.y, false)
  const startAngle = Math.atan2(ny, nx)
  emitArc(sink, hub, reach, startAngle, Math.PI, Math.max(2, roundSegments), hubIdx, firstIdx)
}

/**
 * Strokes a single contour into `sink`. Points are consumed as given (already in the
 * space the shape wants to draw in - typically its own local space, pre-transform).
 */
export function strokePolyline(points: readonly Vector2Like[], sink: MeshSink, options: StrokeOptions): void {
  // A gauged stroke is the ordinary one, done somewhere else and brought back. Push the path
  // through the transform, stroke it THERE - where the width is the width that was asked for,
  // and where the joins, the caps and the miter limit are all measured in the units they are
  // meant to be measured in - then map every vertex back through the inverse. What returns is
  // local-space geometry that becomes an exactly even ribbon once the transform is applied,
  // for any invertible transform: non-uniform scale and skew included, with round joins
  // correctly coming back as the ellipse arcs they have to be.
  //
  // Doing it this way rather than by adjusting the width means there is ONE stroker, and this
  // is a wrapper around it: nothing below can disagree with the ungauged case, because it is
  // the ungauged case.
  if (options.gauge) {
    const inverse = invertGauge(options.gauge)
    // Singular - some axis has been scaled to nothing. There is no ribbon to draw and no
    // width that would make one, so drawing nothing is the answer rather than a division by
    // zero's worth of NaN geometry.
    if (!inverse) return
    const forward = options.gauge
    strokePolyline(
      points.map((p) => applyGauge(forward, p)),
      {
        vertex: (x, y, isFill, material) => {
          const local = applyGauge(inverse, { x, y })
          return sink.vertex(local.x, local.y, isFill, material)
        },
        triangle: (a, b, c) => sink.triangle(a, b, c),
      },
      { ...options, gauge: undefined },
    )
    return
  }

  // A dashed stroke is this same function run over each drawn piece, so nothing below knows a
  // dash from an ordinary open path. The one thing the pieces cannot work out for themselves is
  // which side of the line the ribbon belongs on: `align` is answered from a RING's winding, and
  // a dash is an open path with no enclosed side, so the sides are resolved once from the whole
  // contour here and carried into each piece.
  const pattern = normalizeDashPattern(options.dash)
  if (pattern) {
    const wasClosed = options.closed ?? true
    const sides = ribbonSides(points, wasClosed, options.width, options.align ?? 'center')
    for (const piece of dashContour(points, wasClosed, pattern, options.dashOffset ?? 0)) {
      strokeRun(piece, sink, { ...options, closed: false, dash: undefined }, sides)
    }
    return
  }

  strokeRun(points, sink, options, undefined)
}

/** How far the ribbon reaches along +normal and along -normal. See ribbonSides. */
interface RibbonSides {
  plus: number
  minus: number
}

/**
 * Equal halves for a centred stroke; the whole width on one side for the other two, which is
 * all "inside" and "outside" mean geometrically - every join, miter and cap then falls out
 * unchanged.
 *
 * Which side is which comes from the ring's own winding. perp() gives the RIGHT normal, so a
 * counter-clockwise ring (positive shoelace area) encloses the -normal side and a clockwise one
 * the +normal side. An open path has no enclosed side at all, so it stays centred.
 */
function ribbonSides(
  points: readonly Vector2Like[],
  closed: boolean,
  width: number,
  align: StrokeAlign,
): RibbonSides {
  const half = width / 2
  if (align === 'center' || !closed) return { plus: half, minus: half }
  const enclosedOnMinus = signedArea(points) > 0
  const onPlus = (align === 'outside') === enclosedOnMinus
  return onPlus ? { plus: width, minus: 0 } : { plus: 0, minus: width }
}

/**
 * One unbroken run of ribbon. `sides` overrides what the run would work out for itself, and is
 * given only by the dashing above, where the answer belongs to the contour the run came from.
 */
function strokeRun(
  points: readonly Vector2Like[],
  sink: MeshSink,
  options: StrokeOptions,
  sides: RibbonSides | undefined,
): void {
  const {
    width,
    closed = true,
    join = 'miter',
    cap = 'butt',
    miterLimit = 10,
    roundSegments = 8,
    align = 'center',
  } = options
  const n = points.length
  if (n < 2 || width <= 0) return

  const segCount = closed ? n : n - 1
  if (segCount < 1) return

  const { plus: sPlus, minus: sMinus } = sides ?? ribbonSides(points, closed, width, align)

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
    const ia0 = sink.vertex(a.x + nx * sPlus, a.y + ny * sPlus, false)
    const ia1 = sink.vertex(a.x - nx * sMinus, a.y - ny * sMinus, false)
    const ib0 = sink.vertex(b.x + nx * sPlus, b.y + ny * sPlus, false)
    const ib1 = sink.vertex(b.x - nx * sMinus, b.y - ny * sMinus, false)
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
    // The turn decides which of the two offsets this joint's convex side reaches by: bulging
    // toward +normal it is sPlus, toward -normal it is sMinus. For a centred stroke they are
    // the same number and this is the arithmetic it always did.
    const sConvex = outerSign > 0 ? sPlus : sMinus
    const sConcave = outerSign > 0 ? sMinus : sPlus
    const outerIn = { x: p.x + inNx * sConvex * outerSign, y: p.y + inNy * sConvex * outerSign }
    const outerOut = { x: p.x + outNx * sConvex * outerSign, y: p.y + outNy * sConvex * outerSign }
    const innerIn = { x: p.x - inNx * sConcave * outerSign, y: p.y - inNy * sConcave * outerSign }
    const innerOut = { x: p.x - outNx * sConcave * outerSign, y: p.y - outNy * sConcave * outerSign }

    const pIdx = sink.vertex(p.x, p.y, false)

    // Concave side: direct fill (see the module-level note on overlap at sharp turns).
    const iInIdx = sink.vertex(innerIn.x, innerIn.y, false)
    const iOutIdx = sink.vertex(innerOut.x, innerOut.y, false)
    sink.triangle(pIdx, iInIdx, iOutIdx)

    // Convex side: miter (falling back to bevel past the limit), round, or bevel.
    if (join === 'miter') {
      const bisector = normalize(inNx * outerSign + outNx * outerSign, inNy * outerSign + outNy * outerSign)
      const cosHalf = bisector[0] * inNx * outerSign + bisector[1] * inNy * outerSign
      const miterRatio = cosHalf > 1e-6 ? 1 / cosHalf : Infinity
      if (miterRatio <= miterLimit) {
        const miterLen = sConvex * miterRatio
        const mIdx = sink.vertex(p.x + bisector[0] * miterLen, p.y + bisector[1] * miterLen, false)
        const oInIdx = sink.vertex(outerIn.x, outerIn.y, false)
        const oOutIdx = sink.vertex(outerOut.x, outerOut.y, false)
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
      const oInIdx = sink.vertex(outerIn.x, outerIn.y, false)
      emitArc(sink, p, sConvex, a0, sweep, steps, pIdx, oInIdx)
      continue
    }

    // bevel (default, and the miter-limit fallback)
    const oInIdx = sink.vertex(outerIn.x, outerIn.y, false)
    const oOutIdx = sink.vertex(outerOut.x, outerOut.y, false)
    sink.triangle(pIdx, oInIdx, oOutIdx)
  }

  // --- caps (open paths only) -------------------------------------------------------
  if (!closed) {
    // Start cap: outward = reverse of the first edge's direction, i.e. the negated normal. The
    // two reaches swap with the normal, so the cap sits on the same side of the path the ribbon
    // does.
    strokeCap(sink, points[0], [-norms[0][0], -norms[0][1]], sMinus, sPlus, cap, roundSegments)
    // End cap: outward = the last edge's own forward direction.
    strokeCap(sink, points[n - 1], norms[segCount - 1], sPlus, sMinus, cap, roundSegments)
  }
}

/**
 * Strokes several independent contours (e.g. an outer boundary plus hole loops).
 *
 * For a centred stroke that is simply a loop. For an inside/outside one it is not, because
 * "inside" is a statement about the SHAPE and a hole is wound against the outline that
 * contains it: the material a hole's stroke should eat into lies OUTSIDE the hole's own ring.
 * So hole rings are stroked with the alignment flipped, and the ribbon lands on the fill in
 * both cases - a donut with an inside stroke keeps both of its silhouettes exactly.
 *
 * Which rings are holes is the even-odd nesting question (see contours.ts), asked here only
 * when the answer can matter. It is asked of the rings as they were written, whichever rule the
 * fill is being read by: a stroke follows the outline, and the outline does not move.
 */
export function strokeContours(contours: readonly Contour[], sink: MeshSink, options: StrokeOptions): void {
  const align = options.align ?? 'center'
  const closedOf = (contour: Contour) => contour.closed ?? options.closed ?? true

  let holes: Set<number> | null = null
  if (align !== 'center' && contours.length > 1) {
    // Only closed rings with area participate in nesting, exactly as they do in the fill.
    const indices: number[] = []
    const rings: (readonly Vector2Like[])[] = []
    contours.forEach((contour, i) => {
      if (closedOf(contour) && contour.points.length >= 3) {
        indices.push(i)
        rings.push(contour.points)
      }
    })
    holes = new Set<number>()
    nestingDepths(rings).forEach((depth, k) => {
      if (depth % 2 === 1) holes!.add(indices[k])
    })
  }

  contours.forEach((contour, i) => {
    strokePolyline(contour.points, sink, {
      ...options,
      closed: closedOf(contour),
      align: holes?.has(i) ? flipAlign(align) : align,
    })
  })
}

/** A hole's ring, seen from the shape: what is inside the shape is outside this ring. */
function flipAlign(align: StrokeAlign): StrokeAlign {
  return align === 'inside' ? 'outside' : align === 'outside' ? 'inside' : 'center'
}

/** x' = a·x + c·y, y' = b·x + d·y - see StrokeGauge for the convention. */
function applyGauge(g: StrokeGauge, p: Vector2Like): Vector2Like {
  return { x: g.a * p.x + g.c * p.y, y: g.b * p.x + g.d * p.y }
}

/** The inverse gauge, or null when the transform collapses a dimension. */
function invertGauge(g: StrokeGauge): StrokeGauge | null {
  const det = g.a * g.d - g.b * g.c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null
  return { a: g.d / det, b: -g.b / det, c: -g.c / det, d: g.a / det }
}

/**
 * Whether two gauges produce the SAME stroke geometry - which is a weaker question than
 * whether they are the same transform, and deliberately so.
 *
 * Stroking commutes with rotation, so a gauge and that gauge turned by any angle give byte-
 * for-byte identical triangles: `(RG)⁻¹ · stroke(RG·p)` is `G⁻¹R⁻¹ · R·stroke(G·p)`, which is
 * `G⁻¹ · stroke(G·p)`. Comparing the four numbers directly would therefore rebuild a spinning
 * keyline every frame to arrive back at the geometry it already had.
 *
 * What is left when orientation is factored out is `GᵀG` - the lengths of the two axes and
 * the angle between them, three numbers, invariant under exactly the rotations that do not
 * matter and sensitive to every scale and skew that does.
 *
 * The tolerance is relative and generous by float32 standards (the world matrix is stored as
 * float32, so a rotation alone perturbs these by ~1e-7 relative). It is still four orders of
 * magnitude tighter than any scale change a person could see, and a slow drift accumulates
 * against the gauge the geometry was BUILT with rather than against last frame's, so it
 * crosses the threshold and rebuilds rather than creeping past it unnoticed.
 */
export function sameGauge(a: StrokeGauge | undefined, b: StrokeGauge | undefined): boolean {
  if (!a || !b) return a === b
  // GᵀG, written out: |x axis|², |y axis|², and their dot product.
  const ax = a.a * a.a + a.b * a.b
  const ay = a.c * a.c + a.d * a.d
  const axy = a.a * a.c + a.b * a.d
  const bx = b.a * b.a + b.b * b.b
  const by = b.c * b.c + b.d * b.d
  const bxy = b.a * b.c + b.b * b.d
  const scale = Math.max(ax, ay, bx, by, 1)
  const tolerance = scale * 1e-5
  return Math.abs(ax - bx) <= tolerance && Math.abs(ay - by) <= tolerance && Math.abs(axy - bxy) <= tolerance
}
