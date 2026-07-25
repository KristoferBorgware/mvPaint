// Node - the scene-graph base (Node → Container → Shape). A Node has a
// name, a parent link, an overridable localMatrix() transform seam (identity by
// default), and world-transform composition. It has NO children of its own - only
// Container holds children - but traversal/search live here via the eachChild() seam
// so any Node can be walked uniformly (a leaf just yields itself).
//
// Column-vector / WebGPU-native: child_world = parent_world * child_local.

import { Matrix4x4 } from '../math/Matrix4x4'

export type NodeVisitor = (node: Node) => void

export class Node {
  readonly name: string

  /** Set by Container.addChild; null for a detached node or the root. */
  parent: Node | null = null

  constructor(name = '') {
    this.name = name
  }

  // --- spatial seam ---
  // Local transform relative to the parent. The base contributes identity; concrete
  // nodes (Shape, Camera, transform-bearing groups) override it.
  localMatrix(): Matrix4x4 {
    return Matrix4x4.identity()
  }

  // World transform: this node's local matrix composed with all ancestors'. Column-
  // vector, so ancestors multiply on the left: root_local * ... * parent_local * local.
  worldMatrix(): Matrix4x4 {
    let world = this.localMatrix()
    for (let p = this.parent; p !== null; p = p.parent) {
      world = p.localMatrix().mul(world)
    }
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
