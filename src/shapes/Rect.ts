// Rect - a filled, optionally stroked rectangle (Konva-style). Centered at (x, y) in
// the Z=0 plane, sized width×height, rotatable about its center (Z). It owns no GPU
// resources: it tessellates a fill quad (+ a stroke ring) into the mesh lane, and its
// position/rotation ride the per-object transform (size lives in the geometry, so the
// local matrix carries no scale).

import { Shape } from '../scene/Shape'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Vector3 } from '../math/Vector3'
import type { MeshSink, RGBA } from '../render/meshFormat'

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

    // Stroke: a ring between an outer and inner rect, centered on the edge.
    if (this.strokeWidth > 0) {
      const s = this.strokeWidth / 2
      const o0 = sink.vertex(-hw - s, -hh - s, this.stroke)
      const o1 = sink.vertex(hw + s, -hh - s, this.stroke)
      const o2 = sink.vertex(hw + s, hh + s, this.stroke)
      const o3 = sink.vertex(-hw - s, hh + s, this.stroke)
      const i0 = sink.vertex(-hw + s, -hh + s, this.stroke)
      const i1 = sink.vertex(hw - s, -hh + s, this.stroke)
      const i2 = sink.vertex(hw - s, hh - s, this.stroke)
      const i3 = sink.vertex(-hw + s, hh - s, this.stroke)
      // Four sides, two triangles each (outer edge -> inner edge).
      sink.triangle(o0, o1, i1)
      sink.triangle(o0, i1, i0) // bottom
      sink.triangle(o1, o2, i2)
      sink.triangle(o1, i2, i1) // right
      sink.triangle(o2, o3, i3)
      sink.triangle(o2, i3, i2) // top
      sink.triangle(o3, o0, i0)
      sink.triangle(o3, i0, i3) // left
    }
  }
}
