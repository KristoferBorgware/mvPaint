// Self-test for the ported scene graph (Node + Scene). Mirrors the non-GameObject
// parts of Fungine3D's Scene/SceneSelfTest.cpp. Run with:
//   npx tsx src/scene/selfTest.ts

import { Node } from './Node'
import { Scene } from './Scene'
import { FreeFloatCamera } from '../camera/FreeFloatCamera'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Transform } from '../math/Transform'
import { Vector3 } from '../math/Vector3'

let count = 0
function assert(cond: boolean, msg: string): void {
  count++
  if (!cond) throw new Error(`[scene] self-test FAILED: ${msg}`)
}
const eq = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i])

// A minimal node carrying a local transform, so the hierarchy math can be checked
// without a GameObject/Mesh (mirrors the C++ TestNode).
class TransformNode extends Node {
  readonly local = new Transform()
  override localMatrix(): Matrix4x4 {
    return this.local.toMatrix()
  }
}

// --- hierarchy composition: child_world == parent_local * child_local (column-vector) ---
{
  const parent = new TransformNode('parent')
  parent.local.position = new Vector3(10, 0, 0)
  parent.local.rotation = Quaternion.fromAxisAngle(Vector3.up(), Math.PI / 2)

  const child = new TransformNode('child')
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
  const root = new Node('root')
  const a = root.addChild(new Node('a'))
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
}

// --- Scene resolves the active camera anywhere in the tree ---
{
  const scene = new Scene()
  const rig = scene.root.addChild(new Node('rig'))
  const cam = rig.addChild(new FreeFloatCamera('main-cam'))
  cam.active = true

  assert(scene.activeCamera === null, 'no active camera before refresh')
  assert(scene.refreshActiveCamera() === cam, 'refresh finds the active camera')
  assert(scene.activeCamera === cam, 'active camera cached')

  cam.active = false
  assert(scene.refreshActiveCamera() === null, 'no active camera when flag cleared')
}

console.log(`[scene] self-test passed (${count} assertions)`)
