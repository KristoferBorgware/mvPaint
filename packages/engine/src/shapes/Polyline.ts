// Polyline - a stroked (no fill), open or closed path. Points are in local space,
// positioned by the common Shape parameters (x, y, scale, rotation, offset); line style
// matches the Canvas2D API via the inherited stroke/lineJoin/lineCap/miterLimit
// ('lineCap' only applies to open paths). Delegates entirely to the shared contour
// stroker - this is the shape that most directly exercises "any contour, with any
// join/cap style".
//
// Fill for closed polylines (treating them as a filled polygon) is a separate, harder
// problem - general polygon triangulation (ear clipping) for arbitrary/concave shapes -
// and is out of scope here; Polyline is stroke-only. width/height are unused (its size
// comes from its own point list, not a settable size parameter).

import type { Vector2Like } from '../math/Vector2'
import { shapeAttrDefaults, Shape, type ShapeOptions } from './Shape'
import type { MeshSink } from '../render/meshFormat'
import {strokePolyline} from '../render/stroke'

export interface PolylineOptions extends ShapeOptions {
  points: Vector2Like[]
  /** Loop back to the start (a closed contour) vs. an open path with caps. Default false. */
  closed?: boolean
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
  }))
}

export class Polyline extends Shape {
  override readonly nodeName: string = 'Polyline'

  /**
   * The vertices the ribbon follows. Assigning a list re-tessellates.
   *
   * EDITING ONE IN PLACE DOES NOT. `line.points.push(p)` and `line.points[0].x = 4` are both
   * invisible from here - there is no assignment to intercept - so either follow them with
   * markGeometryDirty(), or assign a new list.
   */
  private _points: Vector2Like[] = []
  get points(): Vector2Like[] {
    return this._points
  }
  set points(value: Vector2Like[]) {
    if (value === this._points) return
    const previous = this._points
    this._points = value
    this.markGeometryDirty()
    this.announce('points', previous, value)
  }

  /** Whether the last point joins the first. Assigning it re-tessellates. */
  private _closed = false
  get closed(): boolean {
    return this._closed
  }
  set closed(value: boolean) {
    if (value === this._closed) return
    const previous = this._closed
    this._closed = value
    this.markGeometryDirty()
    this.announce('closed', previous, value)
  }

  constructor(options: PolylineOptions) {
    super(options)
    this.points = options.points
    this.closed = options.closed ?? false
  }

  protected override attrKeys(): readonly string[] {
    return [...super.attrKeys(), 'points', 'closed']
  }

  protected override attrDefaults(): Readonly<Record<string, unknown>> {
    return polylineAttrDefaults()
  }

  protected override buildGeometry(sink: MeshSink): void {
    if (!this.hasStroke() || this.points.length < 2) return
    strokePolyline(this.points, sink, {
      width: this.strokeWidthForBuild(),
      dash: this.dashForBuild(),
      dashOffset: this.dashOffset,
      closed: this.closed,
      align: this.strokeAlign,
      join: this.lineJoin,
      cap: this.lineCap,
      miterLimit: this.miterLimit,
      gauge: this.strokeGauge(),
    })
  }
}
