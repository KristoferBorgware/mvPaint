// Self-test for the Transformer's math (shapes/transformerMath.ts): selection boxes,
// anchor placement, resize factors, rotation snapping, and pushing a world-space delta
// back onto a node. Pure geometry, no canvas or GPU - the Transformer node itself is a
// thin layer of scene bookkeeping over these and isn't covered here. Run with:
//   npx tsx src/shapes/selfTest.ts

import { listenerCount, resetListenerCensus } from '../events/listenerCensus'
import type { NodeEvent } from '../events/NodeEvent'
import { AABB } from '../math/AABB'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Vector3 } from '../math/Vector3'
import { Container } from './Container'
import { Node } from './Node'
import { Circle } from './Circle'
import { meshGeometryEpoch, textShapingEpoch } from './contentEpoch'
import { Rect, type RectOptions } from './Rect'
import type { Shape } from './Shape'
import { Group, closestGroup, draggableGroup, hiddenByGroup, outermostGroup, type TransformableNode } from './Group'
import { nextZIndex, peekZIndex, resetAutoZIndex } from './zOrder'
import { Layer } from './Layer'
import { Text } from './Text'
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

/**
 * A Rect CENTRED on (x, y). A Rect's own origin is its top-left corner (see Shape's
 * header), so this applies the pivot offset that puts its middle back on the position -
 * which is the frame the geometry below is written in.
 */
const centredRect = (options: RectOptions = {}): Rect =>
  new Rect({ ...options, offsetX: (options.width ?? 1) / 2, offsetY: -(options.height ?? 1) / 2 })



const localBoundsOf = (node: TransformableNode): AABB | null =>
  node instanceof Group ? node.bounds() : node.localBounds()

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



// --- content epochs: how a lane finds out that a node re-shaped or re-tessellated -------
//
// A lane packs many nodes into one shared buffer and never revisits them, so a node whose
// CONTENT changes in place has to say so lane-wide. Without it the buffer keeps the geometry
// it was packed with, and an animated content change never reaches the screen - which is
// exactly what froze text following a curve while its offset advanced every frame.
{
  const rect = new Rect({ width: 10, height: 10 })
  const text = new Text({ text: 'hello' })

  // A transform is re-uploaded every frame from the world matrix and never packed into the
  // buffers, so moving a node must NOT trigger a rebuild of anything.
  const quietMesh = meshGeometryEpoch()
  const quietText = textShapingEpoch()
  rect.x = 40
  rect.rotation = 1
  rect.scaleX = 2
  text.y = -10
  assert(meshGeometryEpoch() === quietMesh, 'moving a shape does not disturb the mesh epoch')
  assert(textShapingEpoch() === quietText, 'nor the text epoch')

  // Geometry, though, is packed - so changing it has to be announced.
  rect.markGeometryDirty()
  assert(meshGeometryEpoch() > quietMesh, 'a geometry change bumps the mesh epoch')
  const afterGeometry = meshGeometryEpoch()
  assert(textShapingEpoch() === quietText, 'and leaves the text epoch alone')

  // Every route into a re-shape counts, whichever one a caller reaches for.
  text.setText('replaced')
  assert(textShapingEpoch() > quietText, 'replacing the text bumps the text epoch')
  let last = textShapingEpoch()

  text.setRuns([{ text: 'runs' }])
  assert(textShapingEpoch() > last, 'so does replacing the runs')
  last = textShapingEpoch()

  // The route the curve animation uses: edit a layout option in place, then say so.
  text.align = 'center'
  text.markDirty()
  assert(textShapingEpoch() > last, 'and so does markDirty() after editing a layout option in place')
  assert(meshGeometryEpoch() === afterGeometry, 'text re-shaping never bumps the mesh epoch')
}

// --- where each shape's origin sits --------------------------------------------------
//
// The convention, asserted on the geometry the shapes actually emit: elliptical shapes are
// centred on their origin, everything cornered hangs from its top-left corner and extends
// right and downward (the scene is y-up, so downward is -y). Getting this wrong is not a
// subtle matter of taste - it moves every shape by half its own size, and moves the pivot
// it rotates about.
{
  const b = (shape: Shape) => shape.localBounds()

  const rect = new Rect({ width: 40, height: 20 })
  assert(near(b(rect).min.x, 0) && near(b(rect).max.x, 40), 'a rect starts at its origin in x and runs right')
  assert(near(b(rect).max.y, 0) && near(b(rect).min.y, -20), 'and starts at its origin in y and hangs down')

  // The position places that corner, so the shape is entirely below and right of it.
  const placed = new Rect({ x: 100, y: 200, width: 40, height: 20 })
  const world = placed.worldMatrix()
  const topLeft = world.transformPoint(new Vector3(0, 0, 0))
  assert(near(topLeft.x, 100) && near(topLeft.y, 200), "the node's position IS the rect's top-left corner")
  const bottomRight = world.transformPoint(new Vector3(40, -20, 0))
  assert(near(bottomRight.x, 140) && near(bottomRight.y, 180), 'and the far corner is width right, height down')

  // A circle is measured from the middle, so the middle is where it sits.
  const circle = new Circle({ x: 100, y: 200, radius: 20 })
  // Symmetric to within the polygon approximation: the rim lands on whole segments, so
  // opposite extremes need not be the same sample.
  const cb = b(circle)
  assert(near(cb.min.x, -cb.max.x, 0.05) && near(cb.min.y, -cb.max.y, 0.05), 'a circle is symmetric about its origin')
  assert(near(cb.max.x, 20, 0.05), 'reaching its radius from it')
  const centre = circle.worldMatrix().transformPoint(new Vector3(0, 0, 0))
  assert(near(centre.x, 100) && near(centre.y, 200), "the node's position IS the circle's centre")

  // Which makes the pivot differ, and that is the part worth stating out loud: turning a
  // rect half a turn swings it about its corner, while a circle only spins in place.
  const turned = new Rect({ x: 0, y: 0, width: 40, height: 20, rotation: Math.PI })
  const swung = turned.worldMatrix().transformPoint(new Vector3(40, -20, 0))
  assert(near(swung.x, -40) && near(swung.y, 20), 'a rect turns about its corner, swinging its body across the origin')

  // Unless it is told otherwise - the documented way to get the old behaviour back.
  const pivoted = new Rect({ x: 0, y: 0, width: 40, height: 20, offsetX: 20, offsetY: -10, rotation: Math.PI })
  const stayed = pivoted.worldMatrix().transformPoint(new Vector3(20, -10, 0))
  assert(near(stayed.x, 0) && near(stayed.y, 0), 'a centring offset puts the pivot back in the middle')
  const pb = pivoted.localBounds()
  assert(near(pb.min.x, 0) && near(pb.max.x, 40), 'and changes nothing about the geometry it emits')
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
  // Pivoted at its middle (a Rect's origin is its top-left corner - see Shape's header),
  // so the node's centre is at (100, 50) whatever it is rotated by.
  const solo = new Rect({ x: 100, y: 50, width: 40, height: 20, offsetX: 20, offsetY: -10, rotation: Math.PI / 4 })
  const box = boxForNodes([solo], localBoundsOf)!
  assert(near(box.rotation, Math.PI / 4), 'a single node gives a box turned to match it')
  assert(near(box.cx, 100) && near(box.cy, 50), "the box centers on the node's own bounds")
  assert(near(box.halfW, 20) && near(box.halfH, 10), 'and hugs it: half of 40x20, despite the rotation')

  // Two unrotated nodes: happens to look axis-aligned, but only because the FIRST one is
  // unrotated - not because multi-selection is special-cased to axis-aligned.
  const a = centredRect({ x: -50, y: 0, width: 20, height: 20 })
  const b = centredRect({ x: 50, y: 30, width: 20, height: 20 })
  const pair = boxForNodes([a, b], localBoundsOf)!
  assert(pair.rotation === 0, "an unrotated first node gives an axis-aligned box")
  assert(near(pair.cx, 0) && near(pair.cy, 15), 'the multi-node box centers on the union')
  assert(near(pair.halfW, 60) && near(pair.halfH, 25), 'the multi-node box spans every node')

  // REGRESSION: a multi-node box used to be forced axis-aligned regardless of any
  // member's rotation - which meant that during a rotate drag, re-fitting the box every
  // frame (as the renderer does) kept resetting it back to axis-aligned, so the frame
  // never appeared to rotate with the selection even though the nodes genuinely were.
  // Order matters: it's the FIRST selected node, not any rotated node in the set.
  const rotatedFirst = centredRect({ x: 0, y: 0, width: 20, height: 20, rotation: Math.PI / 4 })
  const unrotatedSecond = centredRect({ x: 100, y: 0, width: 20, height: 20 })
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
  const upright = centredRect({ x: -100, y: 0, width: 120, height: 40 })
  const turned = centredRect({ x: 100, y: 0, width: 120, height: 40, rotation: Math.PI / 4 })
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
  const moved = centredRect({ x: 10, y: 20, width: 4, height: 4 })
  applyWorldTransform(moved, Matrix4x4.translation(new Vector3(5, -3, 0)))
  assert(near(moved.x, 15) && near(moved.y, 17), 'a translation delta moves the node')
  assert(near(moved.rotation, 0) && near(moved.scaleX, 1), 'and leaves rotation/scale alone')

  // Rotation about a point the node does not sit on.
  const spun = centredRect({ x: 10, y: 0, width: 2, height: 2 })
  applyWorldTransform(spun, rotateAbout({ x: 0, y: 0 }, Math.PI / 2))
  assert(near(spun.x, 0) && near(spun.y, 10), 'rotating about the origin swings the node around it')
  assert(near(spun.rotation, Math.PI / 2), 'and turns the node itself')

  // Scaling about a fixed corner: the fixed point must not move, the far side must double.
  const scaled = centredRect({ x: 0, y: 0, width: 10, height: 10 })
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
  const mirrored = centredRect({ x: 0, y: 0, width: 4, height: 4 })
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
  const child = group.addChild(centredRect({ x: 3, y: 7, width: 10, height: 6, rotation: 0.2 }))

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
  const node = centredRect({ x: 30, y: -20, width: 80, height: 40, rotation: 0.7 })
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
  const gnarly = centredRect({ x: 5, y: 5, width: 30, height: 70, rotation: -0.4, skewX: 0.3, skewY: -0.15 })
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
    centredRect({ rotation: 0.9, scaleX: 2, scaleY: 0.5 }),
    centredRect({ rotation: -1.2, scaleX: -1.5, scaleY: 3, skewX: 0.6 }),
    centredRect({ skewX: -0.4, skewY: 0.25, scaleX: 1.3, scaleY: 1.3 }),
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
//
// Read straight off localMatrix(), so these are plain Rects: a pivot offset is part of that
// matrix and would shift every point sampled below.
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
  const child = group.addChild(centredRect({ rotation: 0.25 }))
  assert(near(worldRotationOf(child), 0.75), "world rotation adds the parent's to the node's own")
}

// --- end to end: a resize gesture on a real node holds its opposite corner still ---
{
  const node = centredRect({ x: 0, y: 0, width: 100, height: 50 })
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
    centredRect({ x: -100, y: 0, width: 120, height: 40 }),
    centredRect({ x: 100, y: 0, width: 120, height: 40, rotation: Math.PI / 4 }),
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
  const node = centredRect({ x: 0, y: 0, width: 100, height: 50 })
  const t = new Transformer()
  t.attach([node])

  const fit = () => t.update(boxForNodes(t.nodes, localBoundsOf), 1)
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
  const grown = boxForNodes(t.nodes, localBoundsOf)!
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
  const box = boxForNodes(t.nodes, localBoundsOf)!
  assert(t.anchorAt(anchorPosition(box, 'top-right').x, anchorPosition(box, 'top-right').y) === 'top-right', 'a corner handle is picked at its own position')
  assert(t.anchorAt(box.cx, box.cy) === null, 'the middle of the frame is not a handle')

  // Clearing hides the whole frame - via zero scale, not Shape.visible (see Transformer's
  // class comment: staying visible=true keeps every part in the mesh batcher's shape set
  // permanently, so attaching/clearing never forces the whole scene's geometry to rebuild).
  t.clear()
  assert(edge('top').visible, 'transformer parts stay Shape.visible even when hidden')
  assert(edge('top').scaleX === 0 && edge('top').scaleY === 0, 'clearing the attached set hides the frame via zero scale')
  assert(t.currentBox === null, 'and drops its box')
}

// --- Transformer: the box never describes a set other than the one attached ---
//
// It is fitted by the owner once a frame, not here (fitting has to measure the nodes, and
// measuring a Text needs a font book this shape cannot reach), so between a change to the
// set and the next refit there is nothing valid to report. Saying so is the point: `nodes`
// and `currentBox` read together must never describe two different selections, or a
// transform started in that window moves the new selection about the old one's centre.
{
  const first = centredRect({ x: 0, y: 0, width: 100, height: 50 })
  const second = centredRect({ x: 400, y: 300, width: 60, height: 60 })
  const t = new Transformer()
  const fit = () => t.update(boxForNodes(t.nodes, localBoundsOf), 1)

  t.attach([first])
  fit()
  const fitted = t.currentBox!
  assert(fitted !== null && near(fitted.cx, 0) && near(fitted.cy, 0), 'a refit box is fitted to what is attached')
  assert(t.anchorAt(anchorPosition(fitted, 'top-right').x, anchorPosition(fitted, 'top-right').y) === 'top-right', 'and its handles can be grabbed')

  // Replacing the set invalidates the box rather than leaving the old one to be read.
  t.attach([second])
  assert(t.currentBox === null, 'replacing the attached set drops the box fitted to the old one')
  assert(t.anchorAt(anchorPosition(fitted, 'top-right').x, anchorPosition(fitted, 'top-right').y) === null, 'so no handle of the stale frame can be grabbed')
  fit()
  assert(near(t.currentBox!.cx, 400) && near(t.currentBox!.cy, 300), 'the next refit fits the new selection')

  // Adding and removing invalidate it too - the box describes a set, not just a count.
  t.add(first)
  assert(t.currentBox === null, 'adding a node drops it as well')
  fit()
  const both = t.currentBox!
  assert(both.halfW > 200, 'a refit spans both nodes')
  t.detach(first)
  assert(t.currentBox === null, 'and so does removing one')

  // A no-op call changes nothing, so it must not invalidate a perfectly good box either.
  fit()
  const settled = t.currentBox
  t.attach([second])
  assert(t.currentBox === settled, 'attaching the set already attached leaves the box alone')
  t.detach(first)
  assert(t.currentBox === settled, 'and so does removing a node that is not attached')
}

// --- Transformer: the attached set, which the application drives one node at a time ---
{
  resetListenerCensus()
  const t = new Transformer()
  const a = centredRect({ x: 0, y: 0, width: 10, height: 10 })
  const b = centredRect({ x: 40, y: 0, width: 10, height: 10 })
  const c = centredRect({ x: 80, y: 0, width: 10, height: 10 })
  const changes: (readonly Shape[])[] = []
  t.on('attachchange', (e) => changes.push((e as NodeEvent & { nodes: readonly Shape[] }).nodes))

  assert(t.nodes.length === 0, 'a fresh transformer holds nothing')

  t.add(a)
  assert(t.nodes.length === 1 && t.has(a), 'add() attaches one node')
  t.add(b)
  assert(t.nodes.length === 2 && t.has(b), 'and another alongside it')
  t.add(a)
  assert(t.nodes.length === 2, 'adding one already attached changes nothing')
  assert(changes.length === 2, 'and announces nothing either')

  t.detach(b)
  assert(t.nodes.length === 1 && !t.has(b), 'remove() detaches just that node')
  t.detach(b)
  assert(changes.length === 3, 'removing one that is not attached announces nothing')

  t.toggle(c)
  assert(t.has(c), 'toggle() attaches a node that was absent')
  t.toggle(c)
  assert(!t.has(c), 'and detaches one that was present')

  // attach() replaces wholesale, and only reports a genuine change.
  const before = changes.length
  t.attach([a])
  assert(changes.length === before, 'attaching the set it already holds announces nothing')
  t.attach([b, c])
  assert(t.nodes.length === 2 && t.has(b) && t.has(c) && !t.has(a), 'attach() replaces the whole set')
  assert(changes[changes.length - 1].length === 2, 'and announces what it now holds')

  t.clear()
  assert(t.nodes.length === 0, 'clear() empties it')

  // The frame's own parts can never end up inside the set it is framing.
  const ownPart = t.children[0] as Rect
  t.add(ownPart)
  assert(t.nodes.length === 0, "the transformer refuses to attach its own visuals")
  t.attach([ownPart, a])
  assert(t.nodes.length === 1 && t.nodes[0] === a, 'and filters them out of a wholesale attach too')

  resetListenerCensus()
}

// --- Shadow: the canvas 2D property model, and the atlas cache key that drives re-baking ---
{
  const plain = centredRect({ width: 10, height: 10 })
  assert(!plain.hasShadow(), 'a shape with no shadow fields set casts nothing')
  assert(plain.shadowEnabled && plain.shadowOpacity === 1 && plain.shadowForStrokeEnabled, 'shadow defaults match the canvas library (enabled, opaque, stroke included)')

  // A blur alone, or an offset alone, is enough - but a shadow with neither would sit
  // exactly behind the shape and never be visible, so it does not count.
  assert(centredRect({ shadowBlur: 4 }).hasShadow(), 'blur alone casts a shadow')
  assert(centredRect({ shadowOffsetY: 3 }).hasShadow(), 'offset alone casts a shadow')
  assert(centredRect({ shadowSpread: 5 }).hasShadow(), 'spread alone casts a shadow (a crisp halo)')
  assert(!centredRect({ shadowColor: [0, 0, 0, 1] }).hasShadow(), 'colour alone, with no blur, spread or offset, casts nothing')

  assert(!centredRect({ shadowBlur: 4, shadowEnabled: false }).hasShadow(), 'shadowEnabled=false suppresses it')
  assert(!centredRect({ shadowBlur: 4, shadowOpacity: 0 }).hasShadow(), 'zero opacity suppresses it')
  assert(!centredRect({ shadowBlur: 4, shadowColor: [0, 0, 0, 0] }).hasShadow(), 'a fully transparent colour suppresses it')

  // geometryVersion is what the shadow atlas keys its baked silhouette on: it must move
  // when the geometry does, and stay put when only the transform does - otherwise every
  // drag would re-bake every shadow.
  assert(centredRect({}).shadowSpread === 0, 'spread defaults to none, so the canvas model is what you get unless you ask')

  const shape = centredRect({ width: 10, height: 10, shadowBlur: 3 })
  const v0 = shape.geometryVersion
  shape.x = 500
  shape.rotation = 1
  shape.scaleX = 3
  assert(shape.geometryVersion === v0, 'moving/rotating/scaling never invalidates the baked silhouette')
  shape.width = 40
  shape.markGeometryDirty()
  assert(shape.geometryVersion !== v0, 'a real geometry change does invalidate it')
}

// --- Node identity: id, name (a space-separated tag list), nodeName/nodeType, and
// the '#id' / '.name' / Type selector syntax used by matches()/find()/findOne()/
// findAncestor(s)() ---
{
  const root = new Container('root')
  const group = root.addChild(new Container('group'))
  const a = group.addChild(centredRect({ name: 'box selected', id: 'a' }))
  const b = group.addChild(centredRect({ name: 'box', id: 'b' }))
  const nested = group.addChild(new Container('nested'))
  const c = nested.addChild(centredRect({ id: 'c' }))
  const asSortedIds = (nodes: { id: string }[]) =>
    nodes
      .map((n) => n.id)
      .sort()
      .join(',')

  assert(a.nodeName === 'Rect' && a.nodeType === 'Shape', 'nodeName is the concrete class, nodeType is the scene-graph tier')
  assert(group.nodeName === 'Container' && group.nodeType === 'Container', 'a plain group is its own nodeName and tier')

  assert(a.hasName('box') && a.hasName('selected'), 'name holds multiple space-separated tags')
  assert(!a.hasName('missing'), 'hasName misses a tag that is not present')
  a.addName('extra')
  assert(a.hasName('extra') && a.name === 'box selected extra', 'addName appends a tag')
  a.addName('extra')
  assert(a.name === 'box selected extra', 'addName is a no-op if the tag is already present')
  a.removeName('selected')
  assert(!a.hasName('selected') && a.name === 'box extra', 'removeName drops just that tag')
  a.addName('selected') // restore for the selector checks below

  assert(root.findOne('#a') === a, "'#id' selects by id")
  assert(root.findOne('#b') === b, "'#id' distinguishes between two nodes of the same class")
  assert(root.findOne('#missing') === null, "'#id' misses an absent id")
  assert(asSortedIds(root.find('.box')) === 'a,b', "'.name' selects every node carrying that tag")
  assert(asSortedIds(root.find('.selected')) === 'a', "'.name' only matches nodes carrying that exact tag")
  assert(asSortedIds(root.find('Rect')) === 'a,b,c', "a bare word selects by nodeName")
  assert(asSortedIds(root.find('Shape')) === 'a,b,c', "a bare word also selects by nodeType, matching every concrete subclass")
  assert(root.find('Container').length === 2, "nodeType 'Container' matches every group, including nested ones")
  assert(asSortedIds(root.find('#a, #b')) === 'a,b', 'comma-separated clauses are OR-ed together')
  assert(asSortedIds(root.find((n) => n.id === 'b' || n.id === 'c')) === 'b,c', 'a function selector is called directly with the node')
  assert(root.find('.box').every((n) => n !== root), 'find() only returns descendants, never the node itself')
  assert(!root.matches('.box'), 'matches() checks the node itself, not its descendants')
  assert(group.matches('.box') === false && a.matches('.box'), 'matches() is a leaf-level check')

  assert(c.findAncestor('.group') === group, "findAncestor matches an ancestor's name too")
  assert(c.findAncestor('.absent') === null, 'findAncestor with no matching ancestor returns null')
  assert(c.findAncestor('Container') === nested, 'findAncestor returns the nearest match')
  assert(
    c
      .findAncestors('Container')
      .map((n) => n.name)
      .join(',') === 'nested,group,root',
    'findAncestors walks up to the root, nearest first',
  )
  assert(nested.findAncestor('Container') === group, 'includeSelf defaults to false, so the starting node itself is skipped')
  assert(nested.findAncestor('Container', true) === nested, 'includeSelf=true checks the starting node first')
}

// --- getAttr/setAttr/attrs: string-keyed access to a node's typed fields ---
{
  const rect = centredRect({ x: 1, y: 2, fill: [1, 0, 0, 1] })

  assert(rect.getAttr('x') === 1, 'getAttr reads an ordinary field by name')
  rect.setAttr('x', 42)
  assert(rect.x === 42, 'setAttr falls back to a direct assignment when no dedicated setter exists')

  const snapshot = rect.attrs
  assert(snapshot.x === 42 && snapshot.id === rect.id && snapshot.fill === rect.fill, 'attrs includes both the base Node keys and the subclass ones')
  rect.x = 100
  assert(snapshot.x === 42 && rect.attrs.x === 100, 'attrs is a fresh snapshot each read, not a live view')

  // A class that declares a dedicated setFoo() alongside a plain foo field: setAttr must
  // call it rather than assign foo directly, since some real attributes (TextBlock.runs,
  // just below) only exist as a read-only property paired with such a method.
  class Widget extends Node {
    foo = 1
    setFooCalls = 0
    setFoo(value: number): void {
      this.setFooCalls++
      this.foo = value * 2
    }
    protected override attrKeys(): readonly string[] {
      return [...super.attrKeys(), 'foo']
    }
  }
  const widget = new Widget()
  widget.setAttr('foo', 5)
  assert(widget.setFooCalls === 1 && widget.foo === 10, 'setAttr prefers a declared set<Key>() method over a direct assignment')

  // TextBlock.runs is exactly that real case: a getter with no setter, paired with
  // setRuns() (which also invalidates the shaping cache) - a plain assignment would throw.
  const text = new Text({ text: 'hello' })
  assert(text.getAttr('runs') === text.runs, 'getAttr reads a getter-only property too')
  text.setAttr('runs', [{ text: 'world' }])
  assert(text.runs.length === 1 && text.runs[0].text === 'world', "setAttr('runs', ...) on a TextBlock goes through setRuns()")
}

// --- groups: a container that places itself, sized by what it holds -------------------
//
// A group draws nothing and stores no size. What it contributes is a matrix in the middle
// of the chain, and an extent that is whatever it currently contains - so the interesting
// assertions are all about those two things staying true as the contents change.
{
  const group = new Group({ x: 100, y: -50 })
  const a = group.addChild(new Rect({ x: 0, y: 0, width: 40, height: 20 }))

  // The group's matrix lands between the shape's own and the world, which is the whole
  // mechanism: nothing downstream needs to know a group is involved.
  const corner = a.worldMatrix().transformPoint(new Vector3(0, 0, 0))
  assert(near(corner.x, 100) && near(corner.y, -50), "a child's world position is its own plus the group's")

  // ...and moving the group moves what is inside it, without touching the children at all.
  group.x = 200
  const moved = a.worldMatrix().transformPoint(new Vector3(0, 0, 0))
  assert(near(moved.x, 200) && near(a.x, 0), 'moving the group moves the child, whose own x never changed')

  // Sized by its contents: the rect spans [0,40] x [-20,0] in its own space, and the group
  // holds that unmoved, so the group's local extent is exactly the rect's.
  const bounds = group.bounds()
  assert(bounds.valid(), 'a group holding something has an extent')
  assert(near(bounds.min.x, 0) && near(bounds.max.x, 40), 'and it is the union of what it holds')
  assert(near(bounds.max.y, 0) && near(bounds.min.y, -20), 'in both axes')

  // Add a second shape and the group grows to cover it - no invalidation call anywhere.
  group.addChild(new Rect({ x: 60, y: 0, width: 10, height: 100 }))
  const grown = group.bounds()
  assert(near(grown.max.x, 70), 'adding a shape grows the group')
  assert(near(grown.min.y, -100), 'in whichever direction the new shape reaches')

  // Move a child and the group follows it, again with nothing told to recompute.
  a.x = -30
  assert(near(group.bounds().min.x, -30), 'moving a child moves the group edge it was defining')

  // World bounds are the same extent carried through the group's own transform.
  const world = group.worldBounds()
  assert(near(world.min.x, -30 + 200) && near(world.max.x, 70 + 200), 'world bounds add the group position')
}

// --- an empty group is nowhere, not a point at its own origin ---
{
  const empty = new Group({ x: 10, y: 10 })
  assert(!empty.bounds().valid(), 'a group holding nothing has no extent at all')
  assert(!empty.worldBounds().valid(), 'in world space either')
  // A group holding only things with nothing to measure is equally empty.
  empty.addChild(new Group())
  assert(!empty.bounds().valid(), 'a group of empty groups is still nowhere')
}

// --- the group's own transform applies to its contents' extent ---
{
  const group = new Group({ scaleX: 2, scaleY: 3 })
  group.addChild(new Rect({ width: 10, height: 10 }))
  assert(near(group.bounds().max.x, 10), "bounds() is in the group's OWN space, so its scale is not in them")
  assert(near(group.worldBounds().max.x, 20), 'worldBounds() is, so the scale is')
  assert(near(group.worldBounds().min.y, -30), 'on both axes independently')
}

// --- groups nest, and the middle group's transform is composed on the way down ---
{
  const outer = new Group({ x: 100 })
  const inner = outer.addChild(new Group({ x: 10, scaleX: 2 }))
  inner.addChild(new Rect({ width: 5, height: 5 }))

  assert(near(inner.bounds().max.x, 5), "the inner group measures its own child in the child's units")
  assert(near(outer.bounds().max.x, 10 + 5 * 2), "the outer group sees the inner one's offset and scale")
  assert(near(outer.worldBounds().max.x, 100 + 10 + 5 * 2), 'and world bounds add the outer position on top')
}

// --- a hidden group takes its contents out of the measurement, and out of the scene ---
{
  const group = new Group()
  const shown = group.addChild(new Rect({ width: 10, height: 10 }))
  const hiddenChild = group.addChild(new Group({ x: 1000 }))
  hiddenChild.addChild(new Rect({ width: 10, height: 10 }))

  assert(near(group.bounds().max.x, 1010), 'a visible nested group counts towards the extent')
  hiddenChild.visible = false
  assert(near(group.bounds().max.x, 10), 'a hidden one does not')

  // The same rule for a plain hidden shape, which is the pre-existing behaviour.
  shown.visible = false
  assert(!group.bounds().valid(), 'and hiding the last visible thing leaves no extent')
}

// --- which group a node belongs to, for an application deciding what a click means ---
{
  const outer = new Group({ name: 'outer' })
  const inner = outer.addChild(new Group({ name: 'inner' }))
  const leaf = inner.addChild(new Rect({ width: 1, height: 1 }))
  const loose = new Rect({ width: 1, height: 1 })

  assert(closestGroup(leaf) === inner, 'the closest group is the one directly holding the node')
  assert(outermostGroup(leaf) === outer, 'the outermost is the whole assembly')
  assert(closestGroup(loose) === null && outermostGroup(loose) === null, 'a node in no group is in no group')
  assert(hiddenByGroup(leaf) === false, 'nothing above it is hidden')
  outer.visible = false
  assert(hiddenByGroup(leaf), 'until something above it is')

  // Which group a DRAG takes hold of is a different question: it stops at the first group
  // that has opted out, because reaching past one to an outer group would move the very
  // thing that said it should not be moved that way.
  assert(draggableGroup(leaf) === outer, 'a drag takes hold of the outermost draggable group')
  inner.draggable = false
  assert(draggableGroup(leaf) === null, 'and takes hold of nothing once the group it is in opts out')
  inner.draggable = true
  outer.draggable = false
  assert(draggableGroup(leaf) === inner, 'stopping at the outer one that opted out, but keeping the inner')
}

// --- a layer is NOT a group, which is the entire point of it being its own class ---
{
  const layer = new Layer({ name: 'background' })
  const leaf = layer.addChild(new Rect({ width: 1, height: 1 }))

  // Every one of these would answer differently if Layer extended Group, and each is a
  // behaviour an application would get wrong: fifty shapes on a "background" layer must not
  // become one draggable, selectable object.
  assert(closestGroup(leaf) === null, 'a shape in a layer is in no group')
  assert(outermostGroup(leaf) === null, 'so an application selecting the assembly selects nothing')
  assert(draggableGroup(leaf) === null, 'and a drag on it takes hold of the shape, not the layer')
  assert(hiddenByGroup(leaf) === false, 'a layer is not something that can hide it as a group')
  layer.enabled = false
  assert(hiddenByGroup(leaf) === false, 'not even switched off - that is the render walk\'s job, not this one\'s')

  // The one thing it shares with a group: a group ABOVE a layer still governs it, because
  // the ancestor walks stop at Groups wherever they are and a Layer is simply not one.
  layer.enabled = true
  const group = new Group()
  group.addChild(layer)
  assert(closestGroup(leaf) === group, 'a group above a layer is still the shape\'s group')
}

// --- a layer is measured through, so a group holding one sizes itself to the contents ---
{
  const group = new Group()
  const layer = group.addChild(new Layer({ x: 100 }))
  layer.addChild(new Rect({ width: 10, height: 10 }))

  assert(near(group.bounds().max.x, 110), "a layer's contents count towards the group's extent, through its transform")
  layer.enabled = false
  assert(!group.bounds().valid(), 'and a disabled layer takes them out whole, like a hidden group')
  layer.enabled = true
  assert(near(group.bounds().max.x, 110), 're-enabling brings back exactly what was there')
}

// --- a layer's transform composes like any node's; it is a Container, nothing more ---
{
  const layer = new Layer({ x: 50, y: -20 })
  const leaf = layer.addChild(new Rect({ x: 5, width: 1, height: 1 }))
  const at = leaf.worldMatrix().transformPoint(new Vector3(0, 0, 0))
  assert(near(at.x, 55) && near(at.y, -20), 'moving a layer moves what is inside it')

  assert(layer.nodeName === 'Layer' && layer.nodeType === 'Layer', 'and it names itself')
  assert(new Layer().enabled === true, 'a layer is on unless it is asked not to be')
  assert(new Layer({ enabled: false }).enabled === false, 'which the option sets')
}

// --- a group carries the same transform vocabulary a shape does ---
{
  const group = new Group({ x: 3, y: 4, rotation: 0.5, scaleX: 2, skewX: 0.25, offsetX: 1 })
  const snapshot = group.captureTransform()
  const before = group.localMatrix()
  group.x = 99
  group.rotation = 0
  group.restoreTransform(snapshot)
  assert(group.x === 3 && near(group.rotation, 0.5), 'capture/restore puts every field back')
  assert(group.localMatrix().m.every((v, i) => near(v, before.m[i])), 'so the matrix comes back identical')

  // The same memoization shapes get: an unmoved node hands back the SAME instance, which
  // is what lets world matrices and the render lanes short-circuit on reference equality.
  const held = group.localMatrix()
  assert(group.localMatrix() === held, 'an unchanged group returns the same matrix instance')
  group.y = 40
  assert(group.localMatrix() !== held, 'and a changed one does not')

  assert(group.attrs.x === 3 && group.attrs.visible === true, 'the transform and visibility are exposed as attributes')
  group.setAttr('rotation', 1)
  assert(group.rotation === 1, 'and are writable through setAttr')
}

// --- the transform belongs to Node, so every node in the graph has one -----------------
//
// Not just the drawables. A plain Node, a bare Container, a Group and a Shape all compose
// the same matrix from the same nine fields - which is what lets a gesture move any of them
// without asking what kind it is, and what makes a Group's placement identical to a Shape's
// rather than merely similar.
{
  const composed = (n: Node) => n.localMatrix().m

  const bare = new Node()
  bare.x = 12
  bare.y = -5
  bare.rotation = 0.4
  bare.scaleX = 2

  const container = new Container()
  const group = new Group()
  const rect = new Rect({ width: 1, height: 1 })
  for (const other of [container, group, rect]) other.restoreTransform(bare.captureTransform())

  assert(composed(container).every((v, i) => near(v, composed(bare)[i])), 'a Container composes the same matrix a plain Node does')
  assert(composed(group).every((v, i) => near(v, composed(bare)[i])), 'and so does a Group')
  assert(composed(rect).every((v, i) => near(v, composed(bare)[i])), 'and a Shape - one implementation, not three that agree')

  // The memoization is on Node too, so identity-keyed caching works for every kind.
  const held = container.localMatrix()
  assert(container.localMatrix() === held, 'an unmoved node hands back the same instance')
  container.skewY = 0.1
  assert(container.localMatrix() !== held, 'and a moved one does not')

  // A transform reaches its children whatever kind of node is carrying it, because the
  // composition is on the base class rather than on any one subclass.
  const holder = new Container()
  holder.x = 100
  const child = holder.addChild(new Rect({ width: 10, height: 10 }))
  assert(near(child.worldMatrix().transformPoint(new Vector3(0, 0, 0)).x, 100), "a plain Container's transform reaches its children")

  // Every node exposes the transform as attributes, so a property inspector needs no
  // per-class knowledge to drive one.
  assert(bare.attrs.x === 12 && bare.attrs.skewY === 0, 'the transform is in every node\'s attrs')
  bare.setAttr('y', 42)
  assert(bare.y === 42, 'and is writable through setAttr')
}

// --- the stacking counter: what an unset zIndex means ---------------------------------
{
  // From a known starting point, so the exact values can be asserted. Nothing in a running
  // application resets this - see zOrder.ts.
  resetAutoZIndex(0)

  const first = new Rect({ width: 1, height: 1 })
  const second = new Rect({ width: 1, height: 1 })
  const third = new Circle({ radius: 1 })

  assert(first.zIndex === 0, 'the first shape made is at 0')
  assert(second.zIndex === 1, 'the next is at 1, which is in front of it')
  assert(third.zIndex === 2, 'and the counter is shared by every kind of Shape, not one per class')

  // Text is a Shape and draws through a different lane, which is exactly why it has to share
  // the same counter: the two lanes resolve against one depth buffer.
  assert(new Text({ text: 'x' }).zIndex === 3, 'Text takes its number from the same counter')

  // The counter is what makes the ordering a promise rather than a coincidence: it only ever
  // goes up, so a shape made now is in front of every shape made before it, whatever else
  // happened in between.
  assert(peekZIndex() === 4, 'peeking does not take a number')
  assert(peekZIndex() === 4, 'however often it is asked')
  assert(nextZIndex() === 4 && peekZIndex() === 5, 'taking one does')

  // An explicit zIndex is taken as given, and deliberately does NOT advance the counter -
  // otherwise one shape asking for a huge number would push every later shape past it.
  const pinned = new Rect({ width: 1, height: 1, zIndex: 900 })
  assert(pinned.zIndex === 900, 'an explicit zIndex wins')
  assert(peekZIndex() === 5, 'and leaves the counter where it was')
  assert(new Rect({ width: 1, height: 1 }).zIndex === 5, 'so the next unset shape carries on from there')

  // The two idioms the counter is designed around. Bringing a shape to the front is asking
  // for a fresh number; sending one to the back needs no helper at all, because the counter
  // only ever counts up from zero.
  first.zIndex = nextZIndex()
  assert(first.zIndex > third.zIndex, 'nextZIndex() brings an existing shape to the front')
  second.zIndex = -1
  assert(second.zIndex < first.zIndex && second.zIndex < third.zIndex, 'and any negative is behind everything')

  // Put it back, so a later test that happens to care about absolute values is not reading
  // whatever this block left behind.
  resetAutoZIndex(0)
}

// --- remove(): out of the tree, and still entirely itself ------------------------------
{
  const parent = new Container('holder')
  const kept = parent.addChild(new Rect({ name: 'kept', width: 10, height: 10 }))
  const going = parent.addChild(new Rect({ name: 'going', x: 40, width: 10, height: 10 }))

  assert(going.remove() === going, 'remove() hands the node back, so it can be re-homed in one line')
  assert(going.parent === null, 'and unhooks it from its parent')
  assert(parent.children.length === 1 && parent.children[0] === kept, 'leaving its siblings alone')
  assert(going.remove() === going, 'removing an unparented node is a no-op, not an error')

  // The whole point of remove() rather than destroy(): the node is untouched.
  assert(going.x === 40 && going.width === 10, 'the node keeps its transform and size')
  assert(!going.isDestroyed, 'and is not destroyed')
  assert(going.localBounds().valid(), 'its geometry still measures')

  // Straight back in, as if nothing happened.
  parent.addChild(going)
  assert(going.parent === parent && parent.children.length === 2, 'and it goes back in')
}

// --- removeChildren(): the same thing for a whole container ----------------------------
{
  const parent = new Container('holder')
  const a = parent.addChild(new Rect({ width: 1, height: 1 }))
  const b = parent.addChild(new Rect({ width: 1, height: 1 }))

  parent.removeChildren()
  assert(parent.children.length === 0, 'the container is emptied')
  assert(a.parent === null && b.parent === null, 'and every child knows it left')
  assert(!a.isDestroyed && !b.isDestroyed, 'but none of them is destroyed - this is remove, not teardown')
}

// --- destroy(): the subtree is finished with --------------------------------------------
{
  resetListenerCensus()

  const root = new Container('root')
  const group = root.addChild(new Group({ name: 'doomed' }))
  const child = group.addChild(new Rect({ name: 'child', width: 20, height: 20 }))
  const nested = group.addChild(new Group({ name: 'nested' }))
  const deep = nested.addChild(new Circle({ name: 'deep', radius: 5 }))

  // Listeners are the one thing that does NOT clean itself up: the census is global, so a
  // node dropped while still holding one would leave its tally behind forever.
  group.on('click', () => {})
  child.on('click', () => {})
  child.on('pointermove', () => {})
  assert(listenerCount('click') === 2 && listenerCount('pointermove') === 1, 'sanity: the census counted them')

  group.destroy()

  assert(listenerCount('click') === 0, "destroy() takes the whole subtree's listeners with it")
  assert(listenerCount('pointermove') === 0, 'every type of them')
  assert(root.children.length === 0, 'the head of the subtree is out of its parent')
  assert(group.isDestroyed && child.isDestroyed, 'and everything under it is marked destroyed')
  assert(nested.isDestroyed && deep.isDestroyed, 'however many levels down it sits')
  assert(child.parent === null && group.children.length === 0, 'the tree is taken apart rather than left dangling')

  group.destroy()
  assert(group.isDestroyed, 'destroying twice is a no-op, not a second teardown')
}

// --- destroy() announces itself before anything is detached ------------------------------
{
  resetListenerCensus()
  const root = new Container('root')
  const group = root.addChild(new Group())
  const child = group.addChild(new Rect({ width: 1, height: 1 }))

  // Registered on the ROOT, which is above the subtree being destroyed - so it only hears
  // anything at all if the events fire while the subtree is still attached.
  const heard: string[] = []
  root.on('destroy', (event) => heard.push(event.target.nodeName))

  group.destroy()
  assert(heard.length === 2, 'one event per node in the subtree, not one for its head')
  assert(heard[0] === 'Group' && heard[1] === 'Rect', 'in pre-order, and they reached an ancestor by bubbling')
  assert(child.isDestroyed, 'and the teardown still happened')
  resetListenerCensus()
}

// --- moveTo(): re-homing, with and without keeping the node where it looks ---------------
{
  const root = new Container('root')
  const from = root.addChild(new Group({ name: 'from', x: 100 }))
  const to = root.addChild(new Group({ name: 'to', x: 400, scaleX: 2 }))
  const shape = from.addChild(new Rect({ name: 'travelling', x: 10, width: 20, height: 20 }))

  assert(shape.worldMatrix().transformPoint(new Vector3(0, 0, 0)).x === 110, 'sanity: it starts at 100 + 10')

  // The default keeps the node's OWN transform, so it lands where x = 10 means in the new
  // parent - through that parent's scale as well as its position.
  assert(shape.moveTo(to) === shape, 'moveTo hands the node back')
  assert(shape.parent === to, 'it is in the new parent')
  assert(from.children.length === 0, 'and out of the old one')
  assert(shape.x === 10, 'its own x is untouched')
  assert(near(shape.worldMatrix().transformPoint(new Vector3(0, 0, 0)).x, 400 + 10 * 2), 'so it moved on screen')

  // The other half: keep it exactly where it is, and let the local transform absorb the
  // difference between the two parents.
  const before = shape.worldMatrix()
  shape.moveTo(from, { keepWorldTransform: true })
  assert(shape.parent === from, 'moved back')
  const after = shape.worldMatrix()
  for (let i = 0; i < 16; i++) assert(near(after.m[i], before.m[i]), 'and its world matrix is unchanged')
  assert(!near(shape.x, 10), 'which it paid for by rewriting its own x')
}

// --- moveTo() refuses the two moves that would corrupt the tree --------------------------
{
  const outer = new Group({ name: 'outer' })
  const inner = outer.addChild(new Group({ name: 'inner' }))
  const leaf = inner.addChild(new Rect({ width: 1, height: 1 }))

  let threw = false
  try {
    outer.moveTo(inner)
  } catch {
    threw = true
  }
  assert(threw, 'a node cannot be moved into its own descendant - that is a cycle')
  assert(outer.children.includes(inner) && inner.parent === outer, 'and the tree is left as it was')

  threw = false
  try {
    outer.moveTo(outer)
  } catch {
    threw = true
  }
  assert(threw, 'nor into itself')

  // A destroyed node is finished, and putting one back would be a silent bug.
  const dead = new Rect({ width: 1, height: 1 })
  dead.destroy()
  threw = false
  try {
    dead.moveTo(outer)
  } catch {
    threw = true
  }
  assert(threw, 'and a destroyed node cannot be re-homed')
  assert(leaf.parent === inner, 'sanity: none of that disturbed the tree')
}

// --- keepWorldTransform survives rotation and skew, not just position ---------------------
{
  const root = new Container('root')
  const from = root.addChild(new Group({ x: 30, rotation: 0.4, scaleX: 1.5 }))
  const to = root.addChild(new Group({ x: -80, y: 12, rotation: -0.9, scaleY: 2, skewX: 0.3 }))
  const shape = from.addChild(new Rect({ x: 7, y: -3, rotation: 0.2, scaleX: 1.2, width: 10, height: 10 }))

  const before = shape.worldMatrix()
  shape.moveTo(to, { keepWorldTransform: true })
  const after = shape.worldMatrix()
  for (let i = 0; i < 16; i++) {
    assert(near(after.m[i], before.m[i]), 'an arbitrary parent-to-parent change is absorbed exactly')
  }
}

// --- a Transformer lets go of a node that has been destroyed ------------------------------
{
  const root = new Container('root')
  const a = root.addChild(centredRect({ name: 'a', width: 40, height: 40 }))
  const b = root.addChild(centredRect({ name: 'b', x: 100, width: 40, height: 40 }))
  const c = root.addChild(centredRect({ name: 'c', x: 200, width: 40, height: 40 }))
  const t = root.addChild(new Transformer())

  t.attach([a, b])
  assert(t.nodes.length === 2, 'sanity: both attached')

  // Merely removing it is enough. A detached node's worldMatrix collapses to its LOCAL
  // matrix, so a frame that kept hold would fit itself to a position the node never had.
  b.remove()
  t.update(boxForNodes([a], localBoundsOf), 1)
  assert(t.nodes.length === 1 && t.nodes[0] === a, 'a removed node is dropped on the next update')
  assert(!t.has(b), 'and the frame no longer holds it')

  // Destroying one that is still in the scene does the same, by the other half of the test.
  t.attach([a, c])
  c.destroy()
  t.update(boxForNodes([a], localBoundsOf), 1)
  assert(t.nodes.length === 1 && t.nodes[0] === a, 'so is a destroyed one')
}

// --- ...but not of a node that merely moved, nor of one attached before it had a home ------
{
  const root = new Container('root')
  const left = root.addChild(new Group({ name: 'left', x: -100 }))
  const right = root.addChild(new Group({ name: 'right', x: 100 }))
  const shape = left.addChild(centredRect({ name: 'travelling', width: 40, height: 40 }))
  const t = root.addChild(new Transformer())

  // moveTo changes WHERE a node is, not whether it is there.
  t.attach([shape])
  shape.moveTo(right)
  t.update(boxForNodes([shape], localBoundsOf), 1)
  assert(t.nodes.length === 1, 'a node moved to another parent in the same tree stays attached')

  // Built, selected, and only then added - the node's tree top changes, but in the direction
  // of joining rather than leaving, so a bare parent check would get this backwards.
  const fresh = centredRect({ name: 'fresh', width: 10, height: 10 })
  t.attach([fresh])
  t.update(boxForNodes([fresh], localBoundsOf), 1)
  assert(t.nodes.length === 1, 'a node attached before it is in the scene is not mistaken for one that left')
  root.addChild(fresh)
  t.update(boxForNodes([fresh], localBoundsOf), 1)
  assert(t.nodes.length === 1, 'and adding it afterwards does not drop it either')
}

console.log(`[shapes] self-test passed (${count} assertions)`)
