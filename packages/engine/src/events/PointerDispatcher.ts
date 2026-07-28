// Turns raw pointer input into scene-graph events: works out which node the pointer is
// over, tracks what it was over before, and fires the resulting press/move/release,
// hover-crossing and click events on that node with bubbling.
//
// It holds no gesture state and makes no decisions about what input MEANS - dragging,
// marquee selection, panning and the transformer all stay in SceneInputController, which
// owns this and feeds it. The split is deliberate: this reports what the pointer did,
// the controller decides what the application does about it.
//
// Empty space is not nothing: press, move, release and click over it fire on the scene
// root, which is also where every bubbling event ends up, so a background handler is just
// root.on('click', ...). The hover-crossing events are the exception - entering or leaving
// requires something to enter or leave, so moving onto empty space only fires the leaving
// half, which then bubbles up to the root anyway.
//
// Cost: delivering a hover event needs a hit-test on every pointer move, so the whole
// hover path is skipped unless the census says something is actually listening for one (see
// listenerCensus). A scene with no hover handler does exactly the hit-testing it did before
// this existed, which is none.

import { Vector2 } from '../math/Vector2'
import type { Node } from '../shapes/Node'
import { deviceFor, eventNamesFor, type PointerAction, type PointerDevice } from './eventNames'
import { hasAnyListener, hasHoverListeners } from './listenerCensus'
import { createNodeEvent, type NodeEventInit } from './NodeEvent'

/** The parts of a raw pointer event this reads. A DOM PointerEvent satisfies it. */
export interface PointerInput {
  pointerId: number
  pointerType: string
}

/** A point in canvas-relative CSS pixels. */
export interface ScreenPoint {
  x: number
  y: number
}

export interface PointerDispatcherOptions {
  /** Where empty-space events fire and where bubbling ends - normally the scene root. */
  root: Node
  /**
   * The topmost node under a canvas-relative point, or null over empty space. Only called
   * when something is listening for what the answer would feed.
   */
  pick: (screenX: number, screenY: number) => Node | null
  /** World-space position of a canvas-relative point, for the event's `world` field. */
  toWorld?: (screenX: number, screenY: number) => Vector2 | null
  /** How far a pointer may travel between press and release and still count as a click (CSS px). Default 6. */
  clickThreshold?: number
  /** How long two clicks may be apart and still count as a double click (ms). Default 400. */
  dblClickWindow?: number
  /** Clock for the double-click window. Defaults to performance.now. */
  now?: () => number
}

/** What a press remembered, so its release can decide whether a click happened. */
interface PressState {
  target: Node
  x: number
  y: number
}

const DEFAULT_CLICK_THRESHOLD = 6
const DEFAULT_DBL_CLICK_WINDOW = 400

export class PointerDispatcher {
  private readonly root: Node
  private readonly pickNode: (screenX: number, screenY: number) => Node | null
  private readonly toWorld: (screenX: number, screenY: number) => Vector2 | null
  private readonly clickThreshold: number
  private readonly dblClickWindow: number
  private readonly now: () => number

  private readonly hoverTargets = new Map<number, Node>()
  private readonly captures = new Map<number, Node>()
  private readonly presses = new Map<number, PressState>()
  private lastClick: { target: Node; time: number } | null = null

  constructor(options: PointerDispatcherOptions) {
    this.root = options.root
    this.pickNode = options.pick
    this.toWorld = options.toWorld ?? (() => null)
    this.clickThreshold = options.clickThreshold ?? DEFAULT_CLICK_THRESHOLD
    this.dblClickWindow = options.dblClickWindow ?? DEFAULT_DBL_CLICK_WINDOW
    this.now = options.now ?? (() => performance.now())
  }

  // --- raw input ---

  /**
   * A press. `hit` is the node under the pointer, which the caller supplies because it has
   * usually just hit-tested for its own gesture handling and there is no reason to pay for
   * that twice.
   */
  down(input: PointerInput, screen: ScreenPoint, hit: Node | null): void {
    const device = deviceFor(input.pointerType)
    const target = this.effectiveTarget(hit)
    const init = this.initFor(input, screen)

    // A finger has no hover before it lands, so the press is also the crossing.
    this.updateHover(input.pointerId, device, target, init)

    this.presses.set(input.pointerId, { target, x: screen.x, y: screen.y })
    this.dispatch('pointerdown', device, target, init)
  }

  /** A move. Costs nothing at all unless something is listening for a hover-class event. */
  move(input: PointerInput, screen: ScreenPoint): void {
    if (!hasHoverListeners()) return
    const device = deviceFor(input.pointerType)
    const target = this.captures.get(input.pointerId) ?? this.effectiveTarget(this.pickNode(screen.x, screen.y))
    const init = this.initFor(input, screen)

    this.updateHover(input.pointerId, device, target, init)
    this.dispatch('pointermove', device, target, init)
  }

  /**
   * A release, which is also where a click or double click is decided.
   *
   * Unlike down(), this hit-tests for itself: the controller's gesture handling has no use
   * for what is under a release, so there is no result to share, and the test is skipped
   * entirely unless a release or click listener exists to receive the outcome.
   */
  up(input: PointerInput, screen: ScreenPoint): void {
    const device = deviceFor(input.pointerType)
    const init = this.initFor(input, screen)
    const target = this.captures.get(input.pointerId) ?? this.effectiveTarget(this.pickForRelease(input, device, screen))

    this.dispatch('pointerup', device, target, init)

    const press = this.presses.get(input.pointerId)
    this.presses.delete(input.pointerId)
    if (press) this.resolveClick(press, target, device, screen, init)

    this.releaseCapture(input.pointerId)
  }

  /** The gesture was taken away - by the browser, or by a second finger arriving. No click. */
  cancel(input: PointerInput, screen: ScreenPoint): void {
    const device = deviceFor(input.pointerType)
    const target = this.captures.get(input.pointerId) ?? this.root
    const init = this.initFor(input, screen)

    this.dispatch('pointercancel', device, target, init)
    this.presses.delete(input.pointerId)
    this.updateHover(input.pointerId, device, this.root, init)
    this.releaseCapture(input.pointerId)
  }

  /** The pointer left the canvas, so whatever it was over, it no longer is. */
  leave(input: PointerInput, screen: ScreenPoint): void {
    const device = deviceFor(input.pointerType)
    this.updateHover(input.pointerId, device, this.root, this.initFor(input, screen))
  }

  wheel(input: PointerInput, screen: ScreenPoint, raw?: unknown): void {
    this.dispatchNamed('wheel', this.hitTarget(screen, ['wheel']), { ...this.initFor(input, screen), evt: raw })
  }

  contextMenu(input: PointerInput, screen: ScreenPoint, raw?: unknown): void {
    this.dispatchNamed('contextmenu', this.hitTarget(screen, ['contextmenu']), {
      ...this.initFor(input, screen),
      evt: raw,
    })
  }

  // --- pointer capture ---

  /**
   * Routes this pointer's later moves and its release to `node` whatever they pass over,
   * so a node that was grabbed keeps hearing about the pointer that grabbed it. Released
   * automatically when the pointer comes up or is cancelled.
   */
  setPointerCapture(pointerId: number, node: Node): void {
    this.releaseCapture(pointerId)
    this.captures.set(pointerId, node)
    node.fire('gotpointercapture', { pointerId }, true)
  }

  releaseCapture(pointerId: number): void {
    const node = this.captures.get(pointerId)
    if (!node) return
    this.captures.delete(pointerId)
    node.fire('lostpointercapture', { pointerId }, true)
  }

  getCapture(pointerId: number): Node | null {
    return this.captures.get(pointerId) ?? null
  }

  /** The node this pointer is currently over, or null if it is over empty space. */
  getHoverTarget(pointerId: number): Node | null {
    const target = this.hoverTargets.get(pointerId) ?? null
    return target === this.root ? null : target
  }

  /** Drops all hover, press and capture state without firing anything. */
  reset(): void {
    this.hoverTargets.clear()
    this.captures.clear()
    this.presses.clear()
    this.lastClick = null
  }

  // --- internals ---

  /**
   * A node that is not listening is treated exactly as empty space: the event goes to the
   * root instead, rather than vanishing because it landed on something deaf.
   */
  private effectiveTarget(hit: Node | null): Node {
    return hit !== null && hit.isListening() ? hit : this.root
  }

  private hitTarget(screen: ScreenPoint, names: readonly string[]): Node {
    if (!hasAnyListener(names)) return this.root
    return this.effectiveTarget(this.pickNode(screen.x, screen.y))
  }

  /** What a release landed on - worth hit-testing for only if a release or click is wanted. */
  private pickForRelease(input: PointerInput, device: PointerDevice, screen: ScreenPoint): Node | null {
    const wanted = hasAnyListener(eventNamesFor('pointerup', device))
      ? true
      : this.presses.has(input.pointerId) &&
        (hasAnyListener(eventNamesFor('pointerclick', device)) ||
          hasAnyListener(eventNamesFor('pointerdblclick', device)))
    return wanted ? this.pickNode(screen.x, screen.y) : null
  }

  private initFor(input: PointerInput, screen: ScreenPoint): NodeEventInit {
    return {
      evt: input,
      pointerId: input.pointerId,
      screen: new Vector2(screen.x, screen.y),
      world: this.toWorld(screen.x, screen.y) ?? undefined,
    }
  }

  /**
   * Fires the out/leave then over/enter pair when the pointer crosses from one node to
   * another, in that order, and remembers where it now is. Each half is bounded by the
   * other node, so a move between two children of one parent is not reported to that parent
   * as leaving and re-entering it (see Node.fire's `boundary`).
   *
   * Over empty space the target is the root, which fires neither half itself - there is
   * nothing to enter - but does receive the leaving half bubbling up from the node vacated.
   */
  private updateHover(pointerId: number, device: PointerDevice, target: Node, init: NodeEventInit): void {
    const previous = this.hoverTargets.get(pointerId) ?? this.root
    if (previous === target) return
    this.hoverTargets.set(pointerId, target)

    if (previous !== this.root) {
      this.dispatch('pointerout', device, previous, init, target)
      this.dispatch('pointerleave', device, previous, init, target)
    }
    if (target !== this.root) {
      this.dispatch('pointerover', device, target, init, previous)
      this.dispatch('pointerenter', device, target, init, previous)
    }
  }

  /**
   * A click is a press and a release on the same node without the pointer wandering far
   * enough in between to have meant a drag. A second one on that same node inside the
   * double-click window makes a double click, after which the count starts over, so three
   * clicks are not two doubles.
   */
  private resolveClick(
    press: PressState,
    target: Node,
    device: PointerDevice,
    screen: ScreenPoint,
    init: NodeEventInit,
  ): void {
    if (press.target !== target) return
    if (Math.hypot(screen.x - press.x, screen.y - press.y) > this.clickThreshold) return

    this.dispatch('pointerclick', device, target, init)

    const time = this.now()
    const last = this.lastClick
    if (last && last.target === target && time - last.time <= this.dblClickWindow) {
      this.dispatch('pointerdblclick', device, target, init)
      this.lastClick = null
    } else {
      this.lastClick = { target, time }
    }
  }

  /**
   * Fires one action under both of its names - the canonical pointer one and the alias for
   * the device that produced it. Both names share ONE event object, so a handler that stops
   * propagation on either stops it for both (see Node.dispatchEvent), and so a dispatch
   * nothing is listening for allocates nothing at all.
   */
  private dispatch(
    action: PointerAction,
    device: PointerDevice,
    target: Node,
    init: NodeEventInit,
    boundary?: Node,
  ): void {
    const names = eventNamesFor(action, device)
    if (!hasAnyListener(names)) return
    const event = createNodeEvent(names[0], target, init)
    for (const name of names) {
      event.type = name
      target.dispatchEvent(event, true, boundary)
    }
  }

  /** Fires a type that has no device variants. */
  private dispatchNamed(name: string, target: Node, init: NodeEventInit): void {
    if (!hasAnyListener([name])) return
    target.fire(name, init, true)
  }
}
