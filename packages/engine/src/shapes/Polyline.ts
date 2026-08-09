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
import { Shape, type ShapeOptions } from './Shape'
import type { MeshSink } from '../render/meshFormat'
import {strokePolyline} from '../render/stroke'

export interface PolylineOptions extends ShapeOptions {
  points: Vector2Like[]
  /** Loop back to the start (a closed contour) vs. an open path with caps. Default false. */
  closed?: boolean
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
    this._points = value
    this.markGeometryDirty()
  }

  /** Whether the last point joins the first. Assigning it re-tessellates. */
  private _closed = false
  get closed(): boolean {
    return this._closed
  }
  set closed(value: boolean) {
    if (value === this._closed) return
    this._closed = value
    this.markGeometryDirty()
  }

  constructor(options: PolylineOptions) {
    super(options)
    this.points = options.points
    this.closed = options.closed ?? false
  }

  protected override attrKeys(): readonly string[] {
    return [...super.attrKeys(), 'points', 'closed']
  }

  protected override buildGeometry(sink: MeshSink): void {
    if (!this.hasStroke() || this.points.length < 2) return
    strokePolyline(this.points, sink, {
      width: this.strokeWidth,
      closed: this.closed,
      align: this.strokeAlign,
      join: this.lineJoin,
      cap: this.lineCap,
      miterLimit: this.miterLimit,
      gauge: this.strokeGauge(),
    })
  }
}
