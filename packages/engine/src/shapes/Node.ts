// Node - the scene-graph base (Node → Container → Shape). A Node has an id, a name
// (space-separated tags), a parent link, an overridable localMatrix() transform seam
// (identity by default), and world-transform composition. It has NO children of its own -
// only Container holds children - but traversal/search live here via the eachChild() seam
// so any Node can be walked uniformly (a leaf just yields itself).
//
// className/nodeType plus matches()/find()/findOne()/findAncestor(s)() implement CSS-like
// selectors: '#foo' by id, '.foo' by name, and a bare word by className (the concrete
// class, e.g. 'Rect') or nodeType (the scene-graph tier: 'Node', 'Container' or 'Shape').
//
// Column-vector / WebGPU-native: child_world = parent_world * child_local.

import { Matrix4x4 } from '../math/Matrix4x4'

export type NodeVisitor = (node: Node) => void

/** A selector string (see Node.matches) or a predicate called directly with the node. */
export type Selector = string | ((node: Node) => boolean)

// A Node with no transform of its own (the base localMatrix()) never changes, so every
// such node can share one identity instance instead of each allocating its own every call.
const IDENTITY = Matrix4x4.identity()

export class Node {
  /** Free-form, not required to be unique. Selector target: '#foo'. */
  id: string

  /** Space-separated tags. Selector target: '.foo'. See hasName/addName/removeName. */
  name: string

  /** This concrete class, e.g. 'Rect' or 'Transformer'. Selector target: 'Rect'. */
  readonly className: string = 'Node'

  /** The tier of the scene-graph hierarchy this node belongs to: 'Node', 'Container' or
   * 'Shape'. Fixed by the class that introduces the tier and inherited unchanged below it,
   * so e.g. every Shape subclass matches the selector 'Shape' regardless of className. */
  readonly nodeType: string = 'Node'

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

  constructor(name = '', id = '') {
    this.name = name
    this.id = id
  }

  hasName(name: string): boolean {
    if (!name) return false
    return this.name.split(/\s+/).includes(name)
  }

  addName(name: string): void {
    if (this.hasName(name)) return
    this.name = this.name ? `${this.name} ${name}` : name
  }

  removeName(name: string): void {
    this.name = this.name
      .split(/\s+/)
      .filter((n) => n && n !== name)
      .join(' ')
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

  /**
   * Tests this node against a selector: '#foo' matches id, '.foo' matches one of the
   * space-separated names, anything else matches className or nodeType. Comma-separates
   * multiple clauses (OR). A function selector is called directly with this node.
   */
  matches(selector: Selector): boolean {
    if (typeof selector === 'function') return selector(this)
    return selector
      .split(',')
      .map((clause) => clause.trim())
      .some((clause) => {
        if (clause.startsWith('#')) return this.id === clause.slice(1)
        if (clause.startsWith('.')) return this.hasName(clause.slice(1))
        return this.className === clause || this.nodeType === clause
      })
  }

  /** Every descendant (not including this node) matching the selector, in pre-order. */
  find(selector: Selector): Node[] {
    const result: Node[] = []
    this.eachChild((child) => {
      if (child.matches(selector)) result.push(child)
      result.push(...child.find(selector))
    })
    return result
  }

  /** The first descendant matching the selector in pre-order, else null. */
  findOne(selector: Selector): Node | null {
    let found: Node | null = null
    this.eachChild((child) => {
      if (found) return
      found = child.matches(selector) ? child : child.findOne(selector)
    })
    return found
  }

  /** Every ancestor matching the selector, nearest first; includes this node when includeSelf. */
  findAncestors(selector: Selector, includeSelf = false): Node[] {
    const result: Node[] = []
    if (includeSelf && this.matches(selector)) result.push(this)
    for (let node = this.parent; node; node = node.parent) {
      if (node.matches(selector)) result.push(node)
    }
    return result
  }

  /** The nearest ancestor matching the selector, else null; checks this node when includeSelf. */
  findAncestor(selector: Selector, includeSelf = false): Node | null {
    if (includeSelf && this.matches(selector)) return this
    for (let node = this.parent; node; node = node.parent) {
      if (node.matches(selector)) return node
    }
    return null
  }
}
