// Vector3 - 3D float vector, the workhorse type (positions, directions).
// TypeScript port of Fungine3D's Core/Vector3.h. Right-handed; Forward = -Z.

import { Vector2 } from './Vector2'

export class Vector3 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}

  static fromVector2(xy: Vector2, z: number): Vector3 {
    return new Vector3(xy.x, xy.y, z)
  }

  clone(): Vector3 {
    return new Vector3(this.x, this.y, this.z)
  }

  add(r: Vector3): Vector3 {
    return new Vector3(this.x + r.x, this.y + r.y, this.z + r.z)
  }
  sub(r: Vector3): Vector3 {
    return new Vector3(this.x - r.x, this.y - r.y, this.z - r.z)
  }
  mul(s: number): Vector3 {
    return new Vector3(this.x * s, this.y * s, this.z * s)
  }
  div(s: number): Vector3 {
    return this.mul(1 / s)
  }
  neg(): Vector3 {
    return new Vector3(-this.x, -this.y, -this.z)
  }
  // Component-wise (Hadamard) product / quotient.
  mulComp(r: Vector3): Vector3 {
    return new Vector3(this.x * r.x, this.y * r.y, this.z * r.z)
  }
  divComp(r: Vector3): Vector3 {
    return new Vector3(this.x / r.x, this.y / r.y, this.z / r.z)
  }

  equals(r: Vector3): boolean {
    return this.x === r.x && this.y === r.y && this.z === r.z
  }
  nearEquals(r: Vector3, eps = 1e-5): boolean {
    return (
      Math.abs(this.x - r.x) <= eps &&
      Math.abs(this.y - r.y) <= eps &&
      Math.abs(this.z - r.z) <= eps
    )
  }

  length(): number {
    return Math.hypot(this.x, this.y, this.z)
  }
  lengthSquared(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z
  }
  normalized(): Vector3 {
    const len = this.length()
    return len > 0 ? this.div(len) : new Vector3(0, 0, 0)
  }
  safeNormalized(fallback: Vector3 = Vector3.zero()): Vector3 {
    return this.lengthSquared() > 1e-12 ? this.normalized() : fallback
  }

  static dot(a: Vector3, b: Vector3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z
  }
  static cross(a: Vector3, b: Vector3): Vector3 {
    return new Vector3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
  }
  static distance(a: Vector3, b: Vector3): number {
    return a.sub(b).length()
  }
  static distanceSquared(a: Vector3, b: Vector3): number {
    return a.sub(b).lengthSquared()
  }
  static lerp(a: Vector3, b: Vector3, t: number): Vector3 {
    return new Vector3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t)
  }
  static clamp(v: Vector3, lo: Vector3, hi: Vector3): Vector3 {
    return new Vector3(
      Math.min(Math.max(v.x, lo.x), hi.x),
      Math.min(Math.max(v.y, lo.y), hi.y),
      Math.min(Math.max(v.z, lo.z), hi.z),
    )
  }
  static min(a: Vector3, b: Vector3): Vector3 {
    return new Vector3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z))
  }
  static max(a: Vector3, b: Vector3): Vector3 {
    return new Vector3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z))
  }
  static abs(v: Vector3): Vector3 {
    return new Vector3(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z))
  }
  // Reflect v about the plane with normal n: v - 2*(v·n)*n.
  static reflect(v: Vector3, n: Vector3): Vector3 {
    return v.sub(n.mul(2 * Vector3.dot(v, n)))
  }
  // Unsigned angle (radians) between two vectors.
  static angle(a: Vector3, b: Vector3): number {
    const denom = a.length() * b.length()
    if (denom <= 1e-12) return 0
    const c = Math.min(Math.max(Vector3.dot(a, b) / denom, -1), 1)
    return Math.acos(c)
  }
  static project(v: Vector3, onto: Vector3): Vector3 {
    const d = Vector3.dot(onto, onto)
    return d > 1e-12 ? onto.mul(Vector3.dot(v, onto) / d) : Vector3.zero()
  }

  static zero(): Vector3 {
    return new Vector3(0, 0, 0)
  }
  static one(): Vector3 {
    return new Vector3(1, 1, 1)
  }
  static unitX(): Vector3 {
    return new Vector3(1, 0, 0)
  }
  static unitY(): Vector3 {
    return new Vector3(0, 1, 0)
  }
  static unitZ(): Vector3 {
    return new Vector3(0, 0, 1)
  }
  static up(): Vector3 {
    return new Vector3(0, 1, 0)
  }
  static down(): Vector3 {
    return new Vector3(0, -1, 0)
  }
  static right(): Vector3 {
    return new Vector3(1, 0, 0)
  }
  static left(): Vector3 {
    return new Vector3(-1, 0, 0)
  }
  static forward(): Vector3 {
    return new Vector3(0, 0, -1) // right-handed: -Z
  }
  static back(): Vector3 {
    return new Vector3(0, 0, 1)
  }
}
