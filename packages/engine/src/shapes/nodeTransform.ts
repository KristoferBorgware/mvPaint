// The 2D transform a placeable node carries, and the one implementation of what it
// composes to. Two kinds of node place themselves in their parent - a Shape, and a Group
// of other nodes - and they must agree exactly: a gesture that resizes a shape and one
// that resizes a group run the same math (see transformerMath.ts) and would drift apart
// the moment the two compositions differed by an operand or an order.
//
// The composition is T(x, y) * R(rotation) * skew * S(scaleX, scaleY) * T(-offsetX,
// -offsetY): offset moves the node's own pivot first, against its raw local contents, then
// skew/scale/rotation act about that pivot, then the result is placed at (x, y).
//
// Skew sits between rotation and scale on purpose. rotate * skew * scale spans every
// invertible 2x2, so an arbitrary affine transform is representable exactly - which is
// what lets a transformer scale a ROTATED node along one axis without approximating it.
//
// The matrix is memoized on a snapshot of every field it reads. A node that did not move
// since the last frame - the overwhelming majority once a scene has settled - returns the
// SAME Matrix4x4 instance, and reference equality is what lets world matrices, the object
// cache and the render lanes all short-circuit without comparing any numbers (see Node's
// worldMatrix and render/MeshBatcher's ObjectCache).

import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Vector3 } from '../math/Vector3'

/** Every field the local matrix is built from - a complete transform snapshot. */
export interface NodeTransform {
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
  skewX: number
  skewY: number
  offsetX: number
  offsetY: number
}

/** What a caller can set on any placeable node when constructing it. */
export interface NodeTransformOptions {
  x?: number
  y?: number
  scaleX?: number
  scaleY?: number
  /** Radians, about +Z. */
  rotation?: number
  offsetX?: number
  offsetY?: number
  skewX?: number
  skewY?: number
}

/** [[1, skewX], [skewY, 1]] as a 4x4 - x slides with y, and y with x. */
export function skewMatrix(skewX: number, skewY: number): Matrix4x4 {
  const m = Matrix4x4.identity()
  // Column-major: m[4] is row 0 of column 1 (x from y), m[1] is row 1 of column 0 (y from x).
  m.m[4] = skewX
  m.m[1] = skewY
  return m
}

/**
 * The local matrix a transform composes to. Each step is skipped when it is the identity,
 * so an untransformed node costs one translation rather than four multiplications.
 */
export function localMatrixOf(t: NodeTransform): Matrix4x4 {
  let m = Matrix4x4.translation(new Vector3(t.x, t.y, 0))
  if (t.rotation !== 0) {
    m = m.mul(Matrix4x4.rotationQuaternion(Quaternion.fromAxisAngle(Vector3.unitZ(), t.rotation)))
  }
  if (t.skewX !== 0 || t.skewY !== 0) {
    m = m.mul(skewMatrix(t.skewX, t.skewY))
  }
  if (t.scaleX !== 1 || t.scaleY !== 1) {
    m = m.mul(Matrix4x4.scaling(new Vector3(t.scaleX, t.scaleY, 1)))
  }
  if (t.offsetX !== 0 || t.offsetY !== 0) {
    m = m.mul(Matrix4x4.translation(new Vector3(-t.offsetX, -t.offsetY, 0)))
  }
  return m
}

/** A copy of every field, so a gesture can put the node back exactly as it found it. */
export function captureTransform(t: NodeTransform): NodeTransform {
  return {
    x: t.x,
    y: t.y,
    rotation: t.rotation,
    scaleX: t.scaleX,
    scaleY: t.scaleY,
    skewX: t.skewX,
    skewY: t.skewY,
    offsetX: t.offsetX,
    offsetY: t.offsetY,
  }
}

/** Writes a captured transform back. The inverse of captureTransform. */
export function restoreTransform(target: NodeTransform, t: NodeTransform): void {
  target.x = t.x
  target.y = t.y
  target.rotation = t.rotation
  target.scaleX = t.scaleX
  target.scaleY = t.scaleY
  target.skewX = t.skewX
  target.skewY = t.skewY
  target.offsetX = t.offsetX
  target.offsetY = t.offsetY
}

/** Applies whichever of the transform options were given, leaving the rest alone. */
export function applyTransformOptions(target: NodeTransform, options: NodeTransformOptions): void {
  target.x = options.x ?? 0
  target.y = options.y ?? 0
  target.scaleX = options.scaleX ?? 1
  target.scaleY = options.scaleY ?? 1
  target.rotation = options.rotation ?? 0
  target.offsetX = options.offsetX ?? 0
  target.offsetY = options.offsetY ?? 0
  target.skewX = options.skewX ?? 0
  target.skewY = options.skewY ?? 0
}

/** The attribute names a placeable node exposes on top of its parent class's. */
export const TRANSFORM_ATTR_KEYS: readonly string[] = [
  'x',
  'y',
  'scaleX',
  'scaleY',
  'rotation',
  'offsetX',
  'offsetY',
  'skewX',
  'skewY',
]

/**
 * localMatrixOf() with the result held onto until one of its inputs actually changes.
 * The cache object is only reallocated on a real change, not on every call, so a settled
 * scene does nine number comparisons per node per frame and no allocation at all.
 */
export class LocalMatrixCache {
  private cached: (NodeTransform & { matrix: Matrix4x4 }) | null = null

  matrixFor(t: NodeTransform): Matrix4x4 {
    const c = this.cached
    if (
      c &&
      c.x === t.x &&
      c.y === t.y &&
      c.rotation === t.rotation &&
      c.scaleX === t.scaleX &&
      c.scaleY === t.scaleY &&
      c.skewX === t.skewX &&
      c.skewY === t.skewY &&
      c.offsetX === t.offsetX &&
      c.offsetY === t.offsetY
    ) {
      return c.matrix
    }
    const matrix = localMatrixOf(t)
    this.cached = { ...captureTransform(t), matrix }
    return matrix
  }
}
