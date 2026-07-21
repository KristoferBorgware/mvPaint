// Vector4 - 4D float vector (homogeneous points, RGBA colors).
// TypeScript port of Fungine3D's Core/Vector4.h.

import { Vector3 } from './Vector3'

export class Vector4 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public w = 0,
  ) {}

  static fromVector3(xyz: Vector3, w: number): Vector4 {
    return new Vector4(xyz.x, xyz.y, xyz.z, w)
  }

  clone(): Vector4 {
    return new Vector4(this.x, this.y, this.z, this.w)
  }

  add(r: Vector4): Vector4 {
    return new Vector4(this.x + r.x, this.y + r.y, this.z + r.z, this.w + r.w)
  }
  sub(r: Vector4): Vector4 {
    return new Vector4(this.x - r.x, this.y - r.y, this.z - r.z, this.w - r.w)
  }
  mul(s: number): Vector4 {
    return new Vector4(this.x * s, this.y * s, this.z * s, this.w * s)
  }
  div(s: number): Vector4 {
    return this.mul(1 / s)
  }
  neg(): Vector4 {
    return new Vector4(-this.x, -this.y, -this.z, -this.w)
  }

  nearEquals(r: Vector4, eps = 1e-5): boolean {
    return (
      Math.abs(this.x - r.x) <= eps &&
      Math.abs(this.y - r.y) <= eps &&
      Math.abs(this.z - r.z) <= eps &&
      Math.abs(this.w - r.w) <= eps
    )
  }

  length(): number {
    return Math.hypot(this.x, this.y, this.z, this.w)
  }
  lengthSquared(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w
  }
  normalized(): Vector4 {
    const len = this.length()
    return len > 0 ? this.div(len) : new Vector4(0, 0, 0, 0)
  }
  xyz(): Vector3 {
    return new Vector3(this.x, this.y, this.z)
  }

  static dot(a: Vector4, b: Vector4): number {
    return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
  }
  static lerp(a: Vector4, b: Vector4, t: number): Vector4 {
    return new Vector4(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t,
      a.z + (b.z - a.z) * t,
      a.w + (b.w - a.w) * t,
    )
  }

  static zero(): Vector4 {
    return new Vector4(0, 0, 0, 0)
  }
  static one(): Vector4 {
    return new Vector4(1, 1, 1, 1)
  }
  static unitX(): Vector4 {
    return new Vector4(1, 0, 0, 0)
  }
  static unitY(): Vector4 {
    return new Vector4(0, 1, 0, 0)
  }
  static unitZ(): Vector4 {
    return new Vector4(0, 0, 1, 0)
  }
  static unitW(): Vector4 {
    return new Vector4(0, 0, 0, 1)
  }
}
