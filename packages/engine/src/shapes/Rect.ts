// Rect - a filled, optionally stroked rectangle. Centered at (x, y) in the Z=0 plane
// (before any offset), sized width×height, transformed by the common Shape parameters
// (position, scale, rotation, offset). It owns no GPU resources: it tessellates a fill
// quad in the mesh lane (fill color or gradient, via the inherited MeshShape fill API)
// and strokes its own outline (a 4-corner contour) through the shared general-purpose
// stroker.

import { MeshShape, type MeshShapeOptions } from '../scene/MeshShape'
import type { MeshSink, RGBA } from '../render/meshFormat'
import { strokePolyline } from '../render/stroke'

export interface RectOptions extends MeshShapeOptions {
  stroke?: RGBA
  /** Stroke width in world units; 0 = no stroke. Centered on the edge. */
  strokeWidth?: number
}

export class Rect extends MeshShape {
  stroke: RGBA
  strokeWidth: number

  constructor(options: RectOptions = {}) {
    super({ ...options, width: options.width ?? 1, height: options.height ?? 1 })
    this.stroke = options.stroke ?? [0, 0, 0, 1]
    this.strokeWidth = options.strokeWidth ?? 0
  }

  override tessellate(sink: MeshSink): void {
    const hw = this.width / 2
    const hh = this.height / 2

    // Fill: centered quad (two triangles). The vertex color is a placeholder when
    // fillPriority selects a gradient - the fragment shader computes the displayed
    // color from the object's gradient parameters instead.
    const f0 = sink.vertex(-hw, -hh, this.fill, true)
    const f1 = sink.vertex(hw, -hh, this.fill, true)
    const f2 = sink.vertex(hw, hh, this.fill, true)
    const f3 = sink.vertex(-hw, hh, this.fill, true)
    sink.triangle(f0, f1, f2)
    sink.triangle(f0, f2, f3)

    // Stroke: the 4-corner outline, through the shared contour stroker. A rectangle's
    // corners are all 90 degrees, so a miter join here always lands exactly on the
    // diagonal bisector - equivalent to offsetting each corner by ±strokeWidth/2 in x
    // and y independently.
    if (this.strokeWidth > 0) {
      const corners = [
        { x: -hw, y: -hh },
        { x: hw, y: -hh },
        { x: hw, y: hh },
        { x: -hw, y: hh },
      ]
      strokePolyline(corners, sink, {
        width: this.strokeWidth,
        color: this.stroke,
        closed: true,
        join: 'miter',
      })
    }
  }
}
