// Rect - a filled, optionally stroked rectangle (Konva-style). Centered at (x, y) in
// the Z=0 plane, sized width×height, rotatable about its center (Z). It owns no GPU
// resources: it tessellates a fill quad into the mesh lane and strokes its own outline
// (a 4-corner contour) through the shared general-purpose stroker. Position/rotation
// ride the per-object transform (size lives in the geometry, so the local matrix
// carries no scale).

import { Shape } from '../scene/Shape'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Vector3 } from '../math/Vector3'
import type { MeshSink, RGBA } from '../render/meshFormat'
import { strokePolyline } from '../render/stroke'

export interface RectOptions {
  name?: string
  /** Center position in world units. */
  x?: number
  y?: number
  width?: number
  height?: number
  /** Rotation about the center (radians, about +Z). */
  rotation?: number
  fill?: RGBA
  stroke?: RGBA
  /** Stroke width in world units; 0 = no stroke. Centered on the edge. */
  strokeWidth?: number
}

export class Rect extends Shape {
  x: number
  y: number
  width: number
  height: number
  rotation: number
  fill: RGBA
  stroke: RGBA
  strokeWidth: number

  constructor(options: RectOptions = {}) {
    super(options.name)
    this.x = options.x ?? 0
    this.y = options.y ?? 0
    this.width = options.width ?? 1
    this.height = options.height ?? 1
    this.rotation = options.rotation ?? 0
    this.fill = options.fill ?? [0, 0, 0, 1]
    this.stroke = options.stroke ?? [0, 0, 0, 1]
    this.strokeWidth = options.strokeWidth ?? 0
  }

  // Position + rotation only; the rect's size is baked into its geometry.
  override localMatrix(): Matrix4x4 {
    return Matrix4x4.translation(new Vector3(this.x, this.y, 0)).mul(
      Matrix4x4.rotationQuaternion(Quaternion.fromAxisAngle(Vector3.unitZ(), this.rotation)),
    )
  }

  override tessellate(sink: MeshSink): void {
    const hw = this.width / 2
    const hh = this.height / 2

    // Fill: centered quad (two triangles).
    const f0 = sink.vertex(-hw, -hh, this.fill)
    const f1 = sink.vertex(hw, -hh, this.fill)
    const f2 = sink.vertex(hw, hh, this.fill)
    const f3 = sink.vertex(-hw, hh, this.fill)
    sink.triangle(f0, f1, f2)
    sink.triangle(f0, f2, f3)

    // Stroke: the 4-corner outline, through the shared contour stroker. A rectangle's
    // corners are all 90 degrees, so a miter join here always lands exactly on the
    // diagonal bisector - equivalent to the old hand-rolled "offset each corner by
    // ±strokeWidth/2 in x and y independently" trick, just expressed generally.
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
