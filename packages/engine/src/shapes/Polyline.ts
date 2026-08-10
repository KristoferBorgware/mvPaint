// Polyline - an open or closed path through a list of points. Points are in local space,
// positioned by the common Shape parameters (x, y, scale, rotation, offset); line style
// matches the Canvas2D API via the inherited stroke/dash/lineJoin/lineCap/miterLimit
// ('lineCap' only applies to open paths). The outline goes through the shared contour
// stroker - this is the shape that most directly exercises "any contour, with any join/cap
// style".
//
// THE POINTS ARE NOT ALWAYS THE OUTLINE. `tension` runs a Catmull-Rom spline through them and
// `bezier` reads them as cubic control points; either way the drawn outline is the flattened
// curve, and everything measured from the shape - its extent, its hit test, its length -
// measures that curve rather than the control net. See curvePoints.ts.
//
// A CLOSED POLYLINE IS A POLYGON. It emits fill triangles (ear-clipped, so concave outlines are
// fine) as well as its outline, which is what makes `fill` paint and what makes a click inside
// one hit it. An open one has no interior and emits none. Self-intersecting outlines are the
// known limit: the triangulator resolves them somehow rather than by a stated fill rule.
// Path is the shape for an outline with holes in it.

import type { Vector2Like } from '../math/Vector2'
import { shapeAttrDefaults, Shape, type ShapeOptions } from './Shape'
import { bezierPoints, smoothPoints } from './curvePoints'
import type { MeshSink } from '../render/meshFormat'
import { contourLength, pointAtLength } from '../render/arcLength'
import { strokePolyline } from '../render/stroke'
import { triangulateGroup } from '../svg/triangulate'

/**
 * A point list, as objects or as one flat `[x, y, x, y, ...]` array. The flat form is stored as
 * objects - `points` always reads back as objects - so the two are the same list written twice,
 * not two kinds of Polyline.
 */
export type PointsInput = readonly Vector2Like[] | readonly number[]

export interface PolylineOptions extends ShapeOptions {
  /** The vertices, in either form. Default empty, which draws nothing. */
  points?: PointsInput
  /** Loop back to the start (a closed contour, filled) vs. an open path with caps. Default false. */
  closed?: boolean
  /**
   * Smooths a curve through the points instead of joining them with straight lines. 0 (the
   * default) is the straight list; 1 is the uniform Catmull-Rom spline; above 1 overshoots.
   */
  tension?: number
  /** Read the points as a start point followed by groups of three cubic control points. */
  bezier?: boolean
}

/** True for a list written flat. An empty list is neither, and normalises to an empty list. */
function isFlat(points: PointsInput): points is readonly number[] {
  return points.length > 0 && typeof points[0] === 'number'
}

/**
 * The object form of a list. An object list is passed straight through rather than copied, so
 * the shape holds the caller's own array - which is what makes `line.points = line.points` the
 * no-op it reads as, and why editing one in place needs markGeometryDirty().
 */
function toPoints(points: PointsInput): Vector2Like[] {
  if (!isFlat(points)) return points as Vector2Like[]
  // A trailing odd coordinate names no point, so it is dropped rather than paired with a zero.
  const out: Vector2Like[] = []
  for (let i = 0; i + 1 < points.length; i += 2) out.push({ x: points[i], y: points[i + 1] })
  return out
}


/** See Node.attrDefaults. An empty point list draws nothing, which is the honest blank state. */
let cachedPolylineAttrDefaults: Readonly<Record<string, unknown>> | undefined

/**
 * Built on FIRST USE rather than at module load. It spreads a table from another module, and a
 * module-level spread is evaluated in whatever order the bundler happened to link the two - so
 * an import cycle, or a dev server reloading one module without the other, reads the imported
 * name before it exists. Deferring it to the first call puts the read long after every module
 * has finished evaluating.
 */
function polylineAttrDefaults(): Readonly<Record<string, unknown>> {
  return (cachedPolylineAttrDefaults ??= Object.freeze({
    ...shapeAttrDefaults(),
    points: Object.freeze([]),
    closed: false,
    tension: 0,
    bezier: false,
  }))
}

export class Polyline extends Shape {
  override readonly nodeName: string = 'Polyline'

  /**
   * The vertices the outline is built from, always as objects however they were written.
   * Assigning a list re-tessellates.
   *
   * EDITING ONE IN PLACE DOES NOT. `line.points.push(p)` and `line.points[0].x = 4` are both
   * invisible from here - there is no assignment to intercept - so either follow them with
   * markGeometryDirty(), or assign a new list.
   */
  private _points: Vector2Like[] = []
  private _pointsWritten: PointsInput = []
  get points(): Vector2Like[] {
    return this._points
  }
  set points(value: PointsInput) {
    // Both, because a flat list is stored as the objects it became: writing the list back that
    // the getter just handed out is the same list either way it was first written.
    if (value === this._pointsWritten || value === this._points) return
    const previous = this._points
    this._points = toPoints(value)
    this._pointsWritten = value
    this.invalidateOutline()
    this.announce('points', previous, this._points)
  }

  /** Whether the last point joins the first, closing the outline and filling it. */
  private _closed = false
  get closed(): boolean {
    return this._closed
  }
  set closed(value: boolean) {
    if (value === this._closed) return
    const previous = this._closed
    this._closed = value
    this.invalidateOutline()
    this.announce('closed', previous, value)
  }

  /** How far the outline is smoothed through the points. 0 joins them with straight lines. */
  private _tension = 0
  get tension(): number {
    return this._tension
  }
  set tension(value: number) {
    if (value === this._tension) return
    const previous = this._tension
    this._tension = value
    this.invalidateOutline()
    this.announce('tension', previous, value)
  }

  /** Whether the points are cubic control points rather than a path to smooth through. */
  private _bezier = false
  get bezier(): boolean {
    return this._bezier
  }
  set bezier(value: boolean) {
    if (value === this._bezier) return
    const previous = this._bezier
    this._bezier = value
    this.invalidateOutline()
    this.announce('bezier', previous, value)
  }

  constructor(options: PolylineOptions = {}) {
    super(options)
    this.points = options.points ?? []
    this.closed = options.closed ?? false
    this.tension = options.tension ?? 0
    this.bezier = options.bezier ?? false
    this.settleSize(options)
  }

  protected override attrKeys(): readonly string[] {
    return [...super.attrKeys(), 'points', 'closed', 'tension', 'bezier']
  }

  protected override attrDefaults(): Readonly<Record<string, unknown>> {
    return polylineAttrDefaults()
  }

  // --- the drawn outline ------------------------------------------------------------------

  /**
   * The points actually drawn: the list itself when it is a straight polyline, the flattened
   * curve when tension or bezier says otherwise.
   *
   * Kept until the outline changes, because three separate readers ask for it - the fill, the
   * stroker, and every measurement below - and flattening a curve three times per rebuild would
   * be three times the work for one answer.
   */
  private outlineCache?: readonly Vector2Like[]
  outline(): readonly Vector2Like[] {
    if (!this.outlineCache) {
      this.outlineCache = this._bezier
        ? bezierPoints(this._points)
        : smoothPoints(this._points, this._tension, this._closed)
    }
    return this.outlineCache
  }

  private invalidateOutline(): void {
    this.outlineCache = undefined
    this.extentCache = undefined
    this.markGeometryDirty()
  }

  // --- size -------------------------------------------------------------------------------
  //
  // A polyline is not SIZED, it is MEASURED: width and height report the extent of the drawn
  // outline rather than a stored pair, so a shape whose points span 240 units is 240 wide
  // without anyone having said so. Assigning either one records a size for callers that ask and
  // moves no point - the outline is the geometry, whatever the size says.

  private extentCache?: { width: number; height: number }
  private widthPinned = false
  private heightPinned = false

  private extent(): { width: number; height: number } {
    if (!this.extentCache) {
      const points = this.outline()
      if (points.length === 0) {
        this.extentCache = { width: 0, height: 0 }
      } else {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const p of points) {
          if (p.x < minX) minX = p.x
          if (p.x > maxX) maxX = p.x
          if (p.y < minY) minY = p.y
          if (p.y > maxY) maxY = p.y
        }
        this.extentCache = { width: maxX - minX, height: maxY - minY }
      }
    }
    return this.extentCache
  }

  /**
   * Node's constructor writes width and height through the setters, so every Polyline would
   * arrive with both pinned. Only a size NAMED in the options is an override - and a size that
   * merely restates the measurement is what a serialised copy carries, so that one is not an
   * override either, and a reloaded shape goes on tracking its points as the original did.
   */
  private settleSize(options: PolylineOptions): void {
    const measured = this.extent()
    this.widthPinned = options.width !== undefined && options.width !== measured.width
    this.heightPinned = options.height !== undefined && options.height !== measured.height
  }

  override get width(): number {
    return this.widthPinned ? super.width : this.extent().width
  }
  override set width(value: number) {
    this.widthPinned = true
    super.width = value
  }
  override get height(): number {
    return this.heightPinned ? super.height : this.extent().height
  }
  override set height(value: number) {
    this.heightPinned = true
    super.height = value
  }

  // --- distance along the outline ---------------------------------------------------------

  /** How long the drawn outline is, the closing segment included when it is closed. */
  getLength(): number {
    return contourLength(this.outline(), this._closed)
  }

  /**
   * The point that far along the outline, in local space, or null for an empty one. A distance
   * past either end clamps to that end - see render/arcLength.
   */
  getPointAtLength(distance: number): Vector2Like | null {
    const points = this.outline()
    if (points.length === 0) return null
    return pointAtLength([{ points, closed: this._closed }], distance)
  }

  protected override buildGeometry(sink: MeshSink): void {
    const outline = this.outline()

    // Fill: the interior, whenever there is one to have. Emitted regardless of what `fill` is
    // set to, like every other closed shape here - the triangles are what a hit test inside the
    // polygon needs, and the fragment shader decides separately whether they paint.
    if (this._closed && outline.length >= 3) {
      const { vertices, indices } = triangulateGroup({ outer: outline as Vector2Like[], holes: [] })
      const base = vertices.map((v) => sink.vertex(v.x, v.y, true))
      for (let i = 0; i < indices.length; i += 3) {
        sink.triangle(base[indices[i]], base[indices[i + 1]], base[indices[i + 2]])
      }
    }

    if (!this.hasStroke() || outline.length < 2) return
    strokePolyline(outline, sink, {
      width: this.strokeWidthForBuild(),
      dash: this.dashForBuild(),
      dashOffset: this.dashOffset,
      closed: this._closed,
      align: this.strokeAlign,
      join: this.lineJoin,
      cap: this.lineCap,
      miterLimit: this.miterLimit,
      gauge: this.strokeGauge(),
    })
  }
}
