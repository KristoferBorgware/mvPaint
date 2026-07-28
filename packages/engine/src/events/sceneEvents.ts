// The events the scene raises about itself, rather than about a pointer: a node being
// dragged or transformed, an attribute changing, a child joining or leaving a container,
// and the selection or the selection box moving.
//
// All of them bubble, so a container - usually the scene root - can watch its whole subtree
// with one listener instead of one per node. None carries `evt`: each is derived from a
// gesture or an API call rather than from a single DOM event, and there is no one raw event
// that would honestly represent it.
//
// Every site that fires one of these checks the census first (see listenerCensus). That
// matters most for 'add': building a scene of a hundred thousand shapes is a hundred
// thousand addChild calls, and an event walking to the root on each of them - even one no
// handler ever sees - would be paid for in full during every scene load.

import type { Vector2 } from '../math/Vector2'
import type { Node } from '../shapes/Node'
import type { NodeEvent } from './NodeEvent'

/** Fired on a node as it is dragged. `nodes` is the whole set moving together. */
export interface DragNodeEvent extends NodeEvent {
  nodes: readonly Node[]
}

/** Fired on a node as it is resized or rotated. `nodes` is the whole set being transformed. */
export type TransformNodeEvent = DragNodeEvent

/**
 * Fired on a node when setAttr changes one of its attributes. Note that assigning the field
 * directly - `shape.x = 5` rather than `shape.setAttr('x', 5)` - does not raise this; see
 * Node's header for why the attributes are plain fields.
 */
export interface AttrChangeEvent<T = unknown> extends NodeEvent {
  /** The attribute's name. The event's own type is this plus 'Change'. */
  attr: string
  oldVal: T
  newVal: T
}

/** Fired on a container when a child joins or leaves it. */
export interface ChildEvent extends NodeEvent {
  child: Node
}

/** Fired on the scene root whenever the selection changes. */
export interface SelectionEvent extends NodeEvent {
  selection: readonly Node[]
}

/**
 * Fired on the scene root as a selection box is pulled out. `from` and `to` are its opposite
 * corners in world space; on 'marqueeend' `selection` is what it ended up selecting, which
 * is empty when the gesture was abandoned rather than completed.
 */
export interface MarqueeEvent extends NodeEvent {
  from: Vector2
  to: Vector2
  selection?: readonly Node[]
}

/** Every scene event with a fixed name. Attribute changes are named after their attribute. */
export const SCENE_EVENTS = [
  'dragstart',
  'dragmove',
  'dragend',
  'transformstart',
  'transform',
  'transformend',
  'add',
  'remove',
  'selectionchange',
  'marqueestart',
  'marqueemove',
  'marqueeend',
] as const

export type SceneEventName = (typeof SCENE_EVENTS)[number]

/** The event type an attribute's changes are reported under. */
export function attrChangeEventName(attr: string): string {
  return `${attr}Change`
}
