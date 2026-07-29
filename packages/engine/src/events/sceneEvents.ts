// The events the scene raises about itself, rather than about a pointer: a node being
// dragged or transformed, an attribute changing, a child joining or leaving a container,
// and the marquee rectangle or the viewport moving.
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

/**
 * Fired on a Transformer when the set of nodes it is wrapping changes. There is no
 * selection event to go with it: what is selected is the application's own notion, and only
 * the application knows when that has changed.
 */
export interface AttachChangeEvent extends NodeEvent {
  nodes: readonly Node[]
}

/** Fired on a container when a child joins or leaves it. */
export interface ChildEvent extends NodeEvent {
  child: Node
}

/**
 * Fired on the scene root as a marquee rectangle is pulled out. `from` and `to` are its
 * opposite corners in world space; on 'marqueeend' `nodes` is what the finished rectangle
 * covered, which is empty when the gesture was abandoned rather than completed. What
 * covering a node means is the application's to decide - see MarqueeTool.
 */
export interface MarqueeEvent extends NodeEvent {
  from: Vector2
  to: Vector2
  nodes?: readonly Node[]
}

/**
 * Fired on the scene root while a viewport gesture is under way - one pointer dragging
 * (pan) or two spreading and moving together (pinch). The engine recognises these and
 * reports them; it does not move the camera, because where a gesture should take the view -
 * or whether it should move it at all - is the application's to decide. Feed `screen` and
 * `anchor` to panToAnchor, and `scale` to whatever zoom the application keeps.
 */
export interface CameraGestureEvent extends NodeEvent {
  /** Canvas-relative CSS pixels: the pointer, or the midpoint between two of them. */
  point: Vector2
  /** The world point that sat under `point` when the gesture began, and should again. */
  anchor: Vector2
  /** Pinch only: the pointers' current separation over their separation at the start. 1 on a pan. */
  scale: number
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
  'attachchange',
  'marqueestart',
  'marqueemove',
  'marqueeend',
  'panstart',
  'panmove',
  'panend',
  'pinchstart',
  'pinchmove',
  'pinchend',
] as const

export type SceneEventName = (typeof SCENE_EVENTS)[number]

/** The event type an attribute's changes are reported under. */
export function attrChangeEventName(attr: string): string {
  return `${attr}Change`
}
