// Self-test for the ported scene graph (Node / Container / Shape + Scene). Run with:
//   npx tsx src/scene/selfTest.ts

import { Container } from '../shapes/Container'
import { Group } from '../shapes/Group'
import { Node } from '../shapes/Node'
import { Scene } from './Scene'
import { AABB } from '../math/AABB'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Transform } from '../math/Transform'
import { Vector3 } from '../math/Vector3'
import { Circle } from '../shapes/Circle'
import { Rect , type RectOptions } from '../shapes/Rect'
import { Text } from '../shapes/Text'
import { Shape } from '../shapes/Shape'
import type { MeshSink } from '../render/meshFormat'
import { collectZOrder, depthForRank, hitTestShape, pickNode, shapeLocalBounds, textLocalBounds } from './picking'
import { isShapeOnScreen } from './culling'
import { nodesInBox } from './selection'

let count = 0
function assert(cond: boolean, msg: string): void {
  count++
  if (!cond) throw new Error(`[scene] self-test FAILED: ${msg}`)
}

/**
 * A Rect CENTRED on (x, y). A Rect's own origin is its top-left corner (see Shape's
 * header), so this applies the pivot offset that puts its middle back on the position -
 * which is the frame the geometry below is written in.
 */
const centredRect = (options: RectOptions = {}): Rect =>
  new Rect({ ...options, offsetX: (options.width ?? 1) / 2, offsetY: -(options.height ?? 1) / 2 })


const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

const eq = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i])

// A container carrying a local transform, so hierarchy math can be checked without GPU.
class TransformGroup extends Container {
  readonly local = new Transform()
  override localMatrix(): Matrix4x4 {
    return this.local.toMatrix()
  }
}

// --- hierarchy composition: child_world == parent_local * child_local (column-vector) ---
{
  const parent = new TransformGroup('parent')
  parent.local.position = new Vector3(10, 0, 0)
  parent.local.rotation = Quaternion.fromAxisAngle(Vector3.up(), Math.PI / 2)

  const child = new TransformGroup('child')
  child.local.position = new Vector3(0, 0, 5)
  parent.addChild(child)

  const expected = parent.localMatrix().mul(child.localMatrix())
  const p = new Vector3(1, 2, 3)
  assert(
    child.worldMatrix().transformPoint(p).nearEquals(expected.transformPoint(p), 1e-3),
    'child world == parent_local * child_local',
  )
  assert(child.parent === parent, 'addChild sets parent link')
}

// --- traversal orders and search over a known tree ---
//   root
//    +- a
//    |   +- a1
//    |   +- a2
//    +- b
{
  const root = new Container('root')
  const a = root.addChild(new Container('a'))
  a.addChild(new Node('a1'))
  a.addChild(new Node('a2'))
  root.addChild(new Node('b'))

  const names = (fn: 'traversePreOrder' | 'traversePostOrder' | 'traverseBreadthFirst') => {
    const order: string[] = []
    root[fn]((n) => order.push(n.name))
    return order
  }

  assert(eq(names('traversePreOrder'), ['root', 'a', 'a1', 'a2', 'b']), 'pre-order')
  assert(eq(names('traversePostOrder'), ['a1', 'a2', 'a', 'b', 'root']), 'post-order')
  assert(eq(names('traverseBreadthFirst'), ['root', 'a', 'b', 'a1', 'a2']), 'breadth-first')

  const found = root.findOne('.a2')
  assert(found !== null && found.name === 'a2', 'findOne(.name) hit')
  assert(root.findOne('.missing') === null, 'findOne(.name) miss')

  assert(root.removeChild(a) && root.children.length === 1, 'removeChild detaches')
  assert(a.parent === null, 'removeChild clears parent')
}

// --- picking: hitTestShape tests against the shape's own tessellated triangles ---
{
  const rect = centredRect({ x: 100, y: 50, width: 40, height: 20 })
  assert(hitTestShape(rect, 100, 50), 'rect center hits')
  assert(hitTestShape(rect, 119, 59), 'just inside rect corner hits')
  assert(!hitTestShape(rect, 121, 50), 'just outside rect on x misses')
  assert(!hitTestShape(rect, 0, 0), 'far outside rect misses')

  // The two origin conventions, in the bounds themselves. A Rect hangs from its top-left
  // corner, so unshifted it spans [0, width] and [-height, 0]; a Circle is centred, so it
  // spans its radius each way. (The rect above is pivoted to its middle, which moves where
  // it lands in the world but never what it emits in its own frame.)
  const cornered = shapeLocalBounds(new Rect({ x: 100, y: 50, width: 40, height: 20 }))
  assert(cornered.valid(), 'rect local bounds valid')
  assert(near(cornered.min.x, 0) && near(cornered.max.x, 40), 'a rect spans [0, width] from its local origin')
  assert(near(cornered.max.y, 0) && near(cornered.min.y, -20), 'and hangs down to -height, the scene being y-up')

  // The circle is a polygon, so its bounds sit inside the true radius by the flattening
  // tolerance - what matters here is that they straddle the origin rather than start at it.
  const centred = shapeLocalBounds(new Circle({ x: 100, y: 50, radius: 20 }))
  assert(near(centred.min.x, -20, 0.05) && near(centred.max.x, 20, 0.05), 'a circle spans its radius either side of its local origin')
  assert(near(centred.min.y, -centred.max.y, 1e-9), 'centred on it in y as well')

  // A rounded corner is cut out of the pick shape too, with nothing to keep in step: the
  // hit test runs on the very triangles that were drawn, so it follows whatever they are.
  const square = new Rect({ width: 100, height: 100 })
  const rounded = new Rect({ width: 100, height: 100, cornerRadius: 30 })
  assert(hitTestShape(square, 4, -4), 'a square rect is hit right up in its corner')
  assert(!hitTestShape(rounded, 4, -4), 'a rounded one is not - the corner is not there to hit')
  assert(hitTestShape(rounded, 50, -50) && hitTestShape(rounded, 0.5, -50), 'its middle and its straight edges still are')
  const roundedBounds = shapeLocalBounds(rounded)
  assert(near(roundedBounds.min.x, 0) && near(roundedBounds.max.x, 100), 'and rounding never shrinks the bounds')

  const circle = new Circle({ x: 0, y: 0, radius: 30 })
  assert(hitTestShape(circle, 0, 0), 'circle center hits')
  assert(hitTestShape(circle, 29, 0), 'inside circle radius hits')
  assert(!hitTestShape(circle, 31, 0), 'outside circle radius misses')

  // A degenerate (zero-area) triangle - legitimate in tessellated output (e.g. a
  // duplicate point from a stroke join), harmless for the GPU rasterizer - must never
  // match every point: its three edge signs are all exactly 0, so a naive "no negative
  // and no positive edge sign" test would wrongly call it a universal hit.
  class DegenerateShape extends Shape {
    protected override buildGeometry(sink: MeshSink): void {
      const a = sink.vertex(10, 130, true)
      const b = sink.vertex(10, 130, true)
      const c = sink.vertex(10, 130, true)
      sink.triangle(a, b, c)
    }
  }
  const degenerate = new DegenerateShape()
  assert(!hitTestShape(degenerate, 3000, 0), 'a degenerate triangle does not match a far-away point')
  assert(!hitTestShape(degenerate, 10, 130), 'a degenerate triangle does not match even its own collapsed point')

  // A 90deg rotation swaps which world axis lines up with the rect's long (width) side:
  // local = R(-rotation) * (world - center), so R(-90deg) maps (x,y) -> (y,-x).
  const rotated = centredRect({ x: 0, y: 0, width: 40, height: 10, rotation: Math.PI / 2 })
  assert(hitTestShape(rotated, 0, 19), 'rotated rect hits along its now-vertical long axis')
  assert(!hitTestShape(rotated, 19, 0), 'rotated rect misses where the unrotated rect would have hit')
}

// --- picking: pickNode finds the topmost hit and respects visible/pickable ---
{
  const scene = new Scene()
  const back = scene.root.addChild(centredRect({ name: 'back', x: 0, y: 0, width: 100, height: 100 }))
  const front = scene.root.addChild(centredRect({ name: 'front', x: 20, y: 0, width: 60, height: 60 }))

  assert(pickNode(scene, -40, 0) === back, 'point over only the back rect picks it')
  assert(pickNode(scene, 20, 0) === front, 'overlapping point picks the later (topmost) node')
  assert(pickNode(scene, 500, 500) === null, 'empty space picks nothing')

  front.visible = false
  assert(pickNode(scene, 20, 0) === back, 'invisible node is skipped, falls through to the one below')
  front.visible = true

  front.pickable = false
  assert(pickNode(scene, 20, 0) === back, 'non-pickable node is skipped, falls through to the one below')
  front.pickable = true
}

// --- zIndex: overrides insertion order for both stacking (collectZOrder) and picking ---
{
  const scene = new Scene()
  const early = scene.root.addChild(centredRect({ name: 'early', x: 0, y: 0, width: 100, height: 100 }))
  const late = scene.root.addChild(centredRect({ name: 'late', x: 0, y: 0, width: 100, height: 100 }))
  assert((centredRect()).zIndex === 0, 'zIndex defaults to 0')

  // Added later (would normally paint on top), but a lower zIndex sends it to the back.
  late.zIndex = -1
  assert(pickNode(scene, 0, 0) === early, 'lower zIndex loses the pick even though it was added first')

  const ordered = collectZOrder(scene)
  assert(ordered.indexOf(late) < ordered.indexOf(early), 'collectZOrder ranks the lower zIndex first (furthest back)')

  // Equal zIndex falls back to scene/insertion order (stable sort).
  late.zIndex = 0
  assert(pickNode(scene, 0, 0) === late, 'equal zIndex falls back to insertion order - the later node wins')

  // depthForRank is monotonic (higher rank = higher zIndex = smaller/closer depth) and
  // strictly inside (0,1), so it never collides with the far/near clear values.
  const n = 5
  const depths = Array.from({ length: n }, (_, rank) => depthForRank(rank, n))
  for (let i = 0; i < n; i++) assert(depths[i] > 0 && depths[i] < 1, 'depthForRank stays strictly inside (0,1)')
  for (let i = 1; i < n; i++) assert(depths[i] < depths[i - 1], 'depthForRank decreases as rank (zIndex) increases')
}

// --- Text is a Shape now (not a lane-specific special case): it inherits zIndex,
//     offset, visible/pickable from the same base as every mesh shape, which is what
//     makes cross-lane zIndex ordering (a shape in front of text, or vice versa)
//     possible without picking/depth needing to special-case "which lane" a node is in ---
{
  assert(Text.prototype instanceof Shape, 'Text extends Shape, carrying zIndex/offset/pickable like a mesh shape')
  assert(new Text().zIndex === 0, 'Text inherits the zIndex default')
  assert(new Text().pickable, 'Text inherits the pickable default')

  // Shape's full styling vocabulary (width/height/fill/stroke/...) is inherited too, even
  // though Text's own rich per-run styling doesn't use it - one shared vocabulary instead
  // of the render lane dictating which fields a shape gets.
  const text = new Text({ fill: [1, 0, 0, 1], stroke: [0, 1, 0, 1], strokeWidth: 2, width: 50 })
  assert(text.fill[0] === 1 && text.stroke[1] === 1 && text.strokeWidth === 2 && text.width === 50, 'Text inherits Shape fields, not just Shape defaults')

  let sawVertex = false
  text.tessellate({ vertex: () => ((sawVertex = true), 0), triangle: () => {} })
  assert(!sawVertex, "Text inherits Shape's no-op tessellate() (it renders through the text lane, not the mesh lane)")
}

// --- picking: textLocalBounds unions every quad's corners ---
{
  // An upright, unsheared quad - what straight text produces.
  const box = (x0: number, y0: number, x1: number, y1: number) => ({
    x0,
    y0,
    x1,
    y1,
    skew: 0,
    skewPivotY: 0,
    rotation: 0,
    rotationPivotX: 0,
    rotationPivotY: 0,
  })

  const bounds = textLocalBounds({ quads: [box(0, 0, 10, -5), box(8, -5, 20, -12)] })
  assert(bounds.valid(), 'text bounds valid for a non-empty quad list')
  assert(bounds.min.x === 0 && bounds.max.x === 20, 'text bounds union x across all quads')
  assert(bounds.min.y === -12 && bounds.max.y === 0, 'text bounds union y across all quads')
  assert(!textLocalBounds({ quads: [] }).valid(), 'text bounds invalid for no quads')

  // A quad turned by a curve is bounded by where it ended up, not by the box it started as:
  // a quarter turn about the origin takes a 10x2 box lying on +x onto +y.
  const turned = textLocalBounds({ quads: [{ ...box(0, 0, 10, 2), rotation: Math.PI / 2 }] })
  assert(Math.abs(turned.min.x - -2) < 1e-9 && Math.abs(turned.max.x - 0) < 1e-9, 'a turned quad bounds where its corners went in x')
  assert(Math.abs(turned.min.y - 0) < 1e-9 && Math.abs(turned.max.y - 10) < 1e-9, 'and in y')

  // The shear counts too - the reason italic text was ever bounded slightly short.
  const sheared = textLocalBounds({ quads: [{ ...box(0, 0, 10, 4), skew: 0.5 }] })
  assert(sheared.max.x === 12, 'a sheared quad reaches past its box by skew * height')
}

// --- culling: isShapeOnScreen tests WORLD-space bounds overlap against a view
//     rectangle - moving a shape changes the answer immediately, no cache to invalidate ---
{
  const view = new AABB(new Vector3(-50, -50, 0), new Vector3(50, 50, 0))

  const inside = centredRect({ x: 0, y: 0, width: 10, height: 10 })
  assert(isShapeOnScreen(inside, view), 'a shape inside the view rectangle is on screen')

  const farAway = centredRect({ x: 1000, y: 0, width: 10, height: 10 })
  assert(!isShapeOnScreen(farAway, view), 'a shape far outside the view rectangle is culled')

  // Spans x in [35,55] - the view rectangle ends at x=50, so this still overlaps.
  const straddling = centredRect({ x: 45, y: 0, width: 20, height: 20 })
  assert(isShapeOnScreen(straddling, view), 'a shape straddling the view edge still overlaps, not culled')

  // Position is a per-frame transform, not baked geometry - moving a shape changes
  // whether it's on screen without needing markGeometryDirty() or any cache invalidation.
  farAway.x = 0
  assert(isShapeOnScreen(farAway, view), 'moving a shape back into view is picked up immediately')

  // A shape emitting no geometry at all (invalid local bounds) is never culled - there's
  // nothing to skip drawing anyway.
  class EmptyShape extends Shape {}
  assert(isShapeOnScreen(new EmptyShape(), view), 'a shape with no geometry is never culled')
}

// --- marquee: nodesInBox picks up everything a dragged rectangle meets ---
{
  const scene = new Scene()
  const left = scene.root.addChild(centredRect({ name: 'left', x: -100, y: 0, width: 40, height: 40 }))
  const right = scene.root.addChild(centredRect({ name: 'right', x: 100, y: 0, width: 40, height: 40 }))
  const far = scene.root.addChild(centredRect({ name: 'far', x: 0, y: 900, width: 40, height: 40 }))

  // A rectangle over just the left shape takes only it - and the drag's corners may be
  // given in any order, since a marquee can be pulled in any direction.
  const onlyLeft = nodesInBox(scene, { x: -140, y: -40 }, { x: -60, y: 40 })
  assert(onlyLeft.length === 1 && onlyLeft[0] === left, 'a box over one shape selects just that shape')
  const reversed = nodesInBox(scene, { x: -60, y: 40 }, { x: -140, y: -40 })
  assert(reversed.length === 1 && reversed[0] === left, 'dragging the box the other way selects the same shape')

  const both = nodesInBox(scene, { x: -200, y: -100 }, { x: 200, y: 100 })
  assert(both.length === 2 && both.includes(left) && both.includes(right), 'a wider box takes both, and not the far one')
  assert(!both.includes(far), 'a shape outside the box is left alone')

  // 'intersect' (the default) takes anything the box touches; 'contain' needs the whole
  // shape inside - the two conventions editors split over.
  const clipping = { from: { x: -140, y: -40 }, to: { x: -100, y: 40 } } // covers half of `left`
  assert(nodesInBox(scene, clipping.from, clipping.to).includes(left), 'intersect mode takes a partly-covered shape')
  assert(
    !nodesInBox(scene, clipping.from, clipping.to, { mode: 'contain' }).includes(left),
    'contain mode skips a shape that is only partly inside',
  )
  assert(
    nodesInBox(scene, { x: -200, y: -100 }, { x: 200, y: 100 }, { mode: 'contain' }).includes(left),
    'contain mode takes a shape that is fully inside',
  )

  // The same visible/pickable rules picking uses - an overlay must not be marquee-able.
  right.pickable = false
  assert(!nodesInBox(scene, { x: -200, y: -100 }, { x: 200, y: 100 }).includes(right), 'a non-pickable shape is skipped')
  right.pickable = true
  left.visible = false
  assert(!nodesInBox(scene, { x: -200, y: -100 }, { x: 200, y: 100 }).includes(left), 'an invisible shape is skipped')
  left.visible = true

  // Results come back in z-order, matching collectZOrder rather than traversal order.
  right.zIndex = -5
  const ordered = nodesInBox(scene, { x: -200, y: -100 }, { x: 200, y: 100 })
  assert(ordered[0] === right, 'marquee results come back in z-order, back to front')
  right.zIndex = 0

  // A moved shape is picked up at its new position: bounds are read live, not cached.
  assert(!nodesInBox(scene, { x: 800, y: 800 }, { x: 1000, y: 1000 }).includes(left), 'sanity: left is not out there yet')
  left.x = 900
  left.y = 900
  assert(nodesInBox(scene, { x: 800, y: 800 }, { x: 1000, y: 1000 }).includes(left), 'a moved shape is found where it now is')
}

// --- a group in a real scene: what draws, what picks, and what a hidden group takes with it
{
  const scene = new Scene()
  const group = scene.root.addChild(new Group({ name: 'assembly', x: 200 }))
  const inGroup = group.addChild(new Rect({ width: 40, height: 40 }))
  const loose = scene.root.addChild(new Rect({ x: -500, y: 0, width: 40, height: 40 }))

  // A group is not itself drawable, so it never appears in the render order - only what it
  // holds does, exactly as if the shapes sat at the root.
  assert(collectZOrder(scene).includes(inGroup), 'a shape inside a group still renders')
  assert(!(collectZOrder(scene) as unknown[]).includes(group), 'the group itself never does - it draws nothing')

  // Picking goes through the group's transform, so the shape is where the group put it.
  assert(hitTestShape(inGroup, 220, -20), "the shape is hit at the group's position, not its own")
  assert(!hitTestShape(inGroup, 20, -20), 'and not at where it would be without the group')
  assert(pickNode(scene, 220, -20) === inGroup, 'a pick returns the SHAPE, not the group that holds it')

  // Hiding the group removes its whole subtree from both, in one move.
  group.visible = false
  assert(!collectZOrder(scene).includes(inGroup), 'a hidden group takes its contents out of the render order')
  assert(pickNode(scene, 220, -20) === null, 'and out of picking')
  assert(collectZOrder(scene).includes(loose), 'while leaving everything outside it alone')
  assert(pickNode(scene, -480, -20) === loose, 'which is still pickable')

  group.visible = true
  assert(collectZOrder(scene).includes(inGroup), 'and showing it brings the subtree back')
}

// --- a hidden group prunes nested subtrees too, however deep ---
{
  const scene = new Scene()
  const outer = scene.root.addChild(new Group())
  const inner = outer.addChild(new Group())
  const deep = inner.addChild(new Group())
  const leaf = deep.addChild(new Rect({ width: 10, height: 10 }))

  assert(collectZOrder(scene).includes(leaf), 'visible all the way down')
  outer.visible = false
  assert(!collectZOrder(scene).includes(leaf), 'hiding the outermost group is enough - the walk turns back there')
  outer.visible = true
  inner.visible = false
  assert(!collectZOrder(scene).includes(leaf), 'and so is hiding one in the middle')
}

console.log(`[scene] self-test passed (${count} assertions)`)
