// AABB - axis-aligned bounding box stored as its min/max corners. TypeScript port
// of Fungine3D's Core/AABB.h. A composite value type (two Vector3s) that reuses
// Vector3 and Matrix4x4.transformPoint for re-fitting under a transform.

import type { Matrix4x4 } from './Matrix4x4'
import { Vector3 } from './Vector3'

const FLT_MAX = 3.402823466e38

export class AABB {
  min: Vector3
  max: Vector3

  // Default is an inverted "empty" box (min > max), so encapsulate() grows it
  // correctly from nothing and valid() reports false until it holds a point.
  constructor(
    min: Vector3 = new Vector3(FLT_MAX, FLT_MAX, FLT_MAX),
    max: Vector3 = new Vector3(-FLT_MAX, -FLT_MAX, -FLT_MAX),
  ) {
    this.min = min
    this.max = max
  }

  clone(): AABB {
    return new AABB(this.min.clone(), this.max.clone())
  }

  static empty(): AABB {
    return new AABB()
  }

  static fromCenterExtents(center: Vector3, extents: Vector3): AABB {
    return new AABB(center.sub(extents), center.add(extents)) // extents = half-size
  }

  static fromPoints(points: readonly Vector3[]): AABB {
    const box = new AABB()
    for (const p of points) box.encapsulate(p)
    return box
  }

  valid(): boolean {
    return this.min.x <= this.max.x && this.min.y <= this.max.y && this.min.z <= this.max.z
  }
  center(): Vector3 {
    return this.min.add(this.max).mul(0.5)
  }
  extents(): Vector3 {
    return this.max.sub(this.min).mul(0.5) // half-size
  }
  size(): Vector3 {
    return this.max.sub(this.min)
  }

  // Corner i in [0,8): bit 0 = x, bit 1 = y, bit 2 = z (0 = min, 1 = max).
  corner(i: number): Vector3 {
    return new Vector3(
      i & 1 ? this.max.x : this.min.x,
      i & 2 ? this.max.y : this.min.y,
      i & 4 ? this.max.z : this.min.z,
    )
  }

  contains(p: Vector3): boolean {
    return (
      p.x >= this.min.x &&
      p.x <= this.max.x &&
      p.y >= this.min.y &&
      p.y <= this.max.y &&
      p.z >= this.min.z &&
      p.z <= this.max.z
    )
  }

  intersects(o: AABB): boolean {
    return (
      this.min.x <= o.max.x &&
      this.max.x >= o.min.x &&
      this.min.y <= o.max.y &&
      this.max.y >= o.min.y &&
      this.min.z <= o.max.z &&
      this.max.z >= o.min.z
    )
  }

  encapsulate(p: Vector3): void
  encapsulate(o: AABB): void
  encapsulate(arg: Vector3 | AABB): void {
    if (arg instanceof AABB) {
      this.min = Vector3.min(this.min, arg.min)
      this.max = Vector3.max(this.max, arg.max)
    } else {
      this.min = Vector3.min(this.min, arg)
      this.max = Vector3.max(this.max, arg)
    }
  }

  merged(o: AABB): AABB {
    const box = this.clone()
    box.encapsulate(o)
    return box
  }

  // The tightest axis-aligned box enclosing this box transformed by m (all eight
  // corners are transformed and re-fitted, since a rotated box is not axis-aligned).
  transformed(m: Matrix4x4): AABB {
    const box = new AABB()
    for (let i = 0; i < 8; i++) box.encapsulate(m.transformPoint(this.corner(i)))
    return box
  }
}
