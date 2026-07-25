// Self-test for the ported scene graph (Node / Container / Shape + Scene). Run with:
//   npx tsx src/scene/selfTest.ts

import { Container } from './Container'
import { Node } from './Node'
import { Scene } from './Scene'
import { OrthographicCamera } from '../camera/OrthographicCamera'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Transform } from '../math/Transform'
import { Vector3 } from '../math/Vector3'
import { Circle } from '../shapes/Circle'
import { Rect } from '../shapes/Rect'
import { Shape } from './Shape'
import type { MeshSink } from '../render/meshFormat'
import { hitTestShape, pickNode, shapeLocalBounds, textLocalBounds } from './picking'

let count = 0
function assert(cond: boolean, msg: string): void {
  count++
  if (!cond) throw new Error(`[scene] self-test FAILED: ${msg}`)
}
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

  const found = root.findByName('a2')
  assert(found !== null && found.name === 'a2', 'findByName hit')
  assert(root.findByName('missing') === null, 'findByName miss')

  assert(root.removeChild(a) && root.children.length === 1, 'removeChild detaches')
  assert(a.parent === null, 'removeChild clears parent')
}

// --- Scene resolves the active camera anywhere in the tree ---
{
  const scene = new Scene()
  const rig = scene.root.addChild(new Container('rig'))
  const cam = rig.addChild(new OrthographicCamera('main-cam'))
  cam.active = true

  assert(scene.activeCamera === null, 'no active camera before refresh')
  assert(scene.refreshActiveCamera() === cam, 'refresh finds the active camera')
  assert(scene.activeCamera === cam, 'active camera cached')

  cam.active = false
  assert(scene.refreshActiveCamera() === null, 'no active camera when flag cleared')
}

// --- picking: hitTestShape tests against the shape's own tessellated triangles ---
{
  const rect = new Rect({ x: 100, y: 50, width: 40, height: 20 })
  assert(hitTestShape(rect, 100, 50), 'rect center hits')
  assert(hitTestShape(rect, 119, 59), 'just inside rect corner hits')
  assert(!hitTestShape(rect, 121, 50), 'just outside rect on x misses')
  assert(!hitTestShape(rect, 0, 0), 'far outside rect misses')

  const bounds = shapeLocalBounds(rect)
  assert(bounds.valid(), 'rect local bounds valid')
  assert(
    Math.abs(bounds.min.x + 20) < 1e-6 && Math.abs(bounds.max.x - 20) < 1e-6,
    'rect local bounds span its own half-width, centered on local origin',
  )

  const circle = new Circle({ x: 0, y: 0, radius: 30 })
  assert(hitTestShape(circle, 0, 0), 'circle center hits')
  assert(hitTestShape(circle, 29, 0), 'inside circle radius hits')
  assert(!hitTestShape(circle, 31, 0), 'outside circle radius misses')

  // A degenerate (zero-area) triangle - legitimate in tessellated output (e.g. a
  // duplicate point from a stroke join), harmless for the GPU rasterizer - must never
  // match every point: its three edge signs are all exactly 0, so a naive "no negative
  // and no positive edge sign" test would wrongly call it a universal hit.
  class DegenerateShape extends Shape {
    tessellate(sink: MeshSink): void {
      const a = sink.vertex(10, 130, this.fill, true)
      const b = sink.vertex(10, 130, this.fill, true)
      const c = sink.vertex(10, 130, this.fill, true)
      sink.triangle(a, b, c)
    }
  }
  const degenerate = new DegenerateShape()
  assert(!hitTestShape(degenerate, 3000, 0), 'a degenerate triangle does not match a far-away point')
  assert(!hitTestShape(degenerate, 10, 130), 'a degenerate triangle does not match even its own collapsed point')

  // A 90deg rotation swaps which world axis lines up with the rect's long (width) side:
  // local = R(-rotation) * (world - center), so R(-90deg) maps (x,y) -> (y,-x).
  const rotated = new Rect({ x: 0, y: 0, width: 40, height: 10, rotation: Math.PI / 2 })
  assert(hitTestShape(rotated, 0, 19), 'rotated rect hits along its now-vertical long axis')
  assert(!hitTestShape(rotated, 19, 0), 'rotated rect misses where the unrotated rect would have hit')
}

// --- picking: pickNode finds the topmost hit and respects visible/pickable ---
{
  const scene = new Scene()
  const back = scene.root.addChild(new Rect({ name: 'back', x: 0, y: 0, width: 100, height: 100 }))
  const front = scene.root.addChild(new Rect({ name: 'front', x: 20, y: 0, width: 60, height: 60 }))

  assert(pickNode(scene, -40, 0) === back, 'point over only the back rect picks it')
  assert(pickNode(scene, 20, 0) === front, 'overlapping point picks the later (topmost) node')
  assert(pickNode(scene, 500, 500) === null, 'empty space picks nothing')

  front.visible = false
  assert(pickNode(scene, 20, 0) === back, 'invisible node is skipped, falls through to the one below')
  front.visible = true

  front.pickable = false
  assert(pickNode(scene, 20, 0) === back, 'non-pickable node is skipped, falls through to the one below')
}

// --- picking: textLocalBounds unions every quad's corners ---
{
  const bounds = textLocalBounds({
    quads: [
      { x0: 0, y0: 0, x1: 10, y1: -5 },
      { x0: 8, y0: -5, x1: 20, y1: -12 },
    ],
  })
  assert(bounds.valid(), 'text bounds valid for a non-empty quad list')
  assert(bounds.min.x === 0 && bounds.max.x === 20, 'text bounds union x across all quads')
  assert(bounds.min.y === -12 && bounds.max.y === 0, 'text bounds union y across all quads')
  assert(!textLocalBounds({ quads: [] }).valid(), 'text bounds invalid for no quads')
}

console.log(`[scene] self-test passed (${count} assertions)`)
