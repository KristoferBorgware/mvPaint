// Node - the scene-graph base (Node → Container → Shape). A Node has a
// name, a parent link, an overridable localMatrix() transform seam (identity by
// default), and world-transform composition. It has NO children of its own - only
// Container holds children - but traversal/search live here via the eachChild() seam
// so any Node can be walked uniformly (a leaf just yields itself).
//
// Column-vector / WebGPU-native: child_world = parent_world * child_local.

import { Matrix4x4 } from '../math/Matrix4x4'

export type NodeVisitor = (node: Node) => void

// A Node with no transform of its own (the base localMatrix()) never changes, so every
// such node can share one identity instance instead of each allocating its own every call.
const IDENTITY = Matrix4x4.identity()

export class Node {
  readonly name: string

  /** Set by Container.addChild; null for a detached node or the root. */
  parent: Node | null = null

  // worldMatrix() memoizes on the two Matrix4x4 instances it was built from (this node's
  // own localMatrix() and the parent's worldMatrix()) rather than recomputing from
  // scratch every call. Matrix4x4 instances are never mutated after being returned (every
  // factory/mul() builds a fresh one), so an unchanged reference really does mean an
  // unchanged value - reference equality is a valid, allocation-free dirty check. This is
  // what makes a static scene's per-frame cost collapse to near zero: if nothing moved,
  // every node's localMatrix() returns the same cached instance as last frame, so the
  // whole ancestor chain short-circuits to cached lookups instead of re-multiplying.
  private cachedWorld: Matrix4x4 | null = null
  private cachedWorldLocal: Matrix4x4 | null = null
  private cachedWorldParent: Matrix4x4 | null = null

  constructor(name = '') {
    this.name = name
  }

  // --- spatial seam ---
  // Local transform relative to the parent. The base contributes identity; concrete
  // nodes (Shape, Camera, transform-bearing groups) override it.
  localMatrix(): Matrix4x4 {
    return IDENTITY
  }

  // World transform: this node's local matrix composed with all ancestors'. Column-
  // vector, so ancestors multiply on the left: root_local * ... * parent_local * local.
  worldMatrix(): Matrix4x4 {
    const local = this.localMatrix()
    const parentWorld = this.parent ? this.parent.worldMatrix() : null
    if (this.cachedWorld && local === this.cachedWorldLocal && parentWorld === this.cachedWorldParent) {
      return this.cachedWorld
    }
    const world = parentWorld ? parentWorld.mul(local) : local
    this.cachedWorld = world
    this.cachedWorldLocal = local
    this.cachedWorldParent = parentWorld
    return world
  }

  // --- traversal / search (uniform over leaves and containers) ---
  // Child iteration seam: a leaf Node has none; Container overrides this.
  protected eachChild(_visit: (child: Node) => void): void {}

  traversePreOrder(visit: NodeVisitor): void {
    visit(this)
    this.eachChild((child) => child.traversePreOrder(visit))
  }

  traversePostOrder(visit: NodeVisitor): void {
    this.eachChild((child) => child.traversePostOrder(visit))
    visit(this)
  }

  traverseBreadthFirst(visit: NodeVisitor): void {
    const queue: Node[] = [this]
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i]
      visit(node)
      node.eachChild((child) => queue.push(child))
    }
  }

  // First node in this subtree (this node included) whose name matches, else null.
  findByName(name: string): Node | null {
    if (this.name === name) return this
    let found: Node | null = null
    this.eachChild((child) => {
      if (!found) found = child.findByName(name)
    })
    return found
  }
}
