// Transform - a decomposed SRT transform (position / rotation / scale) plus the
// operations a scene node needs. TypeScript port of Fungine3D's Core/Transform.h.
// Right-handed, row-vector: world = S * R * T, Forward = -Z. For general 4x4 math
// (projection, inverse, decompose) use Matrix4x4.

import { Matrix4x4 } from './Matrix4x4'
import { Quaternion } from './Quaternion'
import { Vector3 } from './Vector3'

export class Transform {
  position: Vector3
  rotation: Quaternion
  scale: Vector3

  constructor(
    position: Vector3 = new Vector3(0, 0, 0),
    rotation: Quaternion = Quaternion.identity(),
    scale: Vector3 = new Vector3(1, 1, 1),
  ) {
    this.position = position
    this.rotation = rotation
    this.scale = scale
  }

  clone(): Transform {
    return new Transform(this.position.clone(), this.rotation.clone(), this.scale.clone())
  }

  static identity(): Transform {
    return new Transform()
  }

  static fromMatrix(m: Matrix4x4): Transform {
    const d = m.decompose()
    if (!d) return new Transform()
    return new Transform(d.translation, d.rotation, d.scale)
  }

  toMatrix(): Matrix4x4 {
    return Matrix4x4.trs(this.position, this.rotation, this.scale)
  }
  inverseMatrix(): Matrix4x4 {
    return this.toMatrix().inverse()
  }

  // Orientation basis vectors in world space.
  forward(): Vector3 {
    return this.rotation.rotateVector(Vector3.forward())
  }
  right(): Vector3 {
    return this.rotation.rotateVector(Vector3.right())
  }
  up(): Vector3 {
    return this.rotation.rotateVector(Vector3.up())
  }

  transformPoint(p: Vector3): Vector3 {
    return this.toMatrix().transformPoint(p)
  }
  transformDirection(d: Vector3): Vector3 {
    return this.rotation.rotateVector(d)
  }

  translate(delta: Vector3): void {
    this.position = this.position.add(delta)
  }
  rotate(q: Quaternion): void {
    this.rotation = this.rotation.mul(q).normalized()
  }
  rotateAxisAngle(axis: Vector3, angle: number): void {
    this.rotate(Quaternion.fromAxisAngle(axis, angle))
  }
  setEuler(pitch: number, yaw: number, roll: number): void {
    this.rotation = Quaternion.fromEuler(pitch, yaw, roll)
  }

  // Orient so forward() (-Z) points from position toward target.
  lookAt(target: Vector3, up: Vector3 = Vector3.up()): void {
    if (target.sub(this.position).lengthSquared() < 1e-12) return
    const world = Matrix4x4.lookAtRH(this.position, target, up).inverse()
    const d = world.decompose()
    if (d) this.rotation = d.rotation
  }

  // Hierarchical compose: returns `child` expressed in this (parent) space.
  // Goes through matrices, so non-uniform scale under rotation is baked (and
  // decompose cannot recover shear) - fine for rigid/uniform-scale nodes.
  mul(child: Transform): Transform {
    return Transform.fromMatrix(child.toMatrix().mul(this.toMatrix()))
  }
}
