// Shape - the base for every drawable scene-graph node, mesh-tessellated or not. A
// Shape carries the common geometric parameters every drawable shares - position
// (x, y), scale (scaleX, scaleY), rotation, pivot offset (offsetX, offsetY) - plus
// visibility/pickability and a stacking-order hint (zIndex). Concrete rendering
// (mesh geometry, MSDF text) is added by subclasses: MeshShape (Rect, Circle, Polyline,
// Path) for the mesh lane, and Text for the text lane. Shapes own NO GPU resources -
// the renderer owns all buffers/bind groups and reads each shape's worldMatrix() into
// the per-object transform buffer.
//
// localMatrix() composes translate(x, y) * rotate(rotation) * scale(scaleX, scaleY) *
// translate(-offsetX, -offsetY): offset shifts the shape's own pivot (applied first, to
// the shape's local geometry) before scale and rotation are applied about that pivot,
// then the result is placed at (x, y). Skew (shear) is not currently supported.

import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Vector3 } from '../math/Vector3'
import { Node } from './Node'

export interface ShapeOptions {
  name?: string
  x?: number
  y?: number
  scaleX?: number
  scaleY?: number
  /** Radians, about +Z. */
  rotation?: number
  offsetX?: number
  offsetY?: number
  /**
   * Stacking-order hint: shapes/text with a higher zIndex render in front, resolved by
   * the renderer's depth buffer (so mesh shapes and text can freely interleave, not just
   * "all text in front of all shapes"). Integer-valued by convention; ties fall back to
   * scene-graph order. Default 0.
   */
  zIndex?: number
}

export abstract class Shape extends Node {
  /** Skipped by the renderer when false. */
  visible = true
  /** Excluded from pickNode() hit-testing when false (e.g. a selection-highlight overlay). */
  pickable = true

  x = 0
  y = 0
  scaleX = 1
  scaleY = 1
  /** Radians, about +Z. */
  rotation = 0
  offsetX = 0
  offsetY = 0
  zIndex = 0

  constructor(options: ShapeOptions = {}) {
    super(options.name)
    this.x = options.x ?? 0
    this.y = options.y ?? 0
    this.scaleX = options.scaleX ?? 1
    this.scaleY = options.scaleY ?? 1
    this.rotation = options.rotation ?? 0
    this.offsetX = options.offsetX ?? 0
    this.offsetY = options.offsetY ?? 0
    this.zIndex = options.zIndex ?? 0
  }

  override localMatrix(): Matrix4x4 {
    let m = Matrix4x4.translation(new Vector3(this.x, this.y, 0))
    if (this.rotation !== 0) {
      m = m.mul(Matrix4x4.rotationQuaternion(Quaternion.fromAxisAngle(Vector3.unitZ(), this.rotation)))
    }
    if (this.scaleX !== 1 || this.scaleY !== 1) {
      m = m.mul(Matrix4x4.scaling(new Vector3(this.scaleX, this.scaleY, 1)))
    }
    if (this.offsetX !== 0 || this.offsetY !== 0) {
      m = m.mul(Matrix4x4.translation(new Vector3(-this.offsetX, -this.offsetY, 0)))
    }
    return m
  }
}
