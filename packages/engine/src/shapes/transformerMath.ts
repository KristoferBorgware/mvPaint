// Pure math behind the Transformer, split out so it can be self-tested without a canvas
// or a GPU (the same split cameraControls.ts and nodeDrag.ts use).
//
// The whole design rests on one idea: every gesture is expressed as a single WORLD-space
// delta matrix, which is then pushed into each node being transformed. That is what makes
// multi-select fall out for free (one delta, applied to every node) and what makes
// nesting work (a node under a rotated/scaled/flipped parent gets the delta converted
// into its own parent's frame, rather than the transformer needing to know anything
// about the hierarchy).
//
// Non-uniformly scaling a ROTATED node produces a sheared matrix, which a
// translate/rotate/scale transform cannot hold. Shape therefore carries skewX/skewY too
// (a shear term, applied between rotation and scale), so rotate+skew+scale spans every
// invertible 2x2 and the decomposition below is EXACT rather than a best fit.

import { Matrix4x4 } from '../math/Matrix4x4'
import { Vector3 } from '../math/Vector3'
import type { AABB } from '../math/AABB'
import type { Node } from './Node'
import type { TransformableNode } from './Group'

export interface Point2 {
  x: number
  y: number
}

/** The eight resize handles, named by edge/corner. 'top' is +y (the scene is y-up). */
export type ResizeAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'

/** Every handle the transformer shows: the eight resize anchors plus the rotate handle. */
export type TransformerAnchor = ResizeAnchor | 'rotate'

export const RESIZE_ANCHORS: readonly ResizeAnchor[] = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
]

/** Which way each anchor sits from the box center, in box-local units of half-extent. */
export const ANCHOR_DIRECTION: Record<ResizeAnchor, Point2> = {
  'top-left': { x: -1, y: 1 },
  'top-center': { x: 0, y: 1 },
  'top-right': { x: 1, y: 1 },
  'middle-left': { x: -1, y: 0 },
  'middle-right': { x: 1, y: 0 },
  'bottom-left': { x: -1, y: -1 },
  'bottom-center': { x: 0, y: -1 },
  'bottom-right': { x: 1, y: -1 },
}

/**
 * The framing rectangle: a center and half-extents in world units, plus the rotation of
 * its own axes. A single node adopts that node's world rotation, so the box hugs
 * a rotated shape; a multi-node box is axis-aligned (rotation 0), since there is no
 * one orientation that fits several differently-rotated nodes.
 */
export interface OrientedBox {
  cx: number
  cy: number
  halfW: number
  halfH: number
  rotation: number
}

/** Scale factors below this collapse the matrix, so a resize is clamped to it. */
const MIN_SCALE = 1e-4
const TWO_PI = Math.PI * 2

function rotate2(p: Point2, angle: number): Point2 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }
}

/** A node's rotation in world space - its own, plus everything its ancestors add. */
export function worldRotationOf(node: Node): number {
  const m = node.worldMatrix().m
  return Math.atan2(m[1], m[0])
}

/** The world-space position of one of a box's anchors. */
export function anchorPosition(box: OrientedBox, anchor: ResizeAnchor): Point2 {
  const dir = ANCHOR_DIRECTION[anchor]
  const local = { x: dir.x * box.halfW, y: dir.y * box.halfH }
  const world = rotate2(local, box.rotation)
  return { x: box.cx + world.x, y: box.cy + world.y }
}

/**
 * The rotate handle sits `distance` world units beyond the top edge, along the box's own
 * +y axis - so it stays clear of the top-center resize anchor and follows the rotation.
 */
export function rotateAnchorPosition(box: OrientedBox, distance: number): Point2 {
  const world = rotate2({ x: 0, y: box.halfH + distance }, box.rotation)
  return { x: box.cx + world.x, y: box.cy + world.y }
}

/**
 * Fits an oriented box around world-space points, measured along axes turned by
 * `rotation`. Points are taken into that frame, bounded there, and the resulting center
 * is taken back out to world - so the box is tight around a rotated shape instead of
 * being the looser axis-aligned box around it.
 */
export function boxFromPoints(points: readonly Point2[], rotation: number): OrientedBox | null {
  if (points.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of points) {
    const q = rotate2(p, -rotation)
    minX = Math.min(minX, q.x)
    minY = Math.min(minY, q.y)
    maxX = Math.max(maxX, q.x)
    maxY = Math.max(maxY, q.y)
  }

  const centerInFrame = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  const center = rotate2(centerInFrame, rotation)
  return {
    cx: center.x,
    cy: center.y,
    halfW: (maxX - minX) / 2,
    halfH: (maxY - minY) / 2,
    rotation,
  }
}

/** The four world-space corners of a node's local bounds. */
export function worldCorners(node: Node, bounds: AABB): Point2[] {
  const world = node.worldMatrix()
  const corners: Point2[] = []
  for (const [x, y] of [
    [bounds.min.x, bounds.min.y],
    [bounds.max.x, bounds.min.y],
    [bounds.max.x, bounds.max.y],
    [bounds.min.x, bounds.max.y],
  ]) {
    const p = world.transformPoint(new Vector3(x, y, 0))
    corners.push({ x: p.x, y: p.y })
  }
  return corners
}

/**
 * The box around one or more nodes, oriented to the FIRST node's world
 * rotation - so a lone node gets a box that hugs it exactly, and a multi-node
 * group rotates and resizes rigidly around whichever member came
 * first, rather than snapping back to axis-aligned.
 *
 * That "snapping back" is not just a cosmetic difference: `update()` (see Transformer) is
 * called every frame with a box freshly rebuilt here, including mid-gesture. An
 * axis-aligned multi-node box would recompute as axis-aligned on every frame of a ROTATE
 * drag too, so however much the nodes actually turned, the box shown on screen
 * would appear frozen - it never looked like it was rotating with them at all,
 * even though the nodes underneath genuinely were.
 *
 * `boundsOf` supplies each node's LOCAL bounds (Shape.localBounds() for a mesh shape, the
 * shaped text bounds for a Text), returning null for anything with nothing to measure -
 * `nodes[0]` still orients the box even if it happens to be one of those, since
 * orientation only needs its rotation, not its bounds.
 */
export function boxForNodes(
  nodes: readonly TransformableNode[],
  boundsOf: (node: TransformableNode) => AABB | null,
): OrientedBox | null {
  if (nodes.length === 0) return null
  const rotation = worldRotationOf(nodes[0])

  const measurable = nodes.filter((node) => {
    const b = boundsOf(node)
    return b !== null && b.valid()
  })
  if (measurable.length === 0) return null

  const points: Point2[] = []
  for (const node of measurable) {
    points.push(...worldCorners(node, boundsOf(node)!))
  }
  return boxFromPoints(points, rotation)
}

export interface ResizeOptions {
  /** Lock the aspect ratio (corner anchors only) - what shift does, and the default for corners. */
  keepRatio?: boolean
  /** Scale about the box center instead of the opposite anchor - what alt does. */
  centered?: boolean
}

export interface ResizeDelta {
  /** Scale factors along the box's own axes. Negative means the drag crossed over and flipped it. */
  scaleX: number
  scaleY: number
  /** The world point held still by this resize (the opposite anchor, or the center). */
  fixed: Point2
  /** The frame the scaling happens in - the box's rotation. */
  rotation: number
}

/**
 * What a resize drag amounts to: scale factors about a fixed point, in the box's own
 * rotated frame. `box` is the framing box as it stood when the drag STARTED, and
 * `pointer` is the current world position - so the result is always measured from the
 * drag's origin and cannot accumulate drift over a long gesture.
 *
 * The anchor opposite the dragged one is what stays put (or the center, when `centered`),
 * which is the behaviour every direct-manipulation editor shares. Dragging an anchor past
 * that fixed point yields a negative factor, mirroring the group rather than clamping.
 */
export function resizeFactors(
  box: OrientedBox,
  anchor: ResizeAnchor,
  pointer: Point2,
  options: ResizeOptions = {},
): ResizeDelta {
  const dir = ANCHOR_DIRECTION[anchor]
  const isCorner = dir.x !== 0 && dir.y !== 0
  const keepRatio = (options.keepRatio ?? false) && isCorner
  const centered = options.centered ?? false

  // Half the box when scaling about the center, the whole box when scaling about the
  // opposite anchor - the span the pointer's distance is measured against either way.
  const k = centered ? 2 : 1
  const fullW = box.halfW * 2
  const fullH = box.halfH * 2

  const fixed = centered
    ? { x: box.cx, y: box.cy }
    : anchorPosition(box, oppositeAnchor(anchor))

  // The pointer, and the anchor's own starting offset, in the frame centred on the fixed
  // point and turned by the box's rotation.
  const q = rotate2({ x: pointer.x - fixed.x, y: pointer.y - fixed.y }, -box.rotation)
  const start = { x: (dir.x * fullW) / k, y: (dir.y * fullH) / k }

  let scaleX = 1
  let scaleY = 1
  if (keepRatio) {
    // Project the pointer onto the diagonal it started on: the ratio is preserved and the
    // handle tracks the pointer smoothly, instead of snapping to whichever axis moved most.
    const denom = start.x * start.x + start.y * start.y
    const s = denom > 0 ? (q.x * start.x + q.y * start.y) / denom : 1
    scaleX = s
    scaleY = s
  } else {
    if (dir.x !== 0 && Math.abs(fullW) > MIN_SCALE) scaleX = (dir.x * q.x * k) / fullW
    if (dir.y !== 0 && Math.abs(fullH) > MIN_SCALE) scaleY = (dir.y * q.y * k) / fullH
  }

  return {
    scaleX: clampAwayFromZero(scaleX),
    scaleY: clampAwayFromZero(scaleY),
    fixed,
    rotation: box.rotation,
  }
}

function clampAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) return 1
  if (Math.abs(value) < MIN_SCALE) return value < 0 ? -MIN_SCALE : MIN_SCALE
  return value
}

/** The anchor diagonally/directly across the box, which a resize holds still. */
export function oppositeAnchor(anchor: ResizeAnchor): ResizeAnchor {
  const dir = ANCHOR_DIRECTION[anchor]
  const found = RESIZE_ANCHORS.find((name) => {
    const d = ANCHOR_DIRECTION[name]
    return d.x === -dir.x && d.y === -dir.y
  })
  return found ?? anchor
}

/**
 * How far the rotate drag has turned the box, in radians, from `start` to `pointer`
 * (both world positions, measured about the box center). When `snaps` is given, the
 * RESULTING absolute angle is snapped to the nearest one within `tolerance`, so the box
 * settles onto those angles rather than the raw pointer angle.
 */
export function rotationDelta(
  box: OrientedBox,
  start: Point2,
  pointer: Point2,
  snaps?: readonly number[],
  tolerance = 0.12,
): number {
  const a0 = Math.atan2(start.y - box.cy, start.x - box.cx)
  const a1 = Math.atan2(pointer.y - box.cy, pointer.x - box.cx)
  const raw = box.rotation + (a1 - a0)
  const snapped = snaps && snaps.length > 0 ? snapAngle(raw, snaps, tolerance) : raw
  return snapped - box.rotation
}

/** Wraps an angle into (-PI, PI]. */
function normalizeAngle(angle: number): number {
  let a = angle % TWO_PI
  if (a > Math.PI) a -= TWO_PI
  if (a <= -Math.PI) a += TWO_PI
  return a
}

/** The nearest snap angle within `tolerance`, else `angle` unchanged. Compared modulo a full turn. */
export function snapAngle(angle: number, snaps: readonly number[], tolerance: number): number {
  let best = angle
  let bestDiff = tolerance
  for (const snap of snaps) {
    const diff = Math.abs(normalizeAngle(angle - snap))
    if (diff <= bestDiff) {
      bestDiff = diff
      // Keep the turn the pointer is actually on, rather than jumping back to the
      // snap's own revolution.
      best = angle - normalizeAngle(angle - snap)
    }
  }
  return best
}

/** A world-space matrix that scales about `fixed`, along axes turned by `rotation`. */
export function scaleAbout(fixed: Point2, rotation: number, scaleX: number, scaleY: number): Matrix4x4 {
  const toOrigin = Matrix4x4.translation(new Vector3(-fixed.x, -fixed.y, 0))
  const back = Matrix4x4.translation(new Vector3(fixed.x, fixed.y, 0))
  return back
    .mul(Matrix4x4.rotationZ(rotation))
    .mul(Matrix4x4.scaling(new Vector3(scaleX, scaleY, 1)))
    .mul(Matrix4x4.rotationZ(-rotation))
    .mul(toOrigin)
}

/** A world-space matrix that rotates by `angle` about `center`. */
export function rotateAbout(center: Point2, angle: number): Matrix4x4 {
  return Matrix4x4.translation(new Vector3(center.x, center.y, 0))
    .mul(Matrix4x4.rotationZ(angle))
    .mul(Matrix4x4.translation(new Vector3(-center.x, -center.y, 0)))
}

/** What a 2x2 linear part decomposes into, in Shape's own transform vocabulary. */
export interface DecomposedTransform {
  rotation: number
  scaleX: number
  scaleY: number
  skewX: number
  skewY: number
}

/**
 * Splits a 2x2 linear transform into rotation, skew and scale, matching the order
 * localMatrix() composes them in (R · skew · S). This is a QR-style decomposition: the
 * rotation and scaleX come from the x axis' direction and length, the determinant fixes
 * scaleY, and whatever obliqueness is left over lands in skewX.
 *
 * Five stored fields describe a four-degree-of-freedom matrix, so one has to be pinned to
 * make the answer unique - skewY is pinned to 0. Every invertible 2x2 is still reachable,
 * which is the point: it makes the decomposition EXACT, so non-uniformly scaling a
 * rotated shape is represented faithfully instead of approximated.
 *
 * `a`/`b` are the x axis (column 0), `c`/`d` the y axis (column 1).
 */
export function decompose2D(a: number, b: number, c: number, d: number): DecomposedTransform {
  const determinant = a * d - b * c
  const xAxisLength = Math.hypot(a, b)

  if (xAxisLength > 1e-12) {
    return {
      rotation: Math.atan2(b, a),
      scaleX: xAxisLength,
      scaleY: determinant / xAxisLength,
      skewX: (a * c + b * d) / determinant,
      skewY: 0,
    }
  }

  // The x axis collapsed (a fully squashed transform), so measure from the y axis instead.
  const yAxisLength = Math.hypot(c, d)
  if (yAxisLength > 1e-12) {
    return {
      rotation: Math.PI / 2 - Math.atan2(d, c),
      scaleX: determinant / yAxisLength,
      scaleY: yAxisLength,
      skewX: 0,
      skewY: (a * c + b * d) / determinant,
    }
  }

  return { rotation: 0, scaleX: 0, scaleY: 0, skewX: 0, skewY: 0 }
}

/**
 * Pushes a WORLD-space delta onto a node, by rewriting its own transform fields.
 *
 * The node's new world matrix is `delta * world`, so its new LOCAL matrix is
 * `parentWorld⁻¹ * delta * parentWorld * local` - which is what lets one delta drive a
 * whole multi-node group, whatever each node's parent does. That product is then
 * decomposed back into the fields a Shape stores (see decompose2D). `offsetX/offsetY` is
 * held fixed and folded into the position, since the pivot belongs to the node, not the
 * gesture.
 */
export function applyWorldTransform(node: TransformableNode, delta: Matrix4x4): void {
  const parentWorld = node.parent ? node.parent.worldMatrix() : Matrix4x4.identity()
  const newLocal = parentWorld.inverse().mul(delta).mul(parentWorld).mul(node.localMatrix())
  const m = newLocal.m

  // Column-major: column 0 is the x axis, column 1 the y axis, column 3 the translation.
  const parts = decompose2D(m[0], m[1], m[4], m[5])
  node.rotation = parts.rotation
  node.scaleX = parts.scaleX
  node.scaleY = parts.scaleY
  node.skewX = parts.skewX
  node.skewY = parts.skewY

  // localMatrix() is T(x,y)·R·skew·S·T(-offset), so its translation column reads
  // (x,y) - A·offset for the combined linear part A - hence the pivot is added back here.
  node.x = m[12] + m[0] * node.offsetX + m[4] * node.offsetY
  node.y = m[13] + m[1] * node.offsetX + m[5] * node.offsetY
}
