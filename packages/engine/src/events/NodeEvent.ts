// The event object scene-graph listeners receive, and the dispatch-semantics tables Node
// consults when propagating one.
//
// A single event object is created per dispatch and MUTATED as it travels up the tree -
// `target` stays the node the event originated on, `currentTarget` is rewritten to
// whichever ancestor is handling it right now. Handlers must therefore read what they need
// during the call rather than stashing the object for later; the alternative, a fresh
// object per ancestor, would allocate once per level on every pointer move.
//
// `evt` carries the raw DOM event a dispatch came from (PointerEvent, WheelEvent,
// KeyboardEvent) and is absent on purely synthetic events.

import type { Vector2 } from '../math/Vector2'
import type { Node } from '../shapes/Node'

export interface NodeEvent<E = unknown> {
  type: string
  /** Where the event originated - unchanged as it bubbles. */
  target: Node
  /** Whose listener is running right now - rewritten at each level. */
  currentTarget: Node
  /** The raw DOM event behind this one, when there is one. */
  evt?: E
  pointerId?: number
  /** Canvas-relative CSS pixels. */
  screen?: Vector2
  /** World space. */
  world?: Vector2
  /** Set true to stop the event travelling any further up the tree. */
  cancelBubble: boolean
  stopPropagation(): void
}

/** Everything fire() accepts to seed an event; anything else given is copied across too. */
export interface NodeEventInit<E = unknown> {
  evt?: E
  pointerId?: number
  screen?: Vector2
  world?: Vector2
  /** Overrides the origin node - defaults to whichever node fire() was called on. */
  target?: Node
  /** Payload specific to the event kind, e.g. `child` on 'add', `oldVal`/`newVal` on a change. */
  [key: string]: unknown
}

export type NodeEventHandler<E = unknown> = (event: NodeEvent<E>) => void

/**
 * Events that fire only on the node itself and never travel upward.
 *
 * enter/leave describe crossing INTO or OUT OF one particular node, so an ancestor that
 * the pointer never left has no business hearing about a move between two of its children.
 * over/out are the bubbling counterparts, and carry that same move to every ancestor.
 */
export const NON_BUBBLING_EVENTS: ReadonlySet<string> = new Set([
  'pointerenter',
  'pointerleave',
  'mouseenter',
  'mouseleave',
  'touchenter',
  'touchleave',
])

export function createNodeEvent<E>(type: string, node: Node, init: NodeEventInit<E> = {}): NodeEvent<E> {
  const event: NodeEvent<E> = {
    type,
    target: node,
    currentTarget: node,
    cancelBubble: false,
    stopPropagation(): void {
      this.cancelBubble = true
    },
  }
  return Object.assign(event, init, { type, target: init.target ?? node, currentTarget: node })
}

/** A shallow copy, so one handler's mutations can't reach another's view of the event. */
export function cloneNodeEvent<E>(event: NodeEvent<E>): NodeEvent<E> {
  return { ...event }
}
