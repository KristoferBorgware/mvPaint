// Vector2 - 2D float vector. Plain x/y storage; arithmetic uses ordinary scalar math.
//
// This is the engine's ONLY 2D vector. There used to be four other declarations of the same
// two fields - one beside the mesh formats, one in the stroker, one in the transformer's math
// and one in the drag math - each written out again because the module that needed it did not
// want to reach for a class it was not going to call a method on. Four copies of `{ x, y }`
// cannot disagree about anything, which is precisely why nobody noticed; what they cost was a
// reader having to check whether they were the same type (they were), and a maintainer having
// to pick one when writing something new.

/**
 * The data half of a vector: x and y, and nothing else.
 *
 * DERIVED from the class rather than written out beside it, so the two cannot drift apart -
 * this is Vector2's storage, named, not a second declaration of it. Use it wherever a
 * coordinate pair is being described rather than computed with:
 *
 *   - PUBLIC INPUTS, so a caller can pass the object literal they already have.
 *     `new Polyline({ points: [{ x: 0, y: 0 }, { x: 10, y: 4 }] })` stays legal - a class type
 *     would reject it, because a literal has no methods.
 *   - GEOMETRY IN BULK - a tessellated outline, a glyph's rings, a batcher's scratch buffers.
 *     Nothing there calls add() or normalized(); they are coordinates by the thousand, and the
 *     literal is the honest way to write them.
 *
 * Use the CLASS where the arithmetic is the point: a world position being offset, a pointer
 * being projected, anything that reads better as `a.sub(b).normalized()` than as three lines
 * of scalar math. Every Vector2 satisfies this type, so a class value flows into either.
 */
export type Vector2Like = Pick<Vector2, 'x' | 'y'>

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
