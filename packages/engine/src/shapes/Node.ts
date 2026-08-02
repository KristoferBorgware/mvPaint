// Node - the scene-graph base (Node → Container → Shape). A Node has an id, a name
// (space-separated tags), a parent link, its own 2D TRANSFORM, and world-transform
// composition. It has NO children of its own - only Container holds children - but
// traversal/search live here via the eachChild() seam so any Node can be walked uniformly
// (a leaf just yields itself).
//
// The transform lives here rather than on Shape because placing yourself in your parent is
// not a drawing concern: a Group places the things inside it and draws nothing at all, and
// a group and a shape have to compose IDENTICALLY or the same gesture would move them
// differently. Shape adds what actually affects rendering - size, fill, stroke, shadow,
// stacking order - on top of this.
//
// nodeName/nodeType plus matches()/find()/findOne()/findAncestor(s)() implement CSS-like
// selectors: '#foo' by id, '.foo' by name, and a bare word by nodeName (the concrete
// class, e.g. 'Rect') or nodeType (the scene-graph tier: 'Node', 'Container' or 'Shape').
//
// getAttr()/setAttr() read and write any of those same typed fields by string key, so code
// that only knows a property's name at runtime (a change-event dispatcher, a property
// inspector, deserialization) doesn't need a per-shape-type switch. setAttr() prefers a
// set<Key>() method when the class declares one - some attributes (TextBlock's runs) are
// read-only properties paired with a method that also invalidates a cache, so a plain
// assignment would either miss that or throw. attrs is a plain-object snapshot built from
// attrKeys(), which each class overrides to append its own attribute names to its parent's;
// the base Node's are just id and name.
//
// on()/off()/once()/fire() make every node an event target. Listeners are keyed by event
// type, each optionally tagged with a dot-namespace ('click.mytool') so a whole group can
// be removed without holding on to individual handler references, and on() also takes a
// selector for delegation - one listener on an ancestor serving every matching descendant.
// fire(type, init, true) walks the event up the parent chain, rewriting currentTarget at
// each level, until a handler cancels it or the chain runs out; enter/leave events never
// bubble (see NON_BUBBLING_EVENTS).
//
// `listening` gates propagation and receipt: an event neither fires on nor travels past a
// node whose isListening() is false, so switching it off on a container makes that whole
// subtree inert. It is separate from Shape.pickable, which governs whether hit-testing can
// return a node at all - a node can be hit-testable but event-deaf, or vice versa. A direct
// fire() call always runs the target's own listeners; `listening` is about events arriving,
// not about explicit invocation.
//
// Column-vector / WebGPU-native: child_world = parent_world * child_local.

import { decompose2D } from '../math/decompose2D'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Vector3 } from '../math/Vector3'
import {
  cloneNodeEvent,
  createNodeEvent,
  NON_BUBBLING_EVENTS,
  type NodeEvent,
  type NodeEventHandler,
  type NodeEventInit,
} from '../events/NodeEvent'
import { countListenersAdded, countListenersRemoved, hasListener } from '../events/listenerCensus'
import { attrChangeEventName } from '../events/sceneEvents'
// Type-only, and it has to stay that way: Container extends Node, so a value import here
// would be a runtime cycle. Nothing below ever references the binding at runtime.
import type { Container } from './Container'

export type NodeVisitor = (node: Node) => void

/** See Node.moveTo. */
export interface MoveOptions {
  /**
   * Keep the node exactly where it is on screen, rewriting its local transform to absorb the
   * difference between the old parent and the new one. Default false, which keeps the node's
   * own x/y/rotation/scale and lets it land wherever those mean inside the new parent.
   */
  keepWorldTransform?: boolean
}

/** One registered listener: its handler plus the dot-namespace it was registered under. */
interface ListenerEntry {
  namespace: string
  handler: NodeEventHandler
}

/** A selector string (see Node.matches) or a predicate called directly with the node. */
export type Selector = string | ((node: Node) => boolean)

/** Every field localMatrix() reads - a complete transform snapshot. See captureTransform. */
export interface NodeTransform {
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
  skewX: number
  skewY: number
  offsetX: number
  offsetY: number
}

/** What any node can be constructed with. Subclass option types extend this. */
export interface NodeOptions {
  name?: string
  id?: string
  x?: number
  y?: number
  scaleX?: number
  scaleY?: number
  /** Radians, about +Z. */
  rotation?: number
  offsetX?: number
  offsetY?: number
  /** Shear: x shifts by skewX per unit y. See Node.skewX. */
  skewX?: number
  /** Shear: y shifts by skewY per unit x. See Node.skewY. */
  skewY?: number
}

/** [[1, skewX], [skewY, 1]]: x slides by skewX per unit y, y by skewY per unit x. */
function skewMatrix(skewX: number, skewY: number): Matrix4x4 {
  const m = Matrix4x4.identity()
  // Column-major, so column 0 is (1, skewY) and column 1 is (skewX, 1).
  m.m[1] = skewY
  m.m[4] = skewX
  return m
}

export class Node {
  /** Free-form, not required to be unique. Selector target: '#foo'. */
  id: string

  /** Space-separated tags. Selector target: '.foo'. See hasName/addName/removeName. */
  name: string

  /** This concrete class, e.g. 'Rect' or 'Transformer'. Fixed - not user-assignable, unlike
   * name. Selector target: 'Rect'. */
  readonly nodeName: string = 'Node'

  /** The tier of the scene-graph hierarchy this node belongs to: 'Node', 'Container' or
   * 'Shape'. Fixed by the class that introduces the tier and inherited unchanged below it,
   * so e.g. every Shape subclass matches the selector 'Shape' regardless of nodeName. */
  readonly nodeType: string = 'Node'

  /** Set by Container.addChild; null for a detached node or the root. */
  parent: Node | null = null

  /** When false, events neither fire on this node nor travel through it. See the header. */
  listening = true

  // --- transform (see the header for what localMatrix() composes them into) ------------

  x = 0
  y = 0
  scaleX = 1
  scaleY = 1
  /** Radians, about +Z. */
  rotation = 0
  /**
   * The node's own pivot, in its local units. Applied FIRST, to the node's own contents,
   * so skew/scale/rotation then act about that point rather than about the local origin.
   */
  offsetX = 0
  offsetY = 0
  /**
   * Shear: skewX slides x by `skewX` per unit of y, and skewY slides y by `skewY` per unit
   * of x - so the matrix contributed is [[1, skewX], [skewY, 1]]. Applied between rotation
   * and scale, which is what lets an arbitrary affine transform be represented exactly:
   * rotate+skew+scale spans every invertible 2x2, so a transformer can non-uniformly scale
   * a ROTATED node without the result having to be approximated.
   */
  skewX = 0
  skewY = 0

  // Set by destroy(), and never unset - see isDestroyed.
  private destroyed = false

  // Allocated on the first on() call rather than in the constructor: most nodes in a large
  // scene never take a listener, and an empty Map each would be pure overhead per node.
  private listeners: Map<string, ListenerEntry[]> | null = null

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

  // localMatrix() is memoized the same way and for the same reason: a node that did not
  // move since the last call hands back the SAME instance, which is what lets the world
  // cache above (and the render lanes' object cache) short-circuit on identity. The cache
  // object is reallocated only on a real change, not on every call.
  private cachedLocal: (NodeTransform & { matrix: Matrix4x4 }) | null = null

  constructor(options: NodeOptions | string = {}, id = '') {
    const o = typeof options === 'string' ? { name: options, id } : options
    this.name = o.name ?? ''
    this.id = o.id ?? ''
    this.x = o.x ?? 0
    this.y = o.y ?? 0
    this.scaleX = o.scaleX ?? 1
    this.scaleY = o.scaleY ?? 1
    this.rotation = o.rotation ?? 0
    this.offsetX = o.offsetX ?? 0
    this.offsetY = o.offsetY ?? 0
    this.skewX = o.skewX ?? 0
    this.skewY = o.skewY ?? 0
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

  /** Attribute keys getAttr()/setAttr()/attrs expose on this node. Override to append the
   * subclass's own keys on top of super.attrKeys(). */
  protected attrKeys(): readonly string[] {
    return ['id', 'name', 'x', 'y', 'scaleX', 'scaleY', 'rotation', 'offsetX', 'offsetY', 'skewX', 'skewY']
  }

  getAttr(key: string): unknown {
    return (this as unknown as Record<string, unknown>)[key]
  }

  /**
   * Writes an attribute and, if anything is listening, raises '<key>Change' with the old and
   * new values. Only a real change is reported, compared by identity - so replacing a fill
   * array raises it while editing that array in place does not.
   */
  setAttr(key: string, value: unknown): this {
    const changeEvent = attrChangeEventName(key)
    const watched = hasListener(changeEvent)
    const oldVal = watched ? this.getAttr(key) : undefined

    const setterName = 'set' + key.charAt(0).toUpperCase() + key.slice(1)
    const target = this as unknown as Record<string, unknown>
    const setter = target[setterName]
    if (typeof setter === 'function') {
      ;(setter as (v: unknown) => void).call(this, value)
    } else {
      target[key] = value
    }

    if (watched) {
      const newVal = this.getAttr(key)
      if (newVal !== oldVal) this.fire(changeEvent, { attr: key, oldVal, newVal }, true)
    }
    return this
  }

  /** A snapshot of every attribute this node currently exposes - see attrKeys(). */
  get attrs(): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const key of this.attrKeys()) result[key] = this.getAttr(key)
    return result
  }

  // --- spatial seam ---

  /**
   * This node's transform relative to its parent:
   *
   *   T(x, y) * R(rotation) * skew * S(scaleX, scaleY) * T(-offsetX, -offsetY)
   *
   * Read right to left, the order the contents experience: the pivot offset shifts them
   * first, then skew/scale/rotation act about that pivot, then the result is placed at
   * (x, y). Each step is skipped when it is the identity, so an unturned, unscaled node
   * costs one translation rather than four multiplications.
   *
   * Overridable - a Camera replaces it with its own view math.
   */
  localMatrix(): Matrix4x4 {
    const c = this.cachedLocal
    if (
      c &&
      c.x === this.x &&
      c.y === this.y &&
      c.rotation === this.rotation &&
      c.scaleX === this.scaleX &&
      c.scaleY === this.scaleY &&
      c.skewX === this.skewX &&
      c.skewY === this.skewY &&
      c.offsetX === this.offsetX &&
      c.offsetY === this.offsetY
    ) {
      return c.matrix
    }

    let m = Matrix4x4.translation(new Vector3(this.x, this.y, 0))
    if (this.rotation !== 0) {
      m = m.mul(Matrix4x4.rotationQuaternion(Quaternion.fromAxisAngle(Vector3.unitZ(), this.rotation)))
    }
    if (this.skewX !== 0 || this.skewY !== 0) {
      m = m.mul(skewMatrix(this.skewX, this.skewY))
    }
    if (this.scaleX !== 1 || this.scaleY !== 1) {
      m = m.mul(Matrix4x4.scaling(new Vector3(this.scaleX, this.scaleY, 1)))
    }
    if (this.offsetX !== 0 || this.offsetY !== 0) {
      m = m.mul(Matrix4x4.translation(new Vector3(-this.offsetX, -this.offsetY, 0)))
    }
    this.cachedLocal = { ...this.captureTransform(), matrix: m }
    return m
  }

  /**
   * The inverse of localMatrix(): takes an arbitrary local matrix apart and stores it in the
   * fields this node actually keeps.
   *
   * The transform is held as rotation/scale/skew rather than as a matrix, so anything that
   * COMPUTES a matrix has to come back through here - a transformer gesture pushing a
   * world-space delta (see transformerMath.applyWorldTransform), or a reparent that has to
   * keep a node where it was on screen (see moveTo).
   *
   * `offsetX`/`offsetY` are held fixed and folded into the position instead, because the
   * pivot belongs to the node rather than to whatever is moving it. Anything the five stored
   * fields cannot express is lost - see decompose2D for what that is, which for an invertible
   * 2D transform is nothing.
   */
  applyLocalMatrix(matrix: Matrix4x4): void {
    const m = matrix.m
    // Column-major: column 0 is the x axis, column 1 the y axis, column 3 the translation.
    const parts = decompose2D(m[0], m[1], m[4], m[5])
    this.rotation = parts.rotation
    this.scaleX = parts.scaleX
    this.scaleY = parts.scaleY
    this.skewX = parts.skewX
    this.skewY = parts.skewY

    // localMatrix() is T(x,y)·R·skew·S·T(-offset), so its translation column reads
    // (x,y) - A·offset for the combined linear part A - hence the pivot is added back here.
    this.x = m[12] + m[0] * this.offsetX + m[4] * this.offsetY
    this.y = m[13] + m[1] * this.offsetX + m[5] * this.offsetY
  }

  /**
   * Every field localMatrix() reads, captured together so a gesture can restore the node
   * exactly as it was. Enumerating them by hand at each call site is what makes adding a
   * new transform field silently break gestures: a partial restore leaves the previous
   * move's value behind, and the next delta compounds onto it instead of replacing it.
   * Keeping the list in one place is the point.
   */
  captureTransform(): NodeTransform {
    return {
      x: this.x,
      y: this.y,
      rotation: this.rotation,
      scaleX: this.scaleX,
      scaleY: this.scaleY,
      skewX: this.skewX,
      skewY: this.skewY,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
    }
  }

  /** Puts the node back exactly as captureTransform() found it. */
  restoreTransform(t: NodeTransform): void {
    this.x = t.x
    this.y = t.y
    this.rotation = t.rotation
    this.scaleX = t.scaleX
    this.scaleY = t.scaleY
    this.skewX = t.skewX
    this.skewY = t.skewY
    this.offsetX = t.offsetX
    this.offsetY = t.offsetY
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
   * space-separated names, anything else matches nodeName or nodeType. Comma-separates
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
        return this.nodeName === clause || this.nodeType === clause
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

  /**
   * Every ancestor matching the selector, nearest first; includes this node when
   * includeSelf. `stopNode`, when given, bounds the walk - it and anything above it are
   * not considered.
   */
  findAncestors(selector: Selector, includeSelf = false, stopNode?: Node): Node[] {
    const result: Node[] = []
    if (includeSelf && this.matches(selector)) result.push(this)
    for (let node = this.parent; node && node !== stopNode; node = node.parent) {
      if (node.matches(selector)) result.push(node)
    }
    return result
  }

  /** The nearest ancestor matching the selector, else null; checks this node when includeSelf. */
  findAncestor(selector: Selector, includeSelf = false, stopNode?: Node): Node | null {
    if (includeSelf && this.matches(selector)) return this
    for (let node = this.parent; node && node !== stopNode; node = node.parent) {
      if (node.matches(selector)) return node
    }
    return null
  }

  /** True if this node is somewhere on `node`'s parent chain. */
  isAncestorOf(node: Node): boolean {
    for (let p = node.parent; p; p = p.parent) {
      if (p === this) return true
    }
    return false
  }

  /**
   * The top of this node's tree - the scene root for anything in a scene, and the node
   * itself for anything detached.
   *
   * The cheapest honest answer to "is this still in the scene?", which is a question anything
   * holding a node across time has to be able to ask: compare two nodes' roots (see
   * Transformer, which lets go of nodes that have left).
   */
  root(): Node {
    let node: Node = this
    while (node.parent) node = node.parent
    return node
  }

  // --- lifecycle ---

  /**
   * Takes this node out of its parent. Safe on a node that has none.
   *
   * The node stays FULLY USABLE: its transform, styling, listeners and children are all
   * intact, and adding it somewhere else picks up exactly where it left off. That is the
   * difference from destroy(), and the reason both exist - taking something out of the scene
   * for a moment (a cut, a drag between containers, a pooled node waiting to be reused) is a
   * different act from finishing with it.
   *
   * Nothing needs telling. The renderer rebuilds its visible set every frame and the lanes
   * repack when their membership changes, so the node stops drawing on the next frame; the
   * shadow atlas frees its slot the next time it bakes, because it prunes against the set of
   * shapes actually present.
   */
  remove(): this {
    // A parent is always a Container - only Container.addChild ever sets the field - but the
    // field is typed Node to keep this module free of an import that would close a cycle
    // (Container extends Node).
    if (this.parent) (this.parent as Container).removeChild(this)
    return this
  }

  /**
   * Finishes with this node and everything under it. The node is not reusable afterwards.
   *
   * remove() first, then teardown: every listener dropped (which is the one thing that does
   * NOT clean itself up - see events/listenerCensus, where a dropped node holding listeners
   * leaves its tally behind), every child destroyed with it, and whatever each subclass holds
   * released (a Shape's tessellation and picking caches - see Shape.releaseResources).
   *
   * A 'destroy' event fires on every node in the subtree BEFORE any of it is detached, so it
   * still has somewhere to bubble and a watcher hears about the whole subtree rather than
   * only its head.
   *
   * WHAT IT DOES NOT FREE is anything the node did not own. An Image's texture belongs to the
   * application, which may well be drawing it in ten other places, so destroying the node
   * leaves it alone; call ImageTexture.destroy() when the picture itself is finished with.
   */
  destroy(): void {
    if (this.destroyed) return
    // Announced while the subtree is still attached, so each event has a parent chain to
    // travel up. Gated, like every other membership event: destroying ten thousand nodes
    // should not walk to the root ten thousand times for listeners nobody registered.
    if (hasListener('destroy')) this.traversePreOrder((node) => node.fire('destroy', {}, true))
    this.remove()
    this.finalize()
  }

  /** True once destroy() has run. A destroyed node is finished; do not put it back. */
  get isDestroyed(): boolean {
    return this.destroyed
  }

  /**
   * The teardown half of destroy(), recursing without re-announcing or re-detaching - the
   * subtree is already unreachable from the scene by the time this runs, so a child needs
   * neither an event nor a splice out of a list that is about to be dropped whole.
   */
  protected finalize(): void {
    this.destroyed = true
    this.eachChild((child) => {
      child.parent = null
      child.finalize()
    })
    this.off()
    this.releaseResources()
  }

  /**
   * Drop whatever this class holds that is worth dropping promptly. Overridden by Container
   * (its children) and Shape (its geometry caches).
   *
   * Only for things that would otherwise be kept alive by something OUTSIDE the node, or that
   * are large enough to be worth releasing before the collector gets to them. Plain fields
   * need nothing: once the scene has let go, the node and everything hanging off it is
   * garbage like any other object.
   */
  protected releaseResources(): void {}

  /**
   * Moves this node to a different parent in one step - remove() and addChild(), with the
   * two things a caller would otherwise have to remember.
   *
   * The first is the cycle check. Moving a node into its own descendant makes a loop that
   * worldMatrix() and every traversal would follow forever, so it throws instead.
   *
   * The second is `keepWorldTransform`. By default the node keeps its own x/y/rotation/scale,
   * so it lands wherever those mean inside the new parent - which is what you want when the
   * parents are peers, and jarring when they are not. Pass true and the node stays exactly
   * where it is on screen, its local transform rewritten to absorb the difference between the
   * two parents (see applyLocalMatrix). That is the one to use for a drag that drops a shape
   * into a group: the shape should not jump because its bookkeeping changed.
   */
  moveTo(parent: Container, options: MoveOptions = {}): this {
    if (parent === (this as unknown as Container)) throw new Error('Node.moveTo: a node cannot be its own parent.')
    if (this.isAncestorOf(parent)) throw new Error('Node.moveTo: cannot move a node into its own descendant.')
    if (this.destroyed) throw new Error('Node.moveTo: this node has been destroyed.')

    // Read before the move - afterwards it would compose the NEW parent's chain.
    const world = options.keepWorldTransform ? this.worldMatrix() : null
    this.remove()
    parent.addChild(this)
    if (world) this.applyLocalMatrix(parent.worldMatrix().inverse().mul(world))
    return this
  }

  // --- events ---

  /** False if this node, or any ancestor, has `listening` switched off. */
  isListening(): boolean {
    for (let node: Node | null = this; node; node = node.parent) {
      if (!node.listening) return false
    }
    return true
  }

  /**
   * Registers a handler. `events` is one or more space-separated types, each optionally
   * carrying a dot-namespace ('click.mytool pointerdown.mytool') that off() can target as a
   * group. Given a selector, the handler is instead delegated: it runs once per matching
   * node on the path from the event's target up to (not including) this one, with
   * currentTarget set to that match.
   */
  on(events: string, handler: NodeEventHandler): this
  on(events: string, selector: Selector, handler: NodeEventHandler): this
  on(events: string, selectorOrHandler: Selector | NodeEventHandler, maybeHandler?: NodeEventHandler): this {
    const handler =
      maybeHandler === undefined
        ? (selectorOrHandler as NodeEventHandler)
        : this.delegatingHandler(selectorOrHandler as Selector, maybeHandler)

    if (!this.listeners) this.listeners = new Map()
    for (const event of splitEvents(events)) {
      const { type, namespace } = parseEventName(event)
      if (!type) continue
      const entries = this.listeners.get(type)
      if (entries) entries.push({ namespace, handler })
      else this.listeners.set(type, [{ namespace, handler }])
      countListenersAdded(type)
    }
    return this
  }

  /**
   * Registers a handler that runs at most once, then removes itself. Given several types,
   * the FIRST of them to fire wins and all of the registrations from this call are dropped -
   * once('pointerup pointercancel', cleanup) runs cleanup exactly once either way.
   */
  once(events: string, handler: NodeEventHandler): this {
    const wrapper: NodeEventHandler = (event) => {
      this.off(events, wrapper)
      handler(event)
    }
    return this.on(events, wrapper)
  }

  /**
   * Removes listeners. With no arguments, every listener on this node; with 'click', every
   * click listener; with 'click.mytool', only that namespace's; with '.mytool', that
   * namespace across all types. A handler narrows any of those to that one registration.
   */
  off(events?: string, handler?: NodeEventHandler): this {
    if (!this.listeners) return this
    if (events === undefined) {
      for (const [type, entries] of this.listeners) countListenersRemoved(type, entries.length)
      this.listeners = null
      return this
    }
    for (const event of splitEvents(events)) {
      const { type, namespace } = parseEventName(event)
      const types = type ? [type] : [...this.listeners.keys()]
      for (const t of types) this.removeListeners(t, namespace, handler)
    }
    if (this.listeners.size === 0) this.listeners = null
    return this
  }

  /** Whether any handler is registered on this node for the given type. */
  hasListeners(type: string): boolean {
    const entries = this.listeners?.get(type)
    return entries !== undefined && entries.length > 0
  }

  /**
   * Dispatches an event. With `bubble`, it continues up the parent chain (rewriting
   * currentTarget at each level) until a handler calls stopPropagation(), an ancestor is
   * not listening, or the root is reached.
   *
   * `boundary` only applies to the enter/leave types, and is the other node of the pair -
   * the one being left when entering, or entered when leaving. It confines the walk to the
   * part of the tree the pointer actually crossed, so an ancestor holding both nodes is not
   * told about a move between two of its own descendants.
   */
  fire<E = unknown>(type: string, init: NodeEventInit<E> = {}, bubble = false, boundary?: Node): this {
    const event = createNodeEvent(type, this, init)
    if (bubble) this.fireAndBubble(type, event, boundary)
    else this.fireLocal(type, event)
    return this
  }

  /**
   * Dispatches an already-built event, taking its type from the object. fire() is the usual
   * way in; this exists for dispatching ONE event object several times, which is how a raw
   * input event reaches both its canonical name and its device alias. Reusing the object
   * carries stopPropagation() across those names: a handler that claims 'pointerdown' also
   * keeps 'mousedown' from reaching the ancestors, while the target itself still hears both.
   */
  dispatchEvent(event: NodeEvent, bubble = false, boundary?: Node): this {
    if (bubble) this.fireAndBubble(event.type, event, boundary)
    else this.fireLocal(event.type, event)
    return this
  }

  /**
   * How many listeners THIS node has for a type - not the subtree, and not the census's
   * global tally (events/listenerCensus.ts), which counts every node in every scene.
   *
   * The two together answer a question worth asking before a hit-test: if a type's global
   * count equals the root's own, then nothing below the root is listening, and since every
   * event bubbles to the root, working out which node was hit cannot change who gets called.
   * See SceneInputDispatcher's dispatchReported.
   */
  ownListenerCount(type: string): number {
    return this.listeners?.get(type)?.length ?? 0
  }

  addEventListener(type: string, handler: NodeEventHandler): this {
    return this.on(type, handler)
  }

  removeEventListener(type: string, handler?: NodeEventHandler): this {
    return this.off(type, handler)
  }

  /**
   * Runs this node's own handlers for the type. Handlers registered DURING the dispatch are
   * not called by it, and handlers removed during it are - the list is snapshotted first,
   * so a handler is free to off() itself or re-register without disturbing the pass.
   */
  protected fireLocal(type: string, event: NodeEvent): void {
    const entries = this.listeners?.get(type)
    if (!entries || entries.length === 0) return
    event.type = type
    event.currentTarget = this
    for (const entry of entries.slice()) entry.handler(event)
  }

  /**
   * Fires on this node then walks upward. `boundary` is the OTHER side of an enter/leave
   * pair - the node being left when entering, or entered when leaving - and confines the
   * walk to the part of the tree the pointer actually crossed: an ancestor containing both
   * nodes was never entered or left, so it is not told about the move.
   */
  protected fireAndBubble(type: string, event: NodeEvent, boundary?: Node): void {
    const nonBubbling = NON_BUBBLING_EVENTS.has(type)
    if (nonBubbling) {
      // Reaching the far side of the pair, or the node containing it, means the walk has
      // arrived at territory the pointer never entered or left.
      if (boundary !== undefined && (this === boundary || this.isAncestorOf(boundary))) return
      if (boundary === undefined && this.parent === null) return
    }

    this.fireLocal(type, event)

    if (event.cancelBubble || !this.parent) return
    // Only this level's flag is read: an ancestor higher up with listening off stops the
    // walk when the recursion reaches it, so the whole chain is covered one link at a time.
    if (!this.parent.listening) return
    // The parent holds both nodes, so the pointer never crossed its edge either.
    if (nonBubbling && boundary === this.parent) return
    this.parent.fireAndBubble(type, event, boundary)
  }

  /** Wraps a handler so it runs for each selector match between the event's target and this node. */
  private delegatingHandler(selector: Selector, handler: NodeEventHandler): NodeEventHandler {
    return (event) => {
      for (const match of event.target.findAncestors(selector, true, this)) {
        const scoped = cloneNodeEvent(event)
        scoped.currentTarget = match
        handler(scoped)
      }
    }
  }

  private removeListeners(type: string, namespace: string, handler?: NodeEventHandler): void {
    const entries = this.listeners?.get(type)
    if (!entries) return
    const kept = entries.filter(
      (entry) => (namespace !== '' && entry.namespace !== namespace) || (handler !== undefined && entry.handler !== handler),
    )
    if (kept.length === entries.length) return
    countListenersRemoved(type, entries.length - kept.length)
    if (kept.length === 0) this.listeners?.delete(type)
    else this.listeners?.set(type, kept)
  }
}

function splitEvents(events: string): string[] {
  return events.split(/\s+/).filter((e) => e !== '')
}

/** 'click.mytool' -> type 'click', namespace 'mytool'; '.mytool' -> every type in that namespace. */
function parseEventName(event: string): { type: string; namespace: string } {
  const dot = event.indexOf('.')
  if (dot < 0) return { type: event, namespace: '' }
  return { type: event.slice(0, dot), namespace: event.slice(dot + 1) }
}
