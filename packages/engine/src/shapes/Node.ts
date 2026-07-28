// Node - the scene-graph base (Node → Container → Shape). A Node has an id, a name
// (space-separated tags), a parent link, an overridable localMatrix() transform seam
// (identity by default), and world-transform composition. It has NO children of its own -
// only Container holds children - but traversal/search live here via the eachChild() seam
// so any Node can be walked uniformly (a leaf just yields itself).
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

import { Matrix4x4 } from '../math/Matrix4x4'
import {
  cloneNodeEvent,
  createNodeEvent,
  NON_BUBBLING_EVENTS,
  type NodeEvent,
  type NodeEventHandler,
  type NodeEventInit,
} from '../events/NodeEvent'

export type NodeVisitor = (node: Node) => void

/** One registered listener: its handler plus the dot-namespace it was registered under. */
interface ListenerEntry {
  namespace: string
  handler: NodeEventHandler
}

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

  /** Attribute keys getAttr()/setAttr()/attrs expose on this node. Override to append the
   * subclass's own keys on top of super.attrKeys(). */
  protected attrKeys(): readonly string[] {
    return ['id', 'name']
  }

  getAttr(key: string): unknown {
    return (this as unknown as Record<string, unknown>)[key]
  }

  setAttr(key: string, value: unknown): this {
    const setterName = 'set' + key.charAt(0).toUpperCase() + key.slice(1)
    const target = this as unknown as Record<string, unknown>
    const setter = target[setterName]
    if (typeof setter === 'function') {
      ;(setter as (v: unknown) => void).call(this, value)
    } else {
      target[key] = value
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
   * Dispatches an already-built event, taking its type from the object. Runs this node's
   * handlers only - use fire(type, init, true) to bubble.
   */
  dispatchEvent(event: NodeEvent): this {
    event.currentTarget = this
    this.fireLocal(event.type, event)
    return this
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
