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

  points: Vector2Like[]
  closed: boolean

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
