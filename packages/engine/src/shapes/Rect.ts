// Rect - a filled, optionally stroked rectangle. Centered at (x, y) in the Z=0 plane
// (before any offset), sized width×height, transformed by the common Shape parameters
// (position, scale, rotation, offset). It owns no GPU resources: it tessellates a fill
// quad in the mesh lane (fill color or gradient, via the inherited Shape fill API) and
// strokes its own outline (a 4-corner contour) through the shared general-purpose
// stroker, using the inherited stroke/lineJoin/miterLimit (a rectangle's corners are
// always 90 degrees, so 'miter' - Shape's default - always lands exactly on the diagonal
// bisector; lineCap is irrelevant since the outline is always closed).

import { Shape, type ShapeOptions } from './Shape'
import type { MeshSink } from '../render/meshFormat'
import { strokePolyline } from '../render/stroke'

export type RectOptions = ShapeOptions

export class Rect extends Shape {
  override readonly className: string = 'Rect'

  constructor(options: RectOptions = {}) {
    super({ ...options, width: options.width ?? 1, height: options.height ?? 1 })
  }

  protected override buildGeometry(sink: MeshSink): void {
    const hw = this.width / 2
    const hh = this.height / 2

    // Fill: centered quad (two triangles). Color is not part of the geometry - the
    // fragment shader reads the object's fillColor (solid) or gradient parameters.
    const f0 = sink.vertex(-hw, -hh, true)
    const f1 = sink.vertex(hw, -hh, true)
    const f2 = sink.vertex(hw, hh, true)
    const f3 = sink.vertex(-hw, hh, true)
    sink.triangle(f0, f1, f2)
    sink.triangle(f0, f2, f3)

    if (this.strokeWidth > 0) {
      const corners = [
        { x: -hw, y: -hh },
        { x: hw, y: -hh },
        { x: hw, y: hh },
        { x: -hw, y: hh },
      ]
      strokePolyline(corners, sink, {
        width: this.strokeWidth,
        closed: true,
        join: this.lineJoin,
        miterLimit: this.miterLimit,
      })
    }
  }
}
