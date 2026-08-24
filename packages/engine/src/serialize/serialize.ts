// Turning a scene into plain data and back, and copying a node in memory.
//
// DELIBERATELY NOT ON Node. A node's job is to be part of a picture; a document format is a
// separate concern with its own versioning, its own decisions about what a texture becomes on
// disk, and its own reasons to change. Keeping it out here means a scene graph carries no
// opinion about how it is stored, and an application with its own format can ignore all of this
// and walk attributeNames() itself.
//
// WHAT A NODE IS, written down: its class name, the attributes that differ from that class's
// defaults, and its children. Defaults are left out because a document is read by people as
// well as by programs, and forty unchanged values around each of two changed ones is not
// legible. It also means a class that gains an attribute reads old documents unchanged - the
// missing key is the default, which is what it would have been.
//
// WHAT DOES NOT FIT IN JSON is the honest limit here: a texture is a GPU object and a
// dragBoundFunc is a function, so neither survives a round trip through data. They are skipped
// rather than mangled, and `replace`/`revive` are how an application says what should stand in
// for them - a texture as the URL it was loaded from, most obviously. What was skipped is
// reported rather than silently dropped.

import { Container } from '../shapes/Container'
import type { Node } from '../shapes/Node'
import { createNode } from './nodeRegistry'
import { reserveZIndex } from '../shapes/zOrder'
import { SharedLifetime, type Shared } from '../resources/SharedLifetime'

/** One node as plain data - the shape a document is made of. */
export interface NodeSnapshot {
  /** The class name, as `nodeName` reports it. See nodeRegistry. */
  className: string
  /** Only the attributes that differ from the class's defaults. */
  attrs: Record<string, unknown>
  /** Absent rather than empty for a leaf, so a document of shapes carries no empty arrays. */
  children?: NodeSnapshot[]
}

export interface ToObjectOptions {
  /**
   * Called for every attribute whose value cannot be written as data - a texture, a function,
   * a class instance. Return what should stand in for it, or undefined to leave it out.
   *
   *   replace: (node, key, value) =>
   *     key === 'texture' ? (value as MyTexture).url : undefined
   */
  replace?: (node: Node, key: string, value: unknown) => unknown
  /**
   * Called with each attribute that was left out and nothing stood in for it. For a caller that
   * wants to warn, or to refuse to save a document it cannot fully describe.
   */
  onSkipped?: (node: Node, key: string, value: unknown) => void
}

export interface FromObjectOptions {
  /**
   * Turns a stand-in back into the value the node needs - the other half of `replace`. Called
   * for every attribute in the snapshot, so an untouched value passes straight through.
   *
   *   revive: (className, key, value) =>
   *     key === 'texture' ? images.load(value as string) : value
   */
  revive?: (className: string, key: string, value: unknown) => unknown
}

/**
 * True for a value that survives JSON: the primitives, and arrays and plain objects made of
 * them, all the way down.
 *
 * Structural rather than by type name, because the values that need writing are structural -
 * a colour is a four-number array, a gradient stop list is an array of {offset, color}, a crop
 * is a plain rectangle. Anything with a prototype of its own is something the engine built and
 * something a reader would have to know how to rebuild, which is exactly what `replace` is for.
 */
function isPlainData(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value as number)
  if (type !== 'object') return false

  const object = value as object
  // A cycle cannot be written, and following it would not return.
  if (seen.has(object)) return false
  seen.add(object)
  if (Array.isArray(object)) return object.every((entry) => isPlainData(entry, seen))
  if (Object.getPrototypeOf(object) !== Object.prototype && Object.getPrototypeOf(object) !== null) return false
  return Object.values(object).every((entry) => isPlainData(entry, seen))
}

/**
 * A node and everything under it as plain data.
 *
 * `undefined` attributes are left out along with the defaults - a key that is not there reads
 * back as the default, and for these two that is the same value.
 */
export function toObject(node: Node, options: ToObjectOptions = {}): NodeSnapshot {
  const defaults = node.attributeDefaults()
  const attrs: Record<string, unknown> = {}

  for (const key of node.attributeNames()) {
    const value = node.getAttr(key)
    if (key in defaults && sameValue(value, defaults[key])) continue
    if (value === undefined) continue

    if (isPlainData(value)) {
      attrs[key] = value
      continue
    }
    const stand = options.replace?.(node, key, value)
    if (stand !== undefined) attrs[key] = stand
    else options.onSkipped?.(node, key, value)
  }

  const snapshot: NodeSnapshot = { className: node.nodeName, attrs }
  if (node instanceof Container && node.hasChildren()) {
    snapshot.children = node.getChildren().map((child) => toObject(child, options))
  }
  return snapshot
}

/**
 * Compares an attribute against its default. Arrays and plain objects go by value, because a
 * default is a frozen literal and the node's own value is whatever a constructor built - two
 * empty arrays that are equal in every way a document cares about, and never the same object.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, i) => sameValue(entry, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object)
    const kb = Object.keys(b as object)
    if (ka.length !== kb.length) return false
    return ka.every((key) =>
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  }
  return false
}

/**
 * Rebuilds a node and its subtree from a snapshot.
 *
 * The stacking counter is wound forward past every zIndex read (see zOrder.ts), so a shape made
 * AFTER a document is loaded lands in front of it rather than somewhere in the middle of it.
 * That is the one piece of global state a load touches, and leaving it alone is the bug: a
 * freshly drawn shape appearing behind a loaded drawing looks like the drawing tool is broken.
 */
export function fromObject(snapshot: NodeSnapshot, options: FromObjectOptions = {}): Node {
  const attrs: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(snapshot.attrs)) {
    const revived = options.revive ? options.revive(snapshot.className, key, value) : value
    if (revived !== undefined) attrs[key] = revived
  }

  const node = createNode(snapshot.className, attrs)
  if (typeof attrs.zIndex === 'number') reserveZIndex(attrs.zIndex)

  // Attributes that are not constructor options - a class may expose more than it takes - are
  // written afterwards. Guarded setters make this free for everything the constructor already
  // applied.
  for (const [key, value] of Object.entries(attrs)) {
    if (node.getAttr(key) !== value) node.setAttr(key, value)
  }

  if (snapshot.children && node instanceof Container) {
    for (const child of snapshot.children) node.addChild(fromObject(child, options))
  }
  return node
}

/** True for a value that carries its own holder count - an ImageTexture, a SharedValue. */
function isShared(value: unknown): value is Shared {
  return typeof value === 'object' && value !== null && (value as { lifetime?: unknown }).lifetime instanceof SharedLifetime
}

/**
 * A live copy of a node and its subtree, sharing whatever it holds rather than rebuilding it -
 * two Images from one clone() draw the same texture, and the texture is loaded once.
 *
 * An attribute that carries its own holder count - an ImageTexture, most often - is retained
 * once more for the copy, so the two nodes are two holders of one resource rather than one
 * holder that two nodes happen to point at. destroy()ing each node's texture once each then
 * frees it correctly, on the second call rather than the first. An attribute named in
 * `overrides` is the caller's own object and is left alone - only what clone() itself copies
 * gains a hold.
 *
 * That is the difference from `fromObject(toObject(node))`, and the reason both exist: a
 * document is data and cannot hold a GPU object, while a copy is a second node in the same
 * running scene and can hold everything the first one does.
 *
 * The copy is DETACHED - it has no parent until it is added to one - and keeps the original's
 * zIndex, so the two tie and fall back to scene order. `clone(node, { zIndex: nextZIndex() })`
 * puts the copy on top.
 *
 * LISTENERS ARE NOT COPIED. A handler is written for the node it was registered on and usually
 * closes over it, so copying one gives two nodes whose handlers both talk about the first.
 */
export function clone<T extends Node>(node: T, overrides: Readonly<Record<string, unknown>> = {}): T {
  for (const [key, value] of Object.entries(node.attrs)) {
    if (!(key in overrides) && isShared(value)) value.lifetime.retain()
  }

  const copy = createNode(node.nodeName, { ...node.attrs, ...overrides }) as T
  if (node instanceof Container && copy instanceof Container) {
    for (const child of node.children) copy.addChild(clone(child))
  }
  return copy
}
