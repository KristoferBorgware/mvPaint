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
import { Transformer } from './Transformer'
import {
  ANCHOR_DIRECTION,
  anchorPosition,
  applyWorldTransform,
  boxForNodes,
  boxFromPoints,
  decompose2D,
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

// --- boxForNodes: every selection orients to the FIRST node's rotation, one node or many ---
{
  const solo = new Rect({ x: 100, y: 50, width: 40, height: 20, rotation: Math.PI / 4 })
  const box = boxForNodes([solo], localBoundsOf)!
  assert(near(box.rotation, Math.PI / 4), 'a single node gives a box turned to match it')
  assert(near(box.cx, 100) && near(box.cy, 50), "the box centers on the node's own bounds")
  assert(near(box.halfW, 20) && near(box.halfH, 10), 'and hugs it: half of 40x20, despite the rotation')

  // Two unrotated nodes: happens to look axis-aligned, but only because the FIRST one is
  // unrotated - not because multi-selection is special-cased to axis-aligned.
  const a = new Rect({ x: -50, y: 0, width: 20, height: 20 })
  const b = new Rect({ x: 50, y: 30, width: 20, height: 20 })
  const pair = boxForNodes([a, b], localBoundsOf)!
  assert(pair.rotation === 0, "an unrotated first node gives an axis-aligned box")
  assert(near(pair.cx, 0) && near(pair.cy, 15), 'the multi-node box centers on the union')
  assert(near(pair.halfW, 60) && near(pair.halfH, 25), 'the multi-node box spans every node')

  // REGRESSION: a multi-node box used to be forced axis-aligned regardless of any
  // member's rotation - which meant that during a rotate drag, re-fitting the box every
  // frame (as the renderer does) kept resetting it back to axis-aligned, so the frame
  // never appeared to rotate with the selection even though the nodes genuinely were.
  // Order matters: it's the FIRST selected node, not any rotated node in the set.
  const rotatedFirst = new Rect({ x: 0, y: 0, width: 20, height: 20, rotation: Math.PI / 4 })
  const unrotatedSecond = new Rect({ x: 100, y: 0, width: 20, height: 20 })
  const orientedToFirst = boxForNodes([rotatedFirst, unrotatedSecond], localBoundsOf)!
  assert(near(orientedToFirst.rotation, Math.PI / 4), 'a multi-node box orients to the FIRST selected node, not axis-aligned')

  const reordered = boxForNodes([unrotatedSecond, rotatedFirst], localBoundsOf)!
  assert(near(reordered.rotation, 0), 'reversing selection order changes which node orients the box')

  assert(boxForNodes([], localBoundsOf) === null, 'no nodes gives no box')
}

// --- REGRESSION: the box orientation must survive a live rotate gesture, i.e. re-fitting
//     the box every frame (as the renderer does mid-drag) must show the selection turning,
//     not snap back to axis-aligned - the bug the fix above addresses end to end ---
{
  const upright = new Rect({ x: -100, y: 0, width: 120, height: 40 })
  const turned = new Rect({ x: 100, y: 0, width: 120, height: 40, rotation: Math.PI / 4 })
  const selection = [turned, upright] // turned selected FIRST

  const pressBox = boxForNodes(selection, localBoundsOf)!
  assert(near(pressBox.rotation, Math.PI / 4), 'the box starts oriented to the first-selected (turned) node')

  const startWorld = rotateAnchorPosition(pressBox, 24)
  const starts = selection.map((n) => n.captureTransform())

  // Sweep the rotate handle through several steps, re-fitting the box after each one -
  // exactly what happens once per frame during a live drag.
  let lastBoxRotation = pressBox.rotation
  for (const sweepDeg of [10, 25, 45, 70]) {
    selection.forEach((n, i) => n.restoreTransform(starts[i]))
    const angle = (sweepDeg * Math.PI) / 180
    const pointer = rotateAbout({ x: pressBox.cx, y: pressBox.cy }, angle).transformPoint(
      new Vector3(startWorld.x, startWorld.y, 0),
    )
    const delta = rotationDelta(pressBox, startWorld, { x: pointer.x, y: pointer.y })
    const D = rotateAbout({ x: pressBox.cx, y: pressBox.cy }, delta)
    for (const n of selection) applyWorldTransform(n, D)

    const refit = boxForNodes(selection, localBoundsOf)!
    assert(
      near(refit.rotation, pressBox.rotation + angle, 1e-3),
      `re-fitting mid-drag reports the box actually turning (swept ${sweepDeg} deg)`,
    )
    assert(!near(refit.rotation, lastBoxRotation), 'each step is a genuinely different orientation from the last')
    lastBoxRotation = refit.rotation
  }
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

// --- skew makes the decomposition EXACT: non-uniformly scaling a ROTATED node used to
//     produce a sheared matrix with nowhere to store the shear, so it could only be
//     approximated. With skewX/skewY on Shape, rotate+skew+scale spans every invertible
//     2x2 and the result is reproduced to the last decimal ---
{
  const node = new Rect({ x: 30, y: -20, width: 80, height: 40, rotation: 0.7 })
  const before = corners(node)
  // Squash x, stretch y, about a point the node does not sit on - the case that shears.
  const pivot = { x: -15, y: 25 }
  const delta = scaleAbout(pivot, 0, 0.4, 2.5)
  applyWorldTransform(node, delta)
  const after = corners(node)

  for (let i = 0; i < before.length; i++) {
    const expectedX = pivot.x + (before[i].x - pivot.x) * 0.4
    const expectedY = pivot.y + (before[i].y - pivot.y) * 2.5
    assert(
      near(after[i].x, expectedX, 1e-3) && near(after[i].y, expectedY, 1e-3),
      'non-uniformly scaling a rotated node lands exactly on the intended corners',
    )
  }
  assert(node.skewX !== 0, 'the shear that scaling a rotated node produces is stored, not discarded')

  // The same, in a rotated FRAME rather than along the world axes, on a node that is
  // already skewed - the general case; still exact.
  const gnarly = new Rect({ x: 5, y: 5, width: 30, height: 70, rotation: -0.4, skewX: 0.3, skewY: -0.15 })
  const g0 = corners(gnarly)
  const gPivot = { x: 12, y: -8 }
  applyWorldTransform(gnarly, scaleAbout(gPivot, 0.9, 1.8, 0.5))
  const g1 = corners(gnarly)
  // Reproduce the delta independently and compare.
  const expected = g0.map((p) => {
    const m = scaleAbout(gPivot, 0.9, 1.8, 0.5)
    const v = m.transformPoint(new Vector3(p.x, p.y, 0))
    return { x: v.x, y: v.y }
  })
  for (let i = 0; i < g0.length; i++) {
    assert(
      near(g1[i].x, expected[i].x, 1e-3) && near(g1[i].y, expected[i].y, 1e-3),
      'an arbitrary affine delta on an already-skewed, rotated node is exact',
    )
  }
}

// --- decompose2D round-trips through Shape's own transform composition ---
{
  for (const source of [
    new Rect({ rotation: 0.9, scaleX: 2, scaleY: 0.5 }),
    new Rect({ rotation: -1.2, scaleX: -1.5, scaleY: 3, skewX: 0.6 }),
    new Rect({ skewX: -0.4, skewY: 0.25, scaleX: 1.3, scaleY: 1.3 }),
  ]) {
    const m = source.localMatrix().m
    const parts = decompose2D(m[0], m[1], m[4], m[5])
    const rebuilt = new Rect({
      rotation: parts.rotation,
      scaleX: parts.scaleX,
      scaleY: parts.scaleY,
      skewX: parts.skewX,
      skewY: parts.skewY,
    })
    const r = rebuilt.localMatrix().m
    assert(
      near(r[0], m[0], 1e-4) && near(r[1], m[1], 1e-4) && near(r[4], m[4], 1e-4) && near(r[5], m[5], 1e-4),
      'decomposing a transform and rebuilding it reproduces the same matrix',
    )
  }
}

// --- skew composes between rotation and scale ---
{
  // A pure skewX shifts x in proportion to y, leaving y alone.
  const sheared = new Rect({ skewX: 0.5 })
  const p = sheared.localMatrix().transformPoint(new Vector3(0, 10, 0))
  assert(near(p.x, 5) && near(p.y, 10), 'skewX slides x by skewX per unit of y')

  const shearedY = new Rect({ skewY: -0.25 })
  const q = shearedY.localMatrix().transformPoint(new Vector3(8, 0, 0))
  assert(near(q.x, 8) && near(q.y, -2), 'skewY slides y by skewY per unit of x')

  assert(new Rect().skewX === 0 && new Rect().skewY === 0, 'skew defaults to none')
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

// --- REGRESSION: a non-uniform scale on a multi-node selection whose members are
//     rotated differently used to run away within a few pointer moves. The axis-aligned
//     box around a turned member shears it, and the gesture's per-move restore was
//     putting back x/y/rotation/scale but NOT the skew - so each move compounded onto the
//     last one's shear instead of replacing it. The invariant: replaying a drag through
//     intermediate pointer positions must land exactly where going straight there would ---
{
  const makeSelection = () => [
    new Rect({ x: -100, y: 0, width: 120, height: 40 }),
    new Rect({ x: 100, y: 0, width: 120, height: 40, rotation: Math.PI / 4 }),
  ]

  // Exactly what the controller does on each pointermove: restore, then apply one delta.
  const dragTo = (nodes: Shape[], box: OrientedBox, starts: ReturnType<Shape['captureTransform']>[], pointerX: number) => {
    nodes.forEach((node, i) => node.restoreTransform(starts[i]))
    const factors = resizeFactors(box, 'middle-right', { x: pointerX, y: box.cy })
    const delta = scaleAbout(factors.fixed, factors.rotation, factors.scaleX, factors.scaleY)
    for (const node of nodes) applyWorldTransform(node, delta)
  }

  const stepped = makeSelection()
  const steppedBox = boxForNodes(stepped, localBoundsOf)!
  const steppedStarts = stepped.map((n) => n.captureTransform())
  const target = steppedBox.cx + steppedBox.halfW + 120
  for (const offset of [15, 40, 75, 120]) {
    dragTo(stepped, steppedBox, steppedStarts, steppedBox.cx + steppedBox.halfW + offset)
  }

  const direct = makeSelection()
  const directBox = boxForNodes(direct, localBoundsOf)!
  const directStarts = direct.map((n) => n.captureTransform())
  dragTo(direct, directBox, directStarts, target)

  for (let i = 0; i < stepped.length; i++) {
    const viaSteps = corners(stepped[i])
    const straight = corners(direct[i])
    for (let c = 0; c < viaSteps.length; c++) {
      assert(
        near(viaSteps[c].x, straight[c].x, 1e-4) && near(viaSteps[c].y, straight[c].y, 1e-4),
        'a stepped non-uniform drag on a mixed-rotation selection lands exactly where a direct one does',
      )
    }
  }

  // And the shear itself stays in the sane range the single direct move produces, rather
  // than growing without bound the way the partial restore made it.
  assert(near(stepped[1].skewX, direct[1].skewX, 1e-4), 'the rotated member ends with exactly the intended shear')
  assert(Math.abs(stepped[1].skewX) < 1, 'the shear stays bounded instead of running away')
  assert(near(stepped[0].skewX, 0, 1e-9), 'the unrotated member picks up no shear at all')

  // captureTransform/restoreTransform must cover every field localMatrix() reads - the
  // omission of one is what caused this in the first place.
  const probe = new Rect({ x: 3, y: 4, rotation: 0.3, scaleX: 2, scaleY: 0.5, skewX: 0.4, skewY: -0.2, offsetX: 7, offsetY: -1 })
  const captured = probe.captureTransform()
  const beforeMatrix = [...probe.localMatrix().m]
  probe.x = 0; probe.y = 0; probe.rotation = 0; probe.scaleX = 1; probe.scaleY = 1
  probe.skewX = 0; probe.skewY = 0; probe.offsetX = 0; probe.offsetY = 0
  probe.restoreTransform(captured)
  const afterMatrix = probe.localMatrix().m
  assert(
    beforeMatrix.every((v, i) => near(v, afterMatrix[i], 1e-9)),
    'restoring a captured transform reproduces the local matrix exactly',
  )
}

// --- Transformer: the frame re-fits itself as the selection changes shape, and does it
//     entirely through transforms so nothing ever needs a geometry rebuild ---
{
  const node = new Rect({ x: 0, y: 0, width: 100, height: 50 })
  const t = new Transformer()
  t.attach([node])

  const fit = () => t.update(boxForNodes(t.selection, localBoundsOf), 1)
  const edge = (name: string) => {
    let found: Rect | null = null
    t.traversePreOrder((n) => {
      if ((n as Rect).name === `__transformer-${name}`) found = n as Rect
    })
    return found!
  }

  fit()
  const top = edge('top')
  const widthBefore = top.scaleX
  assert(widthBefore > 100, 'the frame spans the selection plus its padding')
  assert(top.scaleX !== 0 && top.scaleY !== 0, 'the frame shows (non-zero scale) once something is selected')

  // THE BUG THIS COVERS: scaling the node used to leave the frame at its old size,
  // because a Rect's width/height are baked geometry and only the renderer can trigger
  // the rebuild that would re-upload them. The frame is now sized by scale instead, so
  // re-fitting it is a pure transform change that takes effect immediately.
  applyWorldTransform(node, scaleAbout({ x: 0, y: 0 }, 0, 2, 2))
  fit()
  const grown = boxForNodes(t.selection, localBoundsOf)!
  // The padding is a fixed number of screen pixels, so it is added after the scaling
  // rather than doubling with it.
  const expectedWidth = (grown.halfW + t.padding) * 2 + t.borderWidth
  assert(near(edge('top').scaleX, expectedWidth, 1e-3), 'the frame re-fits itself to the resized selection')
  assert(edge('top').scaleX > widthBefore * 1.8, 'and really did grow, rather than staying at its old size')

  // Rotating the selection turns the frame with it.
  applyWorldTransform(node, rotateAbout({ x: 0, y: 0 }, Math.PI / 6))
  fit()
  assert(near(edge('top').rotation, Math.PI / 6, 1e-3), 'the frame turns with the selection')

  // Every part is a unit quad driven purely by transform - never resized or stroked, so
  // the frame costs no geometry rebuilds however much the selection moves.
  let parts = 0
  t.traversePreOrder((n) => {
    const r = n as Rect
    if (r === (t as unknown as Rect) || typeof r.strokeWidth !== 'number') return
    parts++
    assert(r.width === 1 && r.height === 1, 'every transformer part stays a unit quad')
    assert(r.strokeWidth === 0, 'transformer parts are fill-only, so nothing re-tessellates')
    assert(r.overlay, 'transformer parts draw in the always-on-top overlay pass')
    assert(!r.pickable && !r.draggable, 'transformer parts are never picked or dragged as content')
  })
  assert(parts === 4 + 9 * 2, 'four border edges plus two quads for each of the nine handles')

  // Handles are found by proximity in world space, and corners beat the edges they touch.
  const box = boxForNodes(t.selection, localBoundsOf)!
  assert(t.anchorAt(anchorPosition(box, 'top-right').x, anchorPosition(box, 'top-right').y) === 'top-right', 'a corner handle is picked at its own position')
  assert(t.anchorAt(box.cx, box.cy) === null, 'the middle of the frame is not a handle')

  // Detaching hides the whole frame - via zero scale, not Shape.visible (see Transformer's
  // class comment: staying visible=true keeps every part in the mesh batcher's shape set
  // permanently, so selecting/deselecting never forces the whole scene's geometry to rebuild).
  t.detach()
  assert(edge('top').visible, 'transformer parts stay Shape.visible even when hidden')
  assert(edge('top').scaleX === 0 && edge('top').scaleY === 0, 'clearing the selection hides the frame via zero scale')
  assert(t.currentBox === null, 'and drops its box')
}

// --- Shadow: the canvas 2D property model, and the atlas cache key that drives re-baking ---
{
  const plain = new Rect({ width: 10, height: 10 })
  assert(!plain.hasShadow(), 'a shape with no shadow fields set casts nothing')
  assert(plain.shadowEnabled && plain.shadowOpacity === 1 && plain.shadowForStrokeEnabled, 'shadow defaults match the canvas library (enabled, opaque, stroke included)')

  // A blur alone, or an offset alone, is enough - but a shadow with neither would sit
  // exactly behind the shape and never be visible, so it does not count.
  assert(new Rect({ shadowBlur: 4 }).hasShadow(), 'blur alone casts a shadow')
  assert(new Rect({ shadowOffsetY: 3 }).hasShadow(), 'offset alone casts a shadow')
  assert(new Rect({ shadowSpread: 5 }).hasShadow(), 'spread alone casts a shadow (a crisp halo)')
  assert(!new Rect({ shadowColor: [0, 0, 0, 1] }).hasShadow(), 'colour alone, with no blur, spread or offset, casts nothing')

  assert(!new Rect({ shadowBlur: 4, shadowEnabled: false }).hasShadow(), 'shadowEnabled=false suppresses it')
  assert(!new Rect({ shadowBlur: 4, shadowOpacity: 0 }).hasShadow(), 'zero opacity suppresses it')
  assert(!new Rect({ shadowBlur: 4, shadowColor: [0, 0, 0, 0] }).hasShadow(), 'a fully transparent colour suppresses it')

  // geometryVersion is what the shadow atlas keys its baked silhouette on: it must move
  // when the geometry does, and stay put when only the transform does - otherwise every
  // drag would re-bake every shadow.
  assert(new Rect({}).shadowSpread === 0, 'spread defaults to none, so the canvas model is what you get unless you ask')

  const shape = new Rect({ width: 10, height: 10, shadowBlur: 3 })
  const v0 = shape.geometryVersion
  shape.x = 500
  shape.rotation = 1
  shape.scaleX = 3
  assert(shape.geometryVersion === v0, 'moving/rotating/scaling never invalidates the baked silhouette')
  shape.width = 40
  shape.markGeometryDirty()
  assert(shape.geometryVersion !== v0, 'a real geometry change does invalidate it')
}

console.log(`[shapes] self-test passed (${count} assertions)`)
