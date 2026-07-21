// Vector2 - 2D float vector.
// TypeScript port of Fungine3D's Core/Vector2.h (originally a DirectXMath XMFLOAT2
// wrapper). SIMD is replaced with plain scalar math; the API and semantics match.

export class Vector2 {
  constructor(
    public x = 0,
    public y = 0,
  ) {}

  clone(): Vector2 {
    return new Vector2(this.x, this.y)
  }

  add(r: Vector2): Vector2 {
    return new Vector2(this.x + r.x, this.y + r.y)
  }
  sub(r: Vector2): Vector2 {
    return new Vector2(this.x - r.x, this.y - r.y)
  }
  mul(s: number): Vector2 {
    return new Vector2(this.x * s, this.y * s)
  }
  div(s: number): Vector2 {
    return this.mul(1 / s)
  }
  neg(): Vector2 {
    return new Vector2(-this.x, -this.y)
  }

  nearEquals(r: Vector2, eps = 1e-5): boolean {
    return Math.abs(this.x - r.x) <= eps && Math.abs(this.y - r.y) <= eps
  }

  length(): number {
    return Math.hypot(this.x, this.y)
  }
  lengthSquared(): number {
    return this.x * this.x + this.y * this.y
  }
  normalized(): Vector2 {
    const len = this.length()
    return len > 0 ? this.div(len) : new Vector2(0, 0)
  }

  static dot(a: Vector2, b: Vector2): number {
    return a.x * b.x + a.y * b.y
  }
  static lerp(a: Vector2, b: Vector2, t: number): Vector2 {
    return new Vector2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
  }
  static min(a: Vector2, b: Vector2): Vector2 {
    return new Vector2(Math.min(a.x, b.x), Math.min(a.y, b.y))
  }
  static max(a: Vector2, b: Vector2): Vector2 {
    return new Vector2(Math.max(a.x, b.x), Math.max(a.y, b.y))
  }

  static zero(): Vector2 {
    return new Vector2(0, 0)
  }
  static one(): Vector2 {
    return new Vector2(1, 1)
  }
  static unitX(): Vector2 {
    return new Vector2(1, 0)
  }
  static unitY(): Vector2 {
    return new Vector2(0, 1)
  }
}
