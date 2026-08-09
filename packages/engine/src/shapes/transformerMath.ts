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

import type { Vector2Like } from '../math/Vector2'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Vector3 } from '../math/Vector3'
import type { AABB } from '../math/AABB'
import type { Node } from './Node'
import type { TransformableNode } from './Group'

/** The eight resize handles, named by edge/corner. 'top' is -y (the scene is y-down). */
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
export const ANCHOR_DIRECTION: Record<ResizeAnchor, Vector2Like> = {
  'top-left': { x: -1, y: -1 },
  'top-center': { x: 0, y: -1 },
  'top-right': { x: 1, y: -1 },
  'middle-left': { x: -1, y: 0 },
  'middle-right': { x: 1, y: 0 },
  'bottom-left': { x: -1, y: 1 },
  'bottom-center': { x: 0, y: 1 },
  'bottom-right': { x: 1, y: 1 },
}

/**
 * The framing rectangle: a center and half-extents in world units, plus the rotation of
 * its own axes. A single node adopts that node's world rotation, so the box hugs
 * a rotated shape; a multi-node box is axis-aligned (rotation 0), since there is no
 * one orientation that fits several differently-rotated nodes.
 *
 * Half-extents are SIGNED. A resize dragged past its fixed point yields a negative one,
 * which is what mirrors the box rather than collapsing it - see resizedBox.
 */
export interface OrientedBox {
  cx: number
  cy: number
  halfW: number
  halfH: number
  rotation: number
}

/**
 * The same rectangle as a corner and a size - the form a boundBoxFunc reads and returns.
 *
 * `x`/`y` are the box's top-left corner in world space, turned with the rest of it, and
 * `rotation` is in RADIANS (the unit every angle inside this module carries). `width` and
 * `height` are signed, so a flipped box reports a negative one; a constraint that means to
 * catch a box that has become too small tests `Math.abs(box.width)` rather than `box.width`.
 */
export interface BoundBox {
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

/** A chance to constrain a resize or rotation: return `newBox`, or something else to use instead. */
export type BoundBoxFunc = (oldBox: BoundBox, newBox: BoundBox) => BoundBox

/**
 * A chance to constrain where a handle drag is READ from, in world space - which is where
 * snapping to a grid or to other shapes belongs.
 *
 * `oldPos` is where the drag began rather than where it was on the previous move, because
 * every gesture here resolves against its own start and never accumulates.
 */
export type AnchorDragBoundFunc = (
  oldPos: Vector2Like,
  newPos: Vector2Like,
  event?: unknown,
) => Vector2Like

/** Scale factors below this collapse the matrix, so a resize is clamped to it. */
const MIN_SCALE = 1e-4
const TWO_PI = Math.PI * 2

function rotate2(p: Vector2Like, angle: number): Vector2Like {
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
export function anchorPosition(box: OrientedBox, anchor: ResizeAnchor): Vector2Like {
  const dir = ANCHOR_DIRECTION[anchor]
  const local = { x: dir.x * box.halfW, y: dir.y * box.halfH }
  const world = rotate2(local, box.rotation)
  return { x: box.cx + world.x, y: box.cy + world.y }
}

/**
 * The rotate handle sits `distance` world units beyond the top edge, along the box's own
 * -y axis - so it stays clear of the top-center resize anchor and follows the rotation.
 */
export function rotateAnchorPosition(box: OrientedBox, distance: number): Vector2Like {
  const world = rotate2({ x: 0, y: -(box.halfH + distance) }, box.rotation)
  return { x: box.cx + world.x, y: box.cy + world.y }
}

/**
 * Fits an oriented box around world-space points, measured along axes turned by
 * `rotation`. Points are taken into that frame, bounded there, and the resulting center
 * is taken back out to world - so the box is tight around a rotated shape instead of
 * being the looser axis-aligned box around it.
 */
export function boxFromPoints(points: readonly Vector2Like[], rotation: number): OrientedBox | null {
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
export function worldCorners(node: Node, bounds: AABB): Vector2Like[] {
  const world = node.worldMatrix()
  const corners: Vector2Like[] = []
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
 * The box around one or more nodes, measured along axes turned by `rotation`.
 *
 * `rotation` is the frame the box is fitted in, and the caller owns it: a Transformer passes
 * Transformer.fitRotation(), which hugs a lone node's own angle and, for a set, either borrows
 * the first member's or holds one of its own (see useFirstNodeRotation). Left out, it defaults
 * to the first node's world rotation, which is what a caller fitting a box around one node wants.
 *
 * The frame has to be the CALLER's because this runs every frame, mid-gesture included. A box
 * that recomputed its own orientation from the nodes each time would recompute a multi-node
 * set as axis-aligned on every frame of a rotate drag, so however far the nodes turned, the
 * frame on screen would sit still.
 *
 * `boundsOf` supplies each node's LOCAL bounds (Shape.localBounds() for a mesh shape, the
 * shaped text bounds for an MSDFText), returning null for anything with nothing to measure.
 */
export function boxForNodes(
  nodes: readonly TransformableNode[],
  boundsOf: (node: TransformableNode) => AABB | null,
  rotation: number = nodes.length > 0 ? worldRotationOf(nodes[0]) : 0,
): OrientedBox | null {
  if (nodes.length === 0) return null

  const measurable = nodes.filter((node) => {
    const b = boundsOf(node)
    return b !== null && b.valid()
  })
  if (measurable.length === 0) return null

  const points: Vector2Like[] = []
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
  /**
   * Let a drag past the fixed point mirror the box. Default true. Set false and the factors
   * are held just above zero there instead, so the box shrinks to nothing and stops.
   */
  flipEnabled?: boolean
}

export interface ResizeDelta {
  /** Scale factors along the box's own axes. Negative means the drag crossed over and flipped it. */
  scaleX: number
  scaleY: number
  /** The world point held still by this resize (the opposite anchor, or the center). */
  fixed: Vector2Like
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
  pointer: Vector2Like,
  options: ResizeOptions = {},
): ResizeDelta {
  const dir = ANCHOR_DIRECTION[anchor]
  const isCorner = dir.x !== 0 && dir.y !== 0
  const keepRatio = (options.keepRatio ?? false) && isCorner
  const centered = options.centered ?? false
  const flipEnabled = options.flipEnabled ?? true

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
    scaleX: clampAwayFromZero(scaleX, flipEnabled),
    scaleY: clampAwayFromZero(scaleY, flipEnabled),
    fixed,
    rotation: box.rotation,
  }
}

/**
 * Holds a factor clear of zero, where the matrix collapses and stops being invertible.
 *
 * With flipping off the floor is positive, so a drag that crosses the fixed point stalls at a
 * hairline instead of mirroring. With it on the sign is kept and only the magnitude is floored.
 */
function clampAwayFromZero(value: number, flipEnabled: boolean): number {
  if (!Number.isFinite(value)) return 1
  if (!flipEnabled) return Math.max(value, MIN_SCALE)
  if (Math.abs(value) < MIN_SCALE) return value < 0 ? -MIN_SCALE : MIN_SCALE
  return value
}

/**
 * The box a resize lands on: the starting box scaled about the delta's fixed point, in the
 * box's own frame. Half-extents keep the factors' signs, so a mirrored box reports negative
 * ones and a boundBoxFunc can see the flip.
 */
export function resizedBox(box: OrientedBox, delta: ResizeDelta): OrientedBox {
  const local = rotate2({ x: box.cx - delta.fixed.x, y: box.cy - delta.fixed.y }, -delta.rotation)
  const scaled = rotate2({ x: local.x * delta.scaleX, y: local.y * delta.scaleY }, delta.rotation)
  return {
    cx: delta.fixed.x + scaled.x,
    cy: delta.fixed.y + scaled.y,
    halfW: box.halfW * delta.scaleX,
    halfH: box.halfH * delta.scaleY,
    rotation: box.rotation,
  }
}

/** The box as a corner and a signed size, which is the shape a boundBoxFunc reads. */
export function boxToBoundBox(box: OrientedBox): BoundBox {
  const corner = rotate2({ x: -box.halfW, y: -box.halfH }, box.rotation)
  return {
    x: box.cx + corner.x,
    y: box.cy + corner.y,
    width: box.halfW * 2,
    height: box.halfH * 2,
    rotation: box.rotation,
  }
}

/** The inverse of boxToBoundBox - what a boundBoxFunc's answer means as a box. */
export function boundBoxToBox(bound: BoundBox): OrientedBox {
  const center = rotate2({ x: bound.width / 2, y: bound.height / 2 }, bound.rotation)
  return {
    cx: bound.x + center.x,
    cy: bound.y + center.y,
    halfW: bound.width / 2,
    halfH: bound.height / 2,
    rotation: bound.rotation,
  }
}

/**
 * The world-space delta that carries `from` onto `to` - the one matrix every handle gesture
 * reduces to, whether it resized, rotated, mirrored or all three.
 *
 * Working from the two BOXES rather than from a gesture's own factors is what lets a
 * boundBoxFunc sit between them: whatever box it hands back, however little that resembles
 * what the pointer asked for, is expressible here. Degenerate source extents scale by 1
 * rather than by infinity, so a box with no width in some axis translates and turns instead
 * of exploding.
 */
export function deltaBetweenBoxes(from: OrientedBox, to: OrientedBox): Matrix4x4 {
  const scaleX = Math.abs(from.halfW) > MIN_SCALE ? to.halfW / from.halfW : 1
  const scaleY = Math.abs(from.halfH) > MIN_SCALE ? to.halfH / from.halfH : 1
  return Matrix4x4.translation(new Vector3(to.cx, to.cy, 0))
    .mul(Matrix4x4.rotationZ(to.rotation))
    .mul(Matrix4x4.scaling(new Vector3(scaleX, scaleY, 1)))
    .mul(Matrix4x4.rotationZ(-from.rotation))
    .mul(Matrix4x4.translation(new Vector3(-from.cx, -from.cy, 0)))
}

/**
 * The eight resize cursors, indexed by which way the handle faces in eighths of a turn from
 * +x. A turned box turns its cursors with it, so the arrows keep pointing along the edge the
 * handle actually moves.
 */
const RESIZE_CURSORS: readonly string[] = [
  'ew-resize',
  'nwse-resize',
  'ns-resize',
  'nesw-resize',
  'ew-resize',
  'nwse-resize',
  'ns-resize',
  'nesw-resize',
]

/**
 * The cursor for a handle on a box turned by `rotation` radians. `held` picks between the open
 * and closed hand the rotate handle shows before and during its drag.
 */
export function anchorCursor(anchor: TransformerAnchor, rotation: number, held = false): string {
  if (anchor === 'rotate') return held ? 'grabbing' : 'grab'
  const dir = ANCHOR_DIRECTION[anchor]
  const facing = Math.atan2(dir.y, dir.x) + rotation
  const eighth = Math.round(facing / (Math.PI / 4))
  return RESIZE_CURSORS[((eighth % 8) + 8) % 8]
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
  start: Vector2Like,
  pointer: Vector2Like,
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
export function scaleAbout(fixed: Vector2Like, rotation: number, scaleX: number, scaleY: number): Matrix4x4 {
  const toOrigin = Matrix4x4.translation(new Vector3(-fixed.x, -fixed.y, 0))
  const back = Matrix4x4.translation(new Vector3(fixed.x, fixed.y, 0))
  return back
    .mul(Matrix4x4.rotationZ(rotation))
    .mul(Matrix4x4.scaling(new Vector3(scaleX, scaleY, 1)))
    .mul(Matrix4x4.rotationZ(-rotation))
    .mul(toOrigin)
}

/** A world-space matrix that rotates by `angle` about `center`. */
export function rotateAbout(center: Vector2Like, angle: number): Matrix4x4 {
  return Matrix4x4.translation(new Vector3(center.x, center.y, 0))
    .mul(Matrix4x4.rotationZ(angle))
    .mul(Matrix4x4.translation(new Vector3(-center.x, -center.y, 0)))
}

// decompose2D moved to math/, where Node can reach it without closing an import cycle
// through Container. Re-exported here because it is half of this module's story and callers
// have always found it at this address.
export { decompose2D, type DecomposedTransform } from '../math/decompose2D'

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
  node.applyLocalMatrix(parentWorld.inverse().mul(delta).mul(parentWorld).mul(node.localMatrix()))
}
