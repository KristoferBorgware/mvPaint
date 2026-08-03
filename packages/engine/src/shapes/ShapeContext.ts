// The drawing context a CustomShape describes itself into: a path builder that produces
// mesh geometry instead of pixels.
//
// The vocabulary is the one everyone already has in their fingers - beginPath, moveTo,
// lineTo, curves, arcs, closePath, then fill() and stroke() to commit what has been built:
//
//   ctx.beginPath()
//   ctx.moveTo(-100, -40)
//   ctx.lineTo(0, 60)
//   ctx.lineTo(100, -40)
//   ctx.closePath()
//   ctx.fill()
//   ctx.stroke()
//
// What it does with that is not what a 2D canvas does with it. Nothing is rasterized and
// there is no pixel buffer: closed subpaths are triangulated (outer rings with their holes,
// same as a Path node), open ones are meshed into stroke ribbons by the shared stroker, and
// the result is a list of triangles in the shape's own local space. That geometry is built
// once and cached, then drawn every frame by the mesh lane like any other shape - so a
// custom shape costs a rebuild when its OUTLINE changes and nothing at all when it merely
// moves, turns, scales or gets recoloured.
//
// Three differences follow from that, and they are the whole of what you need to hold in
// mind coming from an immediate-mode API:
//
//   - Coordinates are LOCAL and y-up. The shape's own origin is (0, 0) and lands wherever
//     the node's x/y put it, and a larger y is further UP the screen. There is no transform
//     stack here because the node already has one, and a scene graph above it.
//   - Order is painter order WITHIN the shape, not depth. Every part of one custom shape
//     shares the node's single zIndex; a later fill() covers an earlier one, and that is as
//     much ordering as there is. Two things that must interleave with other objects are two
//     nodes.
//   - Style is per SEGMENT, not per pixel. See style() below.
//
// SEGMENTS AND THEIR PROPERTIES. style() sets the paint and stroke properties used from that
// point in the description onwards, and every segment remembers the style that was current
// when it was added. So a single continuous outline can change colour or thickness partway
// along without being split into separate nodes:
//
//   ctx.moveTo(0, 0)
//   ctx.lineTo(80, 0)                       // drawn in the shape's own stroke
//   ctx.style({ stroke: 'crimson', strokeWidth: 12 })
//   ctx.lineTo(160, 60)                     // drawn in crimson, thicker
//   ctx.stroke()
//
// Each distinct paint becomes one material record on the shape (see Shape.materials()), and
// the vertices of the segments using it name it - the same mechanism that lets a run of
// styled text carry its own colours. Changing only a GEOMETRIC property (strokeWidth, join,
// cap, miter limit) does not add a record, because that difference is already baked into the
// triangles.
//
// A run of segments sharing a style is stroked as one polyline, so joins inside it are
// proper joins; where the style changes the two runs meet end to end and each gets its own
// cap. With round caps that seam is invisible, which is why a multi-coloured outline
// usually wants them.
//
// A FILL has no segments - it is a region, not a boundary - so fill() paints the whole
// current path with the style current at the moment it is called.

import { parseColor, parseStops } from '../render/color'
import type {
  ColorInput,
  ColorStopInput,
  FillPriority,
  GradientStop,
  MeshMaterial,
  Point2,
} from '../render/meshFormat'
import type { LineCap, LineJoin } from '../render/stroke'
import { classifyContours } from '../render/contours'
import { flattenCubic, flattenPathData, flattenQuadratic } from '../svg/flattenPath'
import { triangulateGroup, type Triangulation } from '../svg/triangulate'
import type { Shape } from './Shape'

/**
 * The properties a segment can carry. Everything omitted keeps whatever was in force -
 * ultimately the shape's own fill/stroke settings, which is what an unstyled description
 * draws in.
 *
 * The paint half (fill, stroke, gradients) becomes a material record on the shape; the
 * stroke-geometry half (width, join, cap, miter limit) is baked into the ribbon triangles.
 * Colours take either form here, the same as everywhere else - a string or the tuple.
 */
export interface SegmentStyle {
  fill?: ColorInput
  fillPriority?: FillPriority
  fillLinearGradientStartPoint?: Point2
  fillLinearGradientEndPoint?: Point2
  fillLinearGradientColorStops?: readonly ColorStopInput[]
  fillRadialGradientStartPoint?: Point2
  fillRadialGradientStartRadius?: number
  fillRadialGradientEndPoint?: Point2
  fillRadialGradientEndRadius?: number
  fillRadialGradientColorStops?: readonly ColorStopInput[]
  stroke?: ColorInput
  /** Stroke width in the shape's local units; 0 means this run is not stroked. */
  strokeWidth?: number
  lineJoin?: LineJoin
  lineCap?: LineCap
  miterLimit?: number
}

/** The keys that change how a segment is PAINTED, and so need their own material record. */
const PAINT_KEYS = [
  'fill',
  'fillPriority',
  'fillLinearGradientStartPoint',
  'fillLinearGradientEndPoint',
  'fillLinearGradientColorStops',
  'fillRadialGradientStartPoint',
  'fillRadialGradientStartRadius',
  'fillRadialGradientEndPoint',
  'fillRadialGradientEndRadius',
  'fillRadialGradientColorStops',
  'stroke',
] as const satisfies readonly (keyof SegmentStyle)[]

/**
 * One committed piece of a description: a triangulated region, or a stroked run of
 * segments. `material` indexes the shape's materials() list.
 */
export type DrawOp =
  | { readonly kind: 'fill'; readonly material: number; readonly regions: readonly Triangulation[] }
  | {
      readonly kind: 'stroke'
      readonly material: number
      readonly points: readonly Point2[]
      readonly closed: boolean
      readonly width: number
      readonly join: LineJoin
      readonly cap: LineCap
      readonly miterLimit: number
    }

/** What one describe() run produced: what to draw, and the materials it draws in. */
export interface ShapeDescription {
  readonly ops: readonly DrawOp[]
  readonly materials: readonly MeshMaterial[]
}

/** A style with its paint resolved to a material index and its stroke settings concrete. */
interface ResolvedStyle {
  material: number
  strokeWidth: number
  lineJoin: LineJoin
  lineCap: LineCap
  miterLimit: number
}

/** A run of points; `styles[i]` is the style of the segment ending at `points[i]`. */
interface SubPath {
  points: Point2[]
  styles: ResolvedStyle[]
  closed: boolean
}

const DEFAULT_TOLERANCE = 0.25

/**
 * How many line segments approximate `sweep` radians of a circle of this radius without
 * ever deviating from it by more than `tolerance`. Straight from the sagitta: a chord
 * subtending angle a on radius r sits r(1 - cos(a/2)) inside the arc.
 */
function arcSteps(radius: number, sweep: number, tolerance: number): number {
  const r = Math.abs(radius)
  if (r <= tolerance) return 2
  const maxAngle = 2 * Math.acos(1 - tolerance / r)
  return Math.max(2, Math.ceil(Math.abs(sweep) / maxAngle))
}

function samePoint(a: Point2, b: Point2): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9
}

export class ShapeContext {
  private readonly tolerance: number
  private readonly materialList: MeshMaterial[]
  private readonly ops: DrawOp[] = []

  private readonly subpaths: SubPath[] = []
  private open: SubPath | null = null
  /** Where the next segment starts. Survives closePath(), like the current point does. */
  private cursor: Point2 = { x: 0, y: 0 }

  private style_: ResolvedStyle

  /**
   * @param shape  the node being described - its own fill/stroke settings are the style
   *               every description starts in, and its material record is index 0.
   */
  constructor(
    private readonly shape: Shape,
    tolerance = DEFAULT_TOLERANCE,
  ) {
    this.tolerance = tolerance > 0 ? tolerance : DEFAULT_TOLERANCE
    // Index 0 is the shape itself, exactly as for any other single-material shape. A
    // description that never calls style() therefore ends with the one record it would
    // have had anyway.
    this.materialList = [shape]
    this.style_ = {
      material: 0,
      strokeWidth: shape.strokeWidth,
      lineJoin: shape.lineJoin,
      lineCap: shape.lineCap,
      miterLimit: shape.miterLimit,
    }
  }

  // --- style ------------------------------------------------------------------------------

  /**
   * Sets the properties used by everything added AFTER this call. Segments already added
   * keep the style they were added in, which is what makes a multi-coloured outline a
   * single shape rather than several.
   *
   * A patch that touches the paint allocates one material record; a patch that only changes
   * stroke geometry does not.
   */
  style(patch: SegmentStyle): this {
    const touchesPaint = PAINT_KEYS.some((key) => patch[key] !== undefined)
    const next: ResolvedStyle = {
      material: this.style_.material,
      strokeWidth: patch.strokeWidth ?? this.style_.strokeWidth,
      lineJoin: patch.lineJoin ?? this.style_.lineJoin,
      lineCap: patch.lineCap ?? this.style_.lineCap,
      miterLimit: patch.miterLimit ?? this.style_.miterLimit,
    }

    if (touchesPaint) {
      next.material = this.materialList.length
      this.materialList.push(this.buildMaterial(patch))
    } else if (
      next.strokeWidth === this.style_.strokeWidth &&
      next.lineJoin === this.style_.lineJoin &&
      next.lineCap === this.style_.lineCap &&
      next.miterLimit === this.style_.miterLimit
    ) {
      // Nothing actually changed - keep the same style object so the runs either side of
      // this call stay one run and keep their joins.
      return this
    }

    this.style_ = next
    return this
  }

  /** The style the patch describes, resolved against the CURRENT one and then the shape. */
  private buildMaterial(patch: SegmentStyle): MeshMaterial {
    const base = this.materialList[this.style_.material]
    const stops = (
      value: readonly ColorStopInput[] | undefined,
      fallback: readonly GradientStop[],
    ): readonly GradientStop[] => (value ? parseStops(value) : fallback)

    return {
      fillPriority: patch.fillPriority ?? base.fillPriority,
      fill: patch.fill !== undefined ? parseColor(patch.fill) : base.fill,
      stroke: patch.stroke !== undefined ? parseColor(patch.stroke) : base.stroke,
      fillLinearGradientStartPoint: patch.fillLinearGradientStartPoint ?? base.fillLinearGradientStartPoint,
      fillLinearGradientEndPoint: patch.fillLinearGradientEndPoint ?? base.fillLinearGradientEndPoint,
      fillLinearGradientColorStops: stops(patch.fillLinearGradientColorStops, base.fillLinearGradientColorStops),
      fillRadialGradientStartPoint: patch.fillRadialGradientStartPoint ?? base.fillRadialGradientStartPoint,
      fillRadialGradientStartRadius: patch.fillRadialGradientStartRadius ?? base.fillRadialGradientStartRadius,
      fillRadialGradientEndPoint: patch.fillRadialGradientEndPoint ?? base.fillRadialGradientEndPoint,
      fillRadialGradientEndRadius: patch.fillRadialGradientEndRadius ?? base.fillRadialGradientEndRadius,
      fillRadialGradientColorStops: stops(patch.fillRadialGradientColorStops, base.fillRadialGradientColorStops),
    }
  }

  // --- path building ----------------------------------------------------------------------

  /** Discards the current path. Anything already committed with fill()/stroke() stays. */
  beginPath(): this {
    this.subpaths.length = 0
    this.open = null
    return this
  }

  /** Starts a new subpath at (x, y) without connecting it to the last one. */
  moveTo(x: number, y: number): this {
    this.cursor = { x, y }
    this.open = { points: [{ x, y }], styles: [this.style_], closed: false }
    this.subpaths.push(this.open)
    return this
  }

  lineTo(x: number, y: number): this {
    this.push({ x, y })
    return this
  }

  /** A quadratic Bézier from the current point, flattened to within `tolerance`. */
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): this {
    const from = this.ensureOpen()
    const out: Point2[] = []
    flattenQuadratic(from.x, from.y, cx, cy, x, y, this.tolerance, out)
    for (const p of out) this.push(p)
    return this
  }

  /** A cubic Bézier from the current point, flattened to within `tolerance`. */
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
    const from = this.ensureOpen()
    const out: Point2[] = []
    flattenCubic(from.x, from.y, c1x, c1y, c2x, c2y, x, y, this.tolerance, out)
    for (const p of out) this.push(p)
    return this
  }

  /**
   * An arc of a circle, joined to the current point by a straight segment (as canvas does).
   *
   * Angles are radians measured from +x. The scene is y-up, so an INCREASING angle turns
   * counter-clockwise on screen - hence the default direction; pass `counterclockwise:
   * false` to sweep the other way round.
   */
  arc(
    cx: number,
    cy: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = true,
  ): this {
    return this.ellipse(cx, cy, radius, radius, 0, startAngle, endAngle, counterclockwise)
  }

  /** As arc(), for an ellipse with its own radii turned by `rotation` radians. */
  ellipse(
    cx: number,
    cy: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
    counterclockwise = true,
  ): this {
    let sweep = endAngle - startAngle
    const full = Math.PI * 2
    if (counterclockwise) {
      // Normalise into (0, 2π]: equal angles mean a whole turn, which is how a circle is
      // written (0 to 2π, or 0 to 0).
      while (sweep <= 0) sweep += full
      if (sweep > full) sweep = full
    } else {
      while (sweep >= 0) sweep -= full
      if (sweep < -full) sweep = -full
    }

    const steps = arcSteps(Math.max(Math.abs(radiusX), Math.abs(radiusY)), sweep, this.tolerance)
    const cos = Math.cos(rotation)
    const sin = Math.sin(rotation)
    for (let i = 0; i <= steps; i++) {
      const a = startAngle + (sweep * i) / steps
      const ex = Math.cos(a) * radiusX
      const ey = Math.sin(a) * radiusY
      const p = { x: cx + ex * cos - ey * sin, y: cy + ex * sin + ey * cos }
      // The first point is where the arc BEGINS, so it joins the current point with a
      // straight segment - or opens a new subpath if there isn't one.
      if (i === 0 && !this.open) this.moveTo(p.x, p.y)
      else this.push(p)
    }
    return this
  }

  /** A whole circle as its own closed subpath. */
  circle(cx: number, cy: number, radius: number): this {
    this.open = null // its own subpath, never joined to whatever came before
    this.ellipse(cx, cy, radius, radius, 0, 0, Math.PI * 2)
    return this.closePath()
  }

  /**
   * An axis-aligned rectangle as its own closed subpath, hanging from (x, y) and extending
   * right and DOWNWARD - the same corner a Rect node is placed by, so the two agree in a
   * y-up scene.
   */
  rect(x: number, y: number, width: number, height: number): this {
    this.moveTo(x, y)
    this.push({ x: x + width, y })
    this.push({ x: x + width, y: y - height })
    this.push({ x, y: y - height })
    return this.closePath()
  }

  /**
   * Appends SVG path data as one or more subpaths, in the shape's own coordinates.
   *
   * The points land exactly as written, so data authored for SVG's y-down space comes out
   * mirrored; pass `matrix` (a 2x3 [a,b,c,d,e,f]) to flip or place it - `[1,0,0,-1,0,0]`
   * turns an SVG-space outline the right way up.
   */
  pathData(d: string, options: { matrix?: [number, number, number, number, number, number] } = {}): this {
    for (const contour of flattenPathData(d, { tolerance: this.tolerance, matrix: options.matrix })) {
      if (contour.points.length === 0) continue
      const [first, ...rest] = contour.points
      this.moveTo(first.x, first.y)
      for (const p of rest) this.push(p)
      if (contour.closed) this.closePath()
    }
    return this
  }

  /**
   * Closes the current subpath with a segment back to where it started, and ends it. The
   * next drawing command begins a new subpath from that same start point, as canvas does.
   */
  closePath(): this {
    const sub = this.open
    if (!sub || sub.points.length < 2) return this
    const start = sub.points[0]
    if (!samePoint(sub.points[sub.points.length - 1], start)) {
      sub.points.push({ x: start.x, y: start.y })
      sub.styles.push(this.style_)
    }
    sub.closed = true
    this.open = null
    this.cursor = { x: start.x, y: start.y }
    return this
  }

  private ensureOpen(): Point2 {
    if (!this.open) this.moveTo(this.cursor.x, this.cursor.y)
    return this.cursor
  }

  private push(p: Point2): void {
    if (!this.open) {
      // Drawing with no subpath open starts one. Where it starts depends on whether there
      // is a current point to start FROM: after a closePath there is (the point the closed
      // subpath began at, so the next run carries on from the same place), but at the very
      // beginning of a path there is not - and beginning at an implied origin would draw a
      // line from (0, 0) that nobody asked for.
      if (this.subpaths.length === 0) {
        this.moveTo(p.x, p.y)
        return
      }
      this.moveTo(this.cursor.x, this.cursor.y)
    }
    const sub = this.open as SubPath
    // A segment of no length is not a segment: it contributes a degenerate quad to the
    // stroker and a duplicate ring point to earcut. Curve flattening and full-turn arcs
    // both produce them at the seams, so they are dropped here rather than at every caller.
    if (samePoint(sub.points[sub.points.length - 1], p)) return
    sub.points.push(p)
    sub.styles.push(this.style_)
    this.cursor = p
  }

  // --- committing -------------------------------------------------------------------------

  /**
   * Triangulates the current path and paints it in the current style.
   *
   * Every subpath with three or more points contributes, closed or not - an unclosed one is
   * filled as if it were closed, which is the only reading that makes sense for a region.
   * Nesting decides holes: a subpath inside another cuts a hole in it, one inside that is
   * solid again.
   */
  fill(): this {
    const rings = this.subpaths
      .map((sub) => ({ points: this.ringOf(sub), closed: true }))
      .filter((c) => c.points.length >= 3)
    if (rings.length === 0) return this

    const regions = classifyContours(rings).map(triangulateGroup)
    if (regions.length > 0) {
      this.ops.push({ kind: 'fill', material: this.style_.material, regions })
    }
    return this
  }

  /**
   * Strokes the current path, each segment in the style it was added in.
   *
   * A subpath whose segments all share one style is stroked as a single contour, so a closed
   * one is a continuous ring with proper joins throughout. Where the style changes, the path
   * is split there and each run stroked on its own, so the two meet end to end with a cap
   * each - see the file header.
   */
  stroke(): this {
    for (const sub of this.subpaths) {
      if (sub.points.length < 2) continue

      const uniform = sub.styles.every((s, i) => i === 0 || s === sub.styles[1])
      if (uniform) {
        const style = sub.styles[1]
        this.emitStroke(sub.closed ? this.ringOf(sub) : sub.points, sub.closed, style)
        continue
      }

      // Mixed: walk the segments and cut a run wherever the style changes. A closed subpath
      // already carries its closing segment as a repeated first point, so the wrap needs no
      // special case here - it is simply the last run.
      let runStart = 0
      for (let i = 1; i <= sub.points.length; i++) {
        const ends = i === sub.points.length || sub.styles[i] !== sub.styles[runStart + 1]
        if (!ends) continue
        this.emitStroke(sub.points.slice(runStart, i), false, sub.styles[runStart + 1])
        runStart = i - 1
      }
    }
    return this
  }

  /** fill() then stroke(), the two-line case written once. */
  fillAndStroke(): this {
    return this.fill().stroke()
  }

  private emitStroke(points: readonly Point2[], closed: boolean, style: ResolvedStyle): void {
    if (points.length < 2 || style.strokeWidth <= 0) return
    this.ops.push({
      kind: 'stroke',
      material: style.material,
      points: points.slice(),
      closed,
      width: style.strokeWidth,
      join: style.lineJoin,
      cap: style.lineCap,
      miterLimit: style.miterLimit,
    })
  }

  /** A subpath's points as a ring: no repeated closing point, which earcut would trip on. */
  private ringOf(sub: SubPath): Point2[] {
    const points = sub.points
    const last = points.length - 1
    if (points.length > 1 && samePoint(points[last], points[0])) return points.slice(0, last)
    return points.slice()
  }

  /** Everything this run described. Called by CustomShape; a description never calls it. */
  finish(): ShapeDescription {
    return { ops: this.ops, materials: this.materialList }
  }

  /** The shape being described, for a description that wants to read its own properties. */
  get node(): Shape {
    return this.shape
  }
}
