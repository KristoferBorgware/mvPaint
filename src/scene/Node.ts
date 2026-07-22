// Node - the scene-graph base: pure hierarchy (create / search / traverse) with a
// non-owning parent link and owned children. A Node has NO transform of its own; the
// only spatial element is the overridable localMatrix() seam (identity by default)
// that concrete nodes (e.g. Camera) override. World transforms are composed by the
// structural walk in worldMatrix(), pulling each node's local matrix through that seam,
// so transform data lives solely in the derived class.
//
// TypeScript port of Fungine3D's Scene/Node.h/.cpp, adapted to our column-vector
// convention: child_world = parent_world * child_local.

import { Matrix4x4 } from '../math/Matrix4x4'

export type NodeVisitor = (node: Node) => void

export class Node {
  readonly name: string

  private parentNode: Node | null = null
  private readonly childNodes: Node[] = []

  constructor(name = '') {
    this.name = name
  }

  get parent(): Node | null {
    return this.parentNode
  }

  get children(): readonly Node[] {
    return this.childNodes
  }

  // --- create ---
  // Adds an existing child (takes ownership of the reference), sets its parent, and
  // returns it (typed), so `const c = node.addChild(new Camera())` keeps the subtype.
  addChild<T extends Node>(child: T): T {
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  // --- search ---
  // First node in this subtree (this node included) whose name matches, else null.
  findByName(name: string): Node | null {
    if (this.name === name) return this
    for (const child of this.childNodes) {
      const found = child.findByName(name)
      if (found) return found
    }
    return null
  }

  // --- traverse (visitor invoked once per node, this node included) ---
  traversePreOrder(visit: NodeVisitor): void {
    visit(this)
    for (const child of this.childNodes) child.traversePreOrder(visit)
  }

  traversePostOrder(visit: NodeVisitor): void {
    for (const child of this.childNodes) child.traversePostOrder(visit)
    visit(this)
  }

  traverseBreadthFirst(visit: NodeVisitor): void {
    const queue: Node[] = [this]
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i]
      visit(node)
      for (const child of node.childNodes) queue.push(child)
    }
  }

  // --- spatial seam ---
  // Local transform relative to the parent. The base contributes identity; concrete
  // nodes override to supply their own (e.g. from a Transform).
  localMatrix(): Matrix4x4 {
    return Matrix4x4.identity()
  }

  // World transform: this node's local matrix composed with all ancestors'. Column-
  // vector, so ancestors multiply on the left: root_local * ... * parent_local * local.
  worldMatrix(): Matrix4x4 {
    let world = this.localMatrix()
    for (let p = this.parentNode; p !== null; p = p.parentNode) {
      world = p.localMatrix().mul(world)
    }
    return world
  }
}
