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
  /**
   * A `target` to work out only if somebody asks for it.
   *
   * For a dispatch where finding the origin node is expensive and usually unwanted: a wheel
   * over a hundred thousand shapes has to hit-test all of them to name what it was over, and
   * a handler that only wants the scroll delta never looks. Supplied instead of `target`, the
   * event exposes `target` as a getter that runs this on first read and remembers the answer.
   *
   * Only sound when the dispatch PATH does not depend on the answer - i.e. the event is fired
   * from a node that would receive it whatever was hit. See SceneInputDispatcher.
   */
  targetResolver?: () => Node
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
  const { targetResolver, ...rest } = init
  Object.assign(event, rest, { type, target: init.target ?? node, currentTarget: node })

  // A deferred origin - see NodeEventInit.targetResolver. Defined over the plain value
  // assigned above, and only when no explicit target was given, so an event that names its
  // own origin keeps naming it.
  if (targetResolver && init.target === undefined) {
    let resolved: Node | null = null
    Object.defineProperty(event, 'target', {
      configurable: true,
      enumerable: true,
      get: () => (resolved ??= targetResolver()),
      // Assignable, because the property it replaces was: nothing in the engine writes to
      // target, but an event object is handed to application code and should not start
      // throwing on a write that used to work.
      set: (value: Node) => {
        resolved = value
      },
    })
  }
  return event
}

/** A shallow copy, so one handler's mutations can't reach another's view of the event. */
export function cloneNodeEvent<E>(event: NodeEvent<E>): NodeEvent<E> {
  return { ...event }
}
