// Rect - a filled, optionally stroked rectangle. Its TOP-LEFT corner sits at (x, y) in the
// Z=0 plane (before any offset), and it extends right and down from there: the scene is
// y-up, so the rectangle spans x in [0, width] and y in [-height, 0] in its own local
// space. Sized width×height, transformed by the common Shape parameters (position, scale,
// rotation, offset). See Shape's header for which shapes are cornered and which centred.
//
// Rotation and scale are about the local origin, so a rectangle turns about its top-left
// corner unless given an offset - `offsetX: width / 2, offsetY: -height / 2` puts the
// pivot back in the middle. It owns no GPU resources: it tessellates a fill
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
  override readonly nodeName: string = 'Rect'

  constructor(options: RectOptions = {}) {
    super({ ...options, width: options.width ?? 1, height: options.height ?? 1 })
  }

  protected override buildGeometry(sink: MeshSink): void {
    const w = this.width
    // The scene is y-up and the origin is the top-left corner, so the rectangle hangs below
    // it: its bottom edge is at -height.
    const b = -this.height

    // Fill: two triangles, wound counter-clockwise from the bottom-left. Color is not part
    // of the geometry - the fragment shader reads the object's fillColor (solid) or
    // gradient parameters.
    const f0 = sink.vertex(0, b, true)
    const f1 = sink.vertex(w, b, true)
    const f2 = sink.vertex(w, 0, true)
    const f3 = sink.vertex(0, 0, true)
    sink.triangle(f0, f1, f2)
    sink.triangle(f0, f2, f3)

    if (this.strokeWidth > 0) {
      const corners = [
        { x: 0, y: b },
        { x: w, y: b },
        { x: w, y: 0 },
        { x: 0, y: 0 },
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
