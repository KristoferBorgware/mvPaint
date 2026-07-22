// Polyline - a stroked (no fill), open or closed path (Konva-style Line). Points are in
// local space, positioned by (x, y); line style matches the Canvas2D API: lineJoin
// ('miter'|'round'|'bevel'), lineCap ('butt'|'round'|'square', open paths only), and
// miterLimit. Delegates entirely to the shared contour stroker - this is the shape
// that most directly exercises "any contour, with any join/cap style".
//
// Fill for closed polylines (treating them as a filled polygon) is a separate, harder
// problem - general polygon triangulation (ear clipping) for arbitrary/concave shapes -
// and is out of scope here; Polyline is stroke-only.

import { Shape } from '../scene/Shape'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Vector3 } from '../math/Vector3'
import type { MeshSink, RGBA } from '../render/meshFormat'
import { strokePolyline, type LineCap, type LineJoin, type Point2 } from '../render/stroke'

export interface PolylineOptions {
  name?: string
  x?: number
  y?: number
  points: Point2[]
  /** Loop back to the start (a closed contour) vs. an open path with caps. Default false. */
  closed?: boolean
  stroke?: RGBA
  strokeWidth?: number
  lineJoin?: LineJoin
  /** Only applies when `closed` is false. */
  lineCap?: LineCap
  miterLimit?: number
}

export class Polyline extends Shape {
  x: number
  y: number
  points: Point2[]
  closed: boolean
  stroke: RGBA
  strokeWidth: number
  lineJoin: LineJoin
  lineCap: LineCap
  miterLimit: number

  constructor(options: PolylineOptions) {
    super(options.name)
    this.x = options.x ?? 0
    this.y = options.y ?? 0
    this.points = options.points
    this.closed = options.closed ?? false
    this.stroke = options.stroke ?? [0, 0, 0, 1]
    this.strokeWidth = options.strokeWidth ?? 1
    this.lineJoin = options.lineJoin ?? 'miter'
    this.lineCap = options.lineCap ?? 'butt'
    this.miterLimit = options.miterLimit ?? 10
  }

  override localMatrix(): Matrix4x4 {
    return Matrix4x4.translation(new Vector3(this.x, this.y, 0))
  }

  override tessellate(sink: MeshSink): void {
    if (this.strokeWidth <= 0 || this.points.length < 2) return
    strokePolyline(this.points, sink, {
      width: this.strokeWidth,
      color: this.stroke,
      closed: this.closed,
      join: this.lineJoin,
      cap: this.lineCap,
      miterLimit: this.miterLimit,
    })
  }
}
