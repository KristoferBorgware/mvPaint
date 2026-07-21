// Self-test ported from Fungine3D's Core/MathSelfTest.cpp (Ray tests omitted, since
// Ray was not part of this port). Run with `npx tsx src/math/selfTest.ts` to verify
// the TypeScript math matches the original DirectXMath-based behaviour.

import { AABB, Matrix4x4, Quaternion, Transform, Vector3 } from './index'

const PIDIV2 = Math.PI / 2
const PIDIV4 = Math.PI / 4

function near(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) <= eps
}

let count = 0
function assert(cond: boolean, msg: string): void {
  count++
  if (!cond) {
    throw new Error(`[math] self-test FAILED: ${msg}`)
  }
}

// --- Vector3 ---
assert(Vector3.cross(Vector3.unitX(), Vector3.unitY()).nearEquals(Vector3.unitZ()), 'cross X,Y=Z')
assert(near(Vector3.dot(new Vector3(1, 2, 3), new Vector3(4, 5, 6)), 32), 'dot')
assert(near(new Vector3(3, 0, 4).length(), 5), 'length')
assert(near(new Vector3(0, 0, 5).normalized().length(), 1), 'normalize length')
assert(
  Vector3.lerp(Vector3.zero(), new Vector3(10, 0, 0), 0.5).nearEquals(new Vector3(5, 0, 0)),
  'lerp',
)
assert(
  Vector3.reflect(new Vector3(1, -1, 0), Vector3.up()).nearEquals(new Vector3(1, 1, 0)),
  'reflect',
)

// --- Quaternion --- (+90 deg about Y takes +X to -Z in a right-handed frame)
{
  const q = Quaternion.fromAxisAngle(Vector3.unitY(), PIDIV2)
  assert(q.rotateVector(new Vector3(1, 0, 0)).nearEquals(new Vector3(0, 0, -1)), 'quat +90 Y: X->-Z')
}
// Rotating via the quaternion agrees with rotating via its matrix.
{
  const q = Quaternion.fromEuler(0.3, -0.7, 1.1)
  const v = new Vector3(0.2, 0.5, -0.9)
  assert(
    q.rotateVector(v).nearEquals(Matrix4x4.rotationQuaternion(q).transformDirection(v)),
    'quat rotate == matrix transform',
  )
}

// --- Matrix4x4 --- inverse round-trips a point through a TRS matrix.
{
  const m = Matrix4x4.trs(
    new Vector3(3, -2, 5),
    Quaternion.fromEuler(0.4, 0.2, -0.1),
    new Vector3(2, 2, 2),
  )
  const p = new Vector3(1.5, -3.0, 2.25)
  assert(m.inverse().transformPoint(m.transformPoint(p)).nearEquals(p, 1e-3), 'TRS inverse round-trip')
}

// --- Transform --- toMatrix agrees with TRS; identity forward is -Z.
{
  const t = new Transform(
    new Vector3(1, 2, 3),
    Quaternion.fromEuler(0.1, 0.2, 0.3),
    new Vector3(1.5, 1.5, 1.5),
  )
  const p = new Vector3(0.5, -0.5, 0.5)
  assert(
    t
      .toMatrix()
      .transformPoint(p)
      .nearEquals(Matrix4x4.trs(t.position, t.rotation, t.scale).transformPoint(p)),
    'Transform.toMatrix == TRS',
  )
}
assert(Transform.identity().forward().nearEquals(Vector3.forward()), 'identity forward = -Z')

// --- Transform compose --- parent*child applied to a point equals applying
// child then parent. Uniform scale keeps the decompose round-trip lossless.
{
  const parent = new Transform(
    new Vector3(5, 1, -2),
    Quaternion.fromEuler(0.2, 0.5, -0.3),
    new Vector3(2, 2, 2),
  )
  const child = new Transform(new Vector3(1, 0, 3), Quaternion.fromAxisAngle(Vector3.unitY(), PIDIV2))
  const p = new Vector3(0.3, -0.4, 0.7)

  const composed = parent.mul(child).transformPoint(p)
  const chained = parent.transformPoint(child.transformPoint(p))
  assert(composed.nearEquals(chained, 1e-3), 'compose == chained')

  assert(
    Transform.identity().mul(child).transformPoint(p).nearEquals(child.transformPoint(p), 1e-3),
    'identity * child',
  )
  assert(
    parent.mul(Transform.identity()).transformPoint(p).nearEquals(parent.transformPoint(p), 1e-3),
    'parent * identity',
  )
}

// --- AABB --- containment, overlap, and transform-refit.
{
  const box = new AABB(new Vector3(-1, -1, -1), new Vector3(1, 1, 1))
  assert(box.contains(new Vector3(0.5, -0.5, 0.0)), 'contains inside')
  assert(!box.contains(new Vector3(2, 0, 0)), 'not contains outside')
  assert(box.center().nearEquals(Vector3.zero()), 'center')
  assert(box.extents().nearEquals(Vector3.one()), 'extents')
  assert(box.intersects(new AABB(new Vector3(0, 0, 0), new Vector3(3, 3, 3))), 'intersects')
  assert(!box.intersects(new AABB(new Vector3(2, 2, 2), new Vector3(3, 3, 3))), 'not intersects')

  // A 45-deg turn about Y grows the axis-aligned x/z extent to sqrt(2); y is unchanged.
  const rotated = box.transformed(Matrix4x4.rotationY(PIDIV4))
  assert(near(rotated.max.x, Math.sqrt(2), 1e-3), 'rotated x extent = sqrt(2)')
  assert(near(rotated.max.y, 1.0, 1e-3), 'rotated y unchanged')

  // An empty box is invalid until it swallows a point, then it is exactly that point.
  const grow = AABB.empty()
  assert(!grow.valid(), 'empty invalid')
  grow.encapsulate(new Vector3(1, 2, 3))
  assert(
    grow.valid() && grow.min.nearEquals(new Vector3(1, 2, 3)) && grow.max.nearEquals(new Vector3(1, 2, 3)),
    'encapsulate point',
  )
}

// A little extra: FromToRotation and inverse.
{
  const q = Quaternion.fromToRotation(Vector3.unitX(), Vector3.unitZ())
  assert(q.rotateVector(Vector3.unitX()).nearEquals(Vector3.unitZ(), 1e-4), 'fromToRotation X->Z')
  const r = Quaternion.fromAxisAngle(new Vector3(0.3, 1, 0.2).normalized(), 0.8)
  assert(
    r.mul(r.inverse()).rotateVector(Vector3.unitX()).nearEquals(Vector3.unitX(), 1e-4),
    'q * q^-1 = identity',
  )
}

console.log(`[math] self-test passed (${count} assertions)`)
