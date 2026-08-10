// Who holds whom, and who the pointer can reach.
//
// Both are facts the whole scene is derived from - the render walk, picking, marquee selection
// and every measurement walk the same tree - so a node in two places at once or a subtree that
// is drawn but untouchable has to behave exactly one way.

import { expect, it } from 'vitest'
import { Container } from './Container'
import { Group } from './Group'
import { Layer } from './Layer'
import type { Node } from './Node'
import { Rect } from './Rect'
import { Scene } from '../scene/Scene'
import { getAllIntersections, pickNode } from '../scene/picking'
import { nodesInBox } from '../scene/selection'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}

/** How many times a walk from `root` reaches `node` - one, for a node in one place. */
function timesReached(root: Node, node: Node): number {
  let count = 0
  root.traversePreOrder((n) => {
    if (n === node) count++
  })
  return count
}

it('a node has one parent, and moving it takes it out of the old one', () => {
  const root = new Container()
  const a = root.addChild(new Group({ name: 'a' }))
  const b = root.addChild(new Group({ name: 'b' }))
  const rect = a.addChild(new Rect({ width: 1, height: 1 }))

  b.addChild(rect)

  assert(a.children.length === 0, 'the container it left no longer holds it')
  assert(b.children.length === 1 && b.children[0] === rect, 'and the one it joined does')
  assert(rect.parent === b, 'with its parent pointer agreeing')
  assert(timesReached(root, rect) === 1, 'so a walk of the scene reaches it exactly once')
})

it('add is variadic and chainable, and each child is detached in turn', () => {
  const old = new Group()
  const one = old.addChild(new Rect({ name: 'one', width: 1, height: 1 }))
  const two = new Rect({ name: 'two', width: 1, height: 1 })

  const group = new Group()
  const returned = group.add(one, two)

  assert(returned === group, 'add returns the container, so calls chain')
  assert(group.children.length === 2, 'both children landed')
  assert(old.children.length === 0, 'and the one that had a parent was taken out of it')

  assert(group.add() === group, 'adding nothing is allowed and does nothing')
  assert(group.children.length === 2, 'the list is untouched')

  // Re-adding a node already here moves it to the end rather than duplicating it.
  group.addChild(one)
  assert(group.children.length === 2, 'no duplicate')
  assert(group.children[1] === one, 'and it moved to the end')
})

it('a container cannot be put inside itself or its own descendant', () => {
  const outer = new Group()
  const inner = outer.addChild(new Group())

  let threwSelf = false
  try {
    outer.addChild(outer)
  } catch {
    threwSelf = true
  }
  assert(threwSelf, 'a node cannot contain itself')

  let threwCycle = false
  try {
    inner.addChild(outer)
  } catch {
    threwCycle = true
  }
  assert(threwCycle, 'nor can it be put inside something it already holds')
  assert(outer.parent === null && inner.parent === outer, 'and the tree is left as it was')
})

it('the child list can be read, counted, emptied and finished with', () => {
  const group = new Group()
  assert(!group.hasChildren(), 'an empty container says so')
  group.add(
    new Rect({ name: 'keep', width: 1, height: 1 }),
    new Rect({ name: 'drop', width: 1, height: 1 }),
  )
  assert(group.hasChildren(), 'and a filled one says that')

  const copy = group.getChildren()
  copy.length = 0
  assert(group.children.length === 2, 'getChildren hands back a copy, safe to mutate')

  const kept = group.getChildren((child) => child.name === 'keep')
  assert(kept.length === 1 && kept[0].name === 'keep', 'and it filters')

  const survivor = group.children[0]
  group.removeChildren()
  assert(group.children.length === 0 && !survivor.isDestroyed, 'removeChildren empties it, leaving each child usable')

  group.add(survivor, new Rect({ width: 1, height: 1 }))
  const doomed = group.children[0]
  group.destroyChildren()
  assert(group.children.length === 0, 'destroyChildren empties it too')
  assert(doomed.isDestroyed, 'but finishes with each child')
})

it('listening is the single switch on whether the pointer can reach a subtree', () => {
  const scene = new Scene()
  const layer = scene.root.addChild(new Layer())
  const rect = layer.addChild(new Rect({ x: -10, y: -10, width: 20, height: 20, fill: 'tomato', strokeWidth: 0 }))

  assert(pickNode(scene, 0, 0) === rect, 'an ordinary shape is under the pointer')
  assert(nodesInBox(scene, { x: -50, y: -50 }, { x: 50, y: 50 }).includes(rect), 'and inside a marquee')

  // Switched off at the CONTAINER: the walk turns back there rather than asking the shape.
  layer.listening = false
  assert(pickNode(scene, 0, 0) === null, 'a non-listening layer takes its contents out of picking')
  assert(!nodesInBox(scene, { x: -50, y: -50 }, { x: 50, y: 50 }).includes(rect), 'and out of a marquee')
  assert(rect.visible && rect.listening, 'while the shape itself is untouched - it still draws')

  layer.listening = true
  assert(pickNode(scene, 0, 0) === rect, 'and switching it back brings the whole subtree back')

  // The shape's own switch does the same for itself alone.
  rect.listening = false
  assert(pickNode(scene, 0, 0) === null, 'a non-listening shape is not returned either')
})

it('getAllIntersections returns the whole column, topmost first', () => {
  const scene = new Scene()
  const back = scene.root.addChild(new Rect({ x: -10, y: -10, width: 20, height: 20, fill: 'teal', strokeWidth: 0 }))
  const front = scene.root.addChild(new Rect({ x: -5, y: -5, width: 10, height: 10, fill: 'tomato', strokeWidth: 0 }))

  const all = getAllIntersections(scene, 0, 0)
  assert(all.length === 2, 'both shapes are under the point')
  assert(all[0] === front && all[1] === back, 'ordered top to bottom')
  assert(pickNode(scene, 0, 0) === all[0], 'and a plain pick is the first of them')

  // Only the larger one reaches out here.
  const edge = getAllIntersections(scene, 8, 8)
  assert(edge.length === 1 && edge[0] === back, 'where only one shape is, only one comes back')

  // Same reachability rules as a pick.
  front.listening = false
  assert(getAllIntersections(scene, 0, 0).join() === [back].join(), 'a node the pointer cannot reach is not in the column')
})
