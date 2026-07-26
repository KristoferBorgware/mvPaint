// Self-test for the Transformer's math (shapes/transformerMath.ts): selection boxes,
// anchor placement, resize factors, rotation snapping, and pushing a world-space delta
// back onto a node. Pure geometry, no canvas or GPU - the Transformer node itself is a
// thin layer of scene bookkeeping over these and isn't covered here. Run with:
//   npx tsx src/shapes/selfTest.ts

import { AABB } from '../math/AABB'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Vector3 } from '../math/Vector3'
import { Container } from './Container'
import { Rect } from './Rect'
import type { Shape } from './Shape'
import {
  ANCHOR_DIRECTION,
  anchorPosition,
  applyWorldTransform,
  boxForNodes,
  boxFromPoints,
  oppositeAnchor,
  resizeFactors,
  rotateAbout,
  rotateAnchorPosition,
  rotationDelta,
  scaleAbout,
  snapAngle,
  worldRotationOf,
  type OrientedBox,
} from './transformerMath'

let count = 0
function assert(cond: boolean, msg: string): void {
  count++
  if (!cond) throw new Error(`[shapes] self-test FAILED: ${msg}`)
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps

const localBoundsOf = (node: Shape): AABB | null => node.localBounds()

/** World-space corners of a node's local bounds, for checking a transform's effect. */
function corners(node: Shape): { x: number; y: number }[] {
  const b = node.localBounds()
  const w = node.worldMatrix()
  return [
    [b.min.x, b.min.y],
    [b.max.x, b.min.y],
    [b.max.x, b.max.y],
    [b.min.x, b.max.y],
  ].map(([x, y]) => {
    const p = w.transformPoint(new Vector3(x, y, 0))
    return { x: p.x, y: p.y }
  })
}

// --- boxFromPoints: fits an oriented box in a turned frame ---
{
  const axisAligned = boxFromPoints(
    [
      { x: -10, y: -4 },
      { x: 10, y: 4 },
    ],
    0,
  )!
  assert(near(axisAligned.cx, 0) && near(axisAligned.cy, 0), 'box center is the midpoint')
  assert(near(axisAligned.halfW, 10) && near(axisAligned.halfH, 4), 'box half-extents span the points')

  // A square turned 45 degrees is tight in its OWN frame (half-extent 1), but would need
  // half-extent sqrt(2) if it were measured axis-aligned - which is the whole point of
  // orienting the box to a rotated node.
  const s = Math.SQRT1_2
  const diamond = [
    { x: 0, y: Math.SQRT2 },
    { x: Math.SQRT2, y: 0 },
    { x: 0, y: -Math.SQRT2 },
    { x: -Math.SQRT2, y: 0 },
  ]
  const turned = boxFromPoints(diamond, Math.PI / 4)!
  assert(near(turned.halfW, 1) && near(turned.halfH, 1), 'a box measured in its own frame hugs a rotated shape')
  const loose = boxFromPoints(diamond, 0)!
  assert(near(loose.halfW, Math.SQRT2), 'the same points measured axis-aligned need a bigger box')
  assert(near(s * s * 2, 1), 'sanity: sqrt(1/2) squared, doubled, is 1')
}

// --- boxForNodes: one node orients to it, several fall back to axis-aligned ---
{
  const solo = new Rect({ x: 100, y: 50, width: 40, height: 20, rotation: Math.PI / 4 })
  const box = boxForNodes([solo], localBoundsOf)!
  assert(near(box.rotation, Math.PI / 4), 'a single node gives a box turned to match it')
  assert(near(box.cx, 100) && near(box.cy, 50), "the box centers on the node's own bounds")
  assert(near(box.halfW, 20) && near(box.halfH, 10), 'and hugs it: half of 40x20, despite the rotation')

  const a = new Rect({ x: -50, y: 0, width: 20, height: 20 })
  const b = new Rect({ x: 50, y: 30, width: 20, height: 20 })
  const pair = boxForNodes([a, b], localBoundsOf)!
  assert(pair.rotation === 0, 'a multi-node box is axis-aligned')
  assert(near(pair.cx, 0) && near(pair.cy, 15), 'the multi-node box centers on the union')
  assert(near(pair.halfW, 60) && near(pair.halfH, 25), 'the multi-node box spans every node')

  assert(boxForNodes([], localBoundsOf) === null, 'no nodes gives no box')
}

// --- anchors: placement follows the box's rotation, and opposites really are opposite ---
{
  const box: OrientedBox = { cx: 0, cy: 0, halfW: 10, halfH: 5, rotation: 0 }
  assert(near(anchorPosition(box, 'top-right').x, 10) && near(anchorPosition(box, 'top-right').y, 5), 'top-right sits at (+halfW,+halfH)')
  assert(near(anchorPosition(box, 'middle-left').x, -10) && near(anchorPosition(box, 'middle-left').y, 0), 'middle-left sits at (-halfW,0)')
  assert(near(rotateAnchorPosition(box, 4).y, 9), 'the rotate handle clears the top edge by its offset')

  // Turned a quarter turn, the box's +x axis points along world +y.
  const turned: OrientedBox = { ...box, rotation: Math.PI / 2 }
  const right = anchorPosition(turned, 'middle-right')
  assert(near(right.x, 0) && near(right.y, 10), "anchors follow the box's rotation")

  assert(oppositeAnchor('top-left') === 'bottom-right', 'top-left is opposite bottom-right')
  assert(oppositeAnchor('middle-left') === 'middle-right', 'middle-left is opposite middle-right')
  assert(oppositeAnchor('bottom-center') === 'top-center', 'bottom-center is opposite top-center')
  for (const [name, dir] of Object.entries(ANCHOR_DIRECTION)) {
    const opp = ANCHOR_DIRECTION[oppositeAnchor(name as never)]
    assert(opp.x === -dir.x && opp.y === -dir.y, `${name}'s opposite mirrors it on both axes`)
  }
}

// --- resizeFactors: the opposite anchor holds still, and dragging to the start is a no-op ---
{
  const box: OrientedBox = { cx: 0, cy: 0, halfW: 10, halfH: 5, rotation: 0 }

  // Dragging an anchor to exactly where it already is must not scale anything - the
  // property that makes a resize start without a jump.
  for (const anchor of ['top-left', 'middle-right', 'bottom-center', 'top-right'] as const) {
    const at = anchorPosition(box, anchor)
    const same = resizeFactors(box, anchor, at)
    assert(near(same.scaleX, 1) && near(same.scaleY, 1), `dragging ${anchor} to its own position scales by 1`)
  }

  // middle-right out to double the width: x doubles, y untouched, left edge pinned.
  const wider = resizeFactors(box, 'middle-right', { x: 30, y: 0 })
  assert(near(wider.scaleX, 2) && near(wider.scaleY, 1), 'an edge anchor scales one axis only')
  assert(near(wider.fixed.x, -10) && near(wider.fixed.y, 0), 'the opposite edge is what stays put')

  // A corner scales both axes independently unless the ratio is locked. Widths are
  // measured from the pinned corner: dragging top-right to x=30 spans -10..30, i.e. 40
  // against the original 20, so twice as wide - while y is left where it was.
  const corner = resizeFactors(box, 'top-right', { x: 30, y: 5 })
  assert(near(corner.scaleX, 2) && near(corner.scaleY, 1), 'a free corner scales each axis by its own drag')
  assert(near(corner.fixed.x, -10) && near(corner.fixed.y, -5), 'a corner pins the opposite corner')

  const locked = resizeFactors(box, 'top-right', { x: 20, y: 5 }, { keepRatio: true })
  assert(near(locked.scaleX, locked.scaleY), 'keepRatio ties the two axes together')

  // Centered scaling pins the middle, so the same pointer travel covers half the box.
  const centered = resizeFactors(box, 'middle-right', { x: 20, y: 0 }, { centered: true })
  assert(near(centered.fixed.x, 0) && near(centered.fixed.y, 0), 'centered scaling pins the box center')
  assert(near(centered.scaleX, 2), 'centered scaling measures from the center outward')

  // Dragging an anchor back past its fixed point mirrors rather than collapsing.
  const flipped = resizeFactors(box, 'middle-right', { x: -30, y: 0 })
  assert(flipped.scaleX < 0, 'dragging past the fixed point flips instead of clamping to zero')

  // keepRatio is meaningless on an edge anchor (there is no diagonal), so it is ignored.
  const edgeRatio = resizeFactors(box, 'middle-right', { x: 30, y: 0 }, { keepRatio: true })
  assert(near(edgeRatio.scaleY, 1), 'keepRatio does not affect an edge anchor')
}

// --- resize on a ROTATED box works in the box's own frame ---
{
  const box: OrientedBox = { cx: 0, cy: 0, halfW: 10, halfH: 5, rotation: Math.PI / 2 }
  // The box's +x axis points along world +y, so its middle-right anchor is at (0,10).
  const at = anchorPosition(box, 'middle-right')
  assert(near(at.x, 0) && near(at.y, 10), 'sanity: the turned box puts middle-right on world +y')
  // Its pinned middle-left edge is at world (0,-10), so pushing the handle out to world
  // (0,30) spans 40 against the original 20: the box's own WIDTH doubles, even though
  // the drag ran along world y.
  const grown = resizeFactors(box, 'middle-right', { x: 0, y: 30 })
  assert(near(grown.scaleX, 2) && near(grown.scaleY, 1), 'a rotated box scales along its OWN axes')
}

// --- snapAngle / rotationDelta ---
{
  const quarter = Math.PI / 2
  const snaps = [0, quarter, Math.PI, 3 * quarter]
  assert(near(snapAngle(0.05, snaps, 0.12), 0), 'an angle within tolerance snaps')
  assert(near(snapAngle(0.5, snaps, 0.12), 0.5), 'an angle outside tolerance is left alone')
  // Snapping keeps the revolution the pointer is actually on, rather than winding back.
  assert(near(snapAngle(TWO_PI_PLUS(0.05), snaps, 0.12), TWO_PI_PLUS(0)), 'snapping stays on the current revolution')

  const box: OrientedBox = { cx: 0, cy: 0, halfW: 10, halfH: 5, rotation: 0 }
  // From the +x axis to the +y axis about the center is a quarter turn.
  const delta = rotationDelta(box, { x: 10, y: 0 }, { x: 0, y: 10 })
  assert(near(delta, quarter), 'rotationDelta measures the turn about the box center')
  // Rotating to just shy of a quarter turn, with snaps on, lands exactly on it.
  const snapped = rotationDelta(box, { x: 10, y: 0 }, { x: 1, y: 10 }, snaps)
  assert(near(snapped, quarter), 'a near-quarter turn snaps to exactly a quarter')
}
function TWO_PI_PLUS(a: number): number {
  return a + Math.PI * 2
}

// --- applyWorldTransform: a world delta lands correctly on the node's own fields ---
{
  // Pure translation.
  const moved = new Rect({ x: 10, y: 20, width: 4, height: 4 })
  applyWorldTransform(moved, Matrix4x4.translation(new Vector3(5, -3, 0)))
  assert(near(moved.x, 15) && near(moved.y, 17), 'a translation delta moves the node')
  assert(near(moved.rotation, 0) && near(moved.scaleX, 1), 'and leaves rotation/scale alone')

  // Rotation about a point the node does not sit on.
  const spun = new Rect({ x: 10, y: 0, width: 2, height: 2 })
  applyWorldTransform(spun, rotateAbout({ x: 0, y: 0 }, Math.PI / 2))
  assert(near(spun.x, 0) && near(spun.y, 10), 'rotating about the origin swings the node around it')
  assert(near(spun.rotation, Math.PI / 2), 'and turns the node itself')

  // Scaling about a fixed corner: the fixed point must not move, the far side must double.
  const scaled = new Rect({ x: 0, y: 0, width: 10, height: 10 })
  const fixed = { x: -5, y: -5 }
  applyWorldTransform(scaled, scaleAbout(fixed, 0, 2, 2))
  const pts = corners(scaled)
  assert(
    pts.some((p) => near(p.x, -5) && near(p.y, -5)),
    'the fixed corner stays exactly where it was',
  )
  assert(
    pts.some((p) => near(p.x, 15) && near(p.y, 15)),
    'the opposite corner moves out by the scale factor',
  )
  assert(near(scaled.scaleX, 2) && near(scaled.scaleY, 2), "the node's own scale carries the change")

  // A mirroring delta shows up as a negative scale, not a broken rotation.
  const mirrored = new Rect({ x: 0, y: 0, width: 4, height: 4 })
  applyWorldTransform(mirrored, scaleAbout({ x: 0, y: 0 }, 0, -1, 1))
  assert(mirrored.scaleX < 0 || mirrored.scaleY < 0, 'a mirroring delta produces a negative scale')
}

// --- the delta reaches a node through a transformed PARENT, which is what makes
//     multi-select and nesting work without the transformer knowing the hierarchy ---
{
  class TransformGroup extends Container {
    matrix = Matrix4x4.identity()
    override localMatrix(): Matrix4x4 {
      return this.matrix
    }
  }

  const group = new TransformGroup()
  group.matrix = Matrix4x4.translation(new Vector3(100, -40, 0))
    .mul(Matrix4x4.rotationZ(0.6))
    .mul(Matrix4x4.scaling(new Vector3(2, 2, 1)))
  const child = group.addChild(new Rect({ x: 3, y: 7, width: 10, height: 6, rotation: 0.2 }))

  const before = corners(child)
  const delta = Matrix4x4.translation(new Vector3(25, -12, 0))
  applyWorldTransform(child, delta)
  const after = corners(child)
  for (let i = 0; i < before.length; i++) {
    assert(
      near(after[i].x - before[i].x, 25) && near(after[i].y - before[i].y, -12),
      'a world translation moves a nested node by exactly that much in WORLD space',
    )
  }

  // A uniform scale about a world point is exactly representable, so it should hold on a
  // rotated node under a rotated+scaled parent too - corner distances double, and the
  // fixed point is untouched.
  const pivot = { x: 10, y: 10 }
  const beforeScale = corners(child)
  applyWorldTransform(child, scaleAbout(pivot, 0, 2, 2))
  const afterScale = corners(child)
  for (let i = 0; i < beforeScale.length; i++) {
    assert(
      near(afterScale[i].x - pivot.x, (beforeScale[i].x - pivot.x) * 2) &&
        near(afterScale[i].y - pivot.y, (beforeScale[i].y - pivot.y) * 2),
      'a uniform scale about a world point is exact through a nested, rotated parent',
    )
  }
}

// --- a node's own pivot (offset) survives a transform ---
{
  const pivoted = new Rect({ x: 50, y: 50, width: 10, height: 10, offsetX: 4, offsetY: -2 })
  const before = corners(pivoted)
  applyWorldTransform(pivoted, Matrix4x4.translation(new Vector3(7, 7, 0)))
  const after = corners(pivoted)
  assert(pivoted.offsetX === 4 && pivoted.offsetY === -2, 'the pivot itself is left alone')
  for (let i = 0; i < before.length; i++) {
    assert(
      near(after[i].x - before[i].x, 7) && near(after[i].y - before[i].y, 7),
      'a node with a pivot still moves by exactly the world delta',
    )
  }
}

// --- worldRotationOf accumulates ancestors' rotation ---
{
  class TransformGroup extends Container {
    matrix = Matrix4x4.identity()
    override localMatrix(): Matrix4x4 {
      return this.matrix
    }
  }
  const group = new TransformGroup()
  group.matrix = Matrix4x4.rotationZ(0.5)
  const child = group.addChild(new Rect({ rotation: 0.25 }))
  assert(near(worldRotationOf(child), 0.75), "world rotation adds the parent's to the node's own")
}

// --- end to end: a resize gesture on a real node holds its opposite corner still ---
{
  const node = new Rect({ x: 0, y: 0, width: 100, height: 50 })
  const box = boxForNodes([node], localBoundsOf)!
  const held = anchorPosition(box, 'bottom-left')

  // Drag the top-right corner out to (100,50). Measured from the pinned bottom-left at
  // (-50,-25) that spans 150x75 against the original 100x50, i.e. 1.5x on both axes.
  const factors = resizeFactors(box, 'top-right', { x: 100, y: 50 })
  assert(near(factors.scaleX, 1.5) && near(factors.scaleY, 1.5), 'the drag works out to 1.5x on both axes')
  applyWorldTransform(node, scaleAbout(factors.fixed, factors.rotation, factors.scaleX, factors.scaleY))

  const after = boxForNodes([node], localBoundsOf)!
  const heldAfter = anchorPosition(after, 'bottom-left')
  assert(near(heldAfter.x, held.x) && near(heldAfter.y, held.y), 'the held corner does not budge during a resize')
  assert(near(after.halfW, 75) && near(after.halfH, 37.5), 'the box grows by the scale factor')
  const dragged = anchorPosition(after, 'top-right')
  assert(near(dragged.x, 100) && near(dragged.y, 50), 'the dragged corner lands exactly under the pointer')
}

console.log(`[shapes] self-test passed (${count} assertions)`)
