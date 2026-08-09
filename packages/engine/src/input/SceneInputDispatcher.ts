// SceneInputDispatcher - the whole path from a DOM pointer event to something the scene
// can be told about, in one place: it listens on the canvas, tracks the pointers, works out
// which node each event is over, and dispatches scene-graph events on it.
//
// What it does NOT do is decide what any of that means. It reports; an application listens
// and acts. Concretely:
//
//  - press, release, move, the hover crossings, click and double click go out on whichever
//    node the pointer is over, bubbling to the scene root. Empty space, and a node that is
//    not listening, both resolve to the root, so a background handler is root.on('click').
//  - viewport gestures are recognised but never applied. A pan or pinch reports the pointer
//    (or the midpoint of two), the world point that sat under it when the gesture began,
//    and how far a pinch has spread since - everything panToAnchor and a zoom need. The
//    application moves the camera, or does not. Nothing here reads the camera at all; it
//    only asks the host to turn screen coordinates into world ones.
//  - the marquee (`marquee`) is fed from here but never started here. An application calls
//    beginMarquee() when it decides a press means one, and hears 'marqueeend'.
//  - node dragging and the transformer's resize/rotate ARE performed, because they are
//    mechanism rather than policy, and they report as dragstart/dragmove/dragend and
//    transformstart/transform/transformend on every node taking part.
//
// There is no selection here. What is selected is an application's own idea, and often a
// broader one than a frame around some shapes - rows in a panel, a locked layer, a group
// edited together. Where this needs to know which nodes move as a unit, it asks the
// Transformer what it is wrapping (see armDrag), because that set is the one thing it
// genuinely has to know about, and the application decides what goes in it.
//
// A pointer press resolves in priority order: a transformer handle, then a draggable node,
// then empty space. Where the node it lands on sits inside a draggable Group, the group is
// what the drag takes hold of - a group behaves as one object under the pointer, which is
// mechanism, while WHICH node a click selects stays the application's to decide. Gestures
// resolve against the values captured when the press began, never accumulated per move, so
// no gesture can drift over a long drag.
//
// The raw entry points (down/move/up/cancel/leave/wheel/contextMenu) are public. The canvas
// listeners call them, and so can a host driving input from somewhere else - a test, a
// replay, a different event source - without a DOM.

import type { PickableNode } from '../scene/picking'
import type { Node, NodeTransform } from '../shapes/Node'
import type { Shape } from '../shapes/Shape'
import { draggableGroup, type TransformableNode } from '../shapes/Group'
import type { Transformer } from '../shapes/Transformer'
import { Vector2, type Vector2Like } from '../math/Vector2'
import { degToRad, radToDeg } from '../math/angle'
import {
  anchorCursor,
  applyWorldTransform,
  boundBoxToBox,
  boxToBoundBox,
  deltaBetweenBoxes,
  resizeFactors,
  resizedBox,
  rotationDelta,
  type OrientedBox,
  type ResizeAnchor,
  type TransformerAnchor,
} from '../shapes/transformerMath'
import { boundedPosition, draggedPosition } from './nodeDrag'
import { MarqueeTool } from './MarqueeTool'
import { hasListener } from '../events/listenerCensus'
import { deviceFor, eventNamesFor, type PointerAction, type PointerDevice } from '../events/eventNames'
import { hasAnyListener, hasHoverListeners, listenerCount } from '../events/listenerCensus'
import { createNodeEvent, type NodeEventInit } from '../events/NodeEvent'

/** The parts of a raw pointer event this reads. A DOM PointerEvent satisfies it. */
export interface PointerInput {
  pointerId: number
  pointerType: string
}

/** A point in canvas-relative CSS pixels - the units a pointer event arrives in. */
export type ScreenPoint = Vector2Like

export interface SceneInputDispatcherOptions {
  /** Where empty-space events fire and where bubbling ends - normally the scene root. */
  root: Node
  /** The topmost node under a canvas-relative point, or null over empty space. */
  pick: (screenX: number, screenY: number) => PickableNode | null
  /** World position of a canvas-relative point. Without it, nothing that needs world space runs. */
  toWorld?: (screenX: number, screenY: number) => Vector2 | null
  /** The nodes a world rectangle covers - what the marquee resolves through. */
  nodesInBox?: (from: Vector2, to: Vector2) => Shape[]
  /** The transformer whose handles take priority over dragging. */
  transformer?: Transformer
  /** Max total pointer movement (CSS px) for a press to still count as a tap/click. Default 6. */
  tapThreshold?: number
  /** How long two clicks may be apart and still make a double click (ms). Default 400. */
  dblClickWindow?: number
  /** Set false so a one-pointer drag is never a node drag, whatever it presses on. Default true. */
  dragNodes?: boolean
  /**
   * Angles (degrees) a rotate drag settles onto when within `rotationSnapTolerance`.
   *
   * Read only when no `transformer` is given: a frame carries its own snaps, and it is the one
   * an application configures. Pass them to the Transformer instead when there is one.
   */
  rotationSnaps?: readonly number[]
  /** How close (degrees) a rotation must come to a snap to take it. Default 7. See `rotationSnaps`. */
  rotationSnapTolerance?: number
  /** Clock for the double-click window. Defaults to performance.now. */
  now?: () => number
}

/** Which viewport gesture the current pointers add up to. */
type GestureKind = 'none' | 'pan' | 'pinch'

interface TrackedPointer {
  x: number
  y: number
  downX: number
  downY: number
  type: string
}

/** A node's full transform, captured so a gesture can always re-resolve from its start. */
interface NodeSnapshot {
  node: TransformableNode
  transform: NodeTransform
}

/** A one-pointer drag moving nodes. Each keeps its own start position. */
interface NodeDragSession {
  nodes: TransformableNode[]
  startPositions: Vector2Like[]
  anchorWorld: Vector2
  active: boolean
  /**
   * The node the press took hold of - the shape under the pointer, or the group it belongs to.
   * It is what the gesture is ABOUT, so it is the one whose dragDistance decides when the drag
   * starts, even when the transformer's whole selection then travels with it.
   */
  grabbed: TransformableNode
}

/** A drag on a transformer handle: resize (eight anchors) or rotate. */
interface TransformSession {
  anchor: TransformerAnchor
  box: OrientedBox
  startWorld: Vector2
  snapshots: NodeSnapshot[]
}

/** The box as a boundBoxFunc sees it, with the frame's constraint applied if it has one. */
function constrained(transformer: Transformer | undefined, from: OrientedBox, to: OrientedBox): OrientedBox {
  const bound = transformer?.boundBoxFunc
  if (!bound) return to
  return boundBoxToBox(bound(boxToBoundBox(from), boxToBoundBox(to)))
}

/** What a press remembered, so its release can decide whether a click happened. */
interface PressState {
  target: Node
  x: number
  y: number
}

const DEFAULT_TAP_THRESHOLD = 6
const DEFAULT_DBL_CLICK_WINDOW = 400

/** Corner anchors scale both axes at once, so they are the ones keepRatio applies to. */
function isCornerAnchor(anchor: TransformerAnchor): boolean {
  return (
    anchor === 'top-left' || anchor === 'top-right' || anchor === 'bottom-left' || anchor === 'bottom-right'
  )
}

export class SceneInputDispatcher {
  private readonly canvas: HTMLCanvasElement | null
  private readonly root: Node
  private readonly pick: (screenX: number, screenY: number) => PickableNode | null
  private readonly toWorld: (screenX: number, screenY: number) => Vector2 | null
  private readonly transformer?: Transformer
  private readonly tapThreshold: number
  private readonly dblClickWindow: number
  private readonly dragNodes: boolean
  /** Degrees, and only consulted when there is no transformer to ask. See the option. */
  private readonly rotationSnaps?: readonly number[]
  private readonly rotationSnapTolerance?: number
  /**
   * The last snap list converted to radians, kept against the array it came from.
   *
   * The frame's list is live, so it cannot be converted once at construction - but it also
   * almost never changes, and a rotate drag asks for it on every pointer move. Keying the
   * memo on the array's identity means a list that stays put converts exactly once.
   */
  private snapCache: { degrees: readonly number[]; radians: readonly number[] } | null = null
  private readonly now: () => number
  private readonly previousTouchAction: string
  private readonly previousCursor: string

  // Hover, capture and press state - what the event dispatch needs to remember.
  private readonly hoverTargets = new Map<number, Node>()
  private readonly captures = new Map<number, Node>()
  private readonly presses = new Map<number, PressState>()
  private lastClick: { target: Node; time: number } | null = null
  // Pointers that grabbed a transformer handle. They deliver no node-level pointer events
  // at all for the rest of the gesture - see onPointerDown.
  private readonly transformPointers = new Set<number>()

  // Gesture state - what the pointer tracking needs to remember.
  private readonly pointers = new Map<number, TrackedPointer>()
  private gestureKind: GestureKind = 'none'
  private gestureAnchorWorld: Vector2 | null = null
  private gesturePoint: Vector2 | null = null
  private gestureScale = 1
  private gestureStartDistance = 0
  private multiTouch = false
  private panningWithButton = false

  private drag: NodeDragSession | null = null
  private transform: TransformSession | null = null

  /** The rubber-band rectangle. Started by the application, fed from here - see beginMarquee. */
  readonly marquee: MarqueeTool

  /**
   * When false, a press ignores transformer handles and draggable nodes, leaving the drag
   * to be reported as a pan instead. Applications switch this off for a "grab the view"
   * modifier - holding space, a hand tool - which is a binding this has no view on.
   */
  grabContent = true

  /**
   * `canvas` may be null to build one that is driven entirely through the raw entry points,
   * with no DOM listeners of its own.
   */
  constructor(canvas: HTMLCanvasElement | null, options: SceneInputDispatcherOptions) {
    this.canvas = canvas
    this.root = options.root
    this.pick = options.pick
    this.toWorld = options.toWorld ?? (() => null)
    this.transformer = options.transformer
    this.tapThreshold = options.tapThreshold ?? DEFAULT_TAP_THRESHOLD
    this.dblClickWindow = options.dblClickWindow ?? DEFAULT_DBL_CLICK_WINDOW
    this.dragNodes = options.dragNodes ?? true
    this.rotationSnaps = options.rotationSnaps
    this.rotationSnapTolerance = options.rotationSnapTolerance
    this.now = options.now ?? (() => performance.now())
    // So the frame's own stopTransform() can reach the gesture this runs on its behalf.
    this.transformer?.bindGestureHost(this)

    const resolve = options.nodesInBox ?? (() => [])
    this.marquee = new MarqueeTool(options.root, resolve)

    this.previousTouchAction = canvas?.style.touchAction ?? ''
    this.previousCursor = canvas?.style.cursor ?? ''
    if (!canvas) return

    // Stop the browser's native touch scroll/pinch-zoom from competing with our own
    // gesture handling on touch devices.
    canvas.style.touchAction = 'none'
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('contextmenu', this.onContextMenu)
  }

  destroy(): void {
    const canvas = this.canvas
    if (canvas) {
      canvas.removeEventListener('pointerdown', this.onPointerDown)
      canvas.removeEventListener('pointermove', this.onPointerMove)
      canvas.removeEventListener('pointerup', this.onPointerUp)
      canvas.removeEventListener('pointercancel', this.onPointerUp)
      canvas.removeEventListener('pointerleave', this.onPointerLeave)
      canvas.removeEventListener('wheel', this.onWheel)
      canvas.removeEventListener('contextmenu', this.onContextMenu)
      canvas.style.touchAction = this.previousTouchAction
      canvas.style.cursor = this.previousCursor
    }
    this.transformer?.bindGestureHost(null)
    this.pointers.clear()
    this.reset()
    this.marquee.cancel()
    this.drag = null
    this.transform = null
  }

  /** World position of a canvas-relative point, via the projection the host supplied. */
  private worldAt(screenX: number, screenY: number): Vector2 | null {
    return this.toWorld(screenX, screenY)
  }

  private setCursor(cursor: string): void {
    if (this.canvas) this.canvas.style.cursor = cursor
  }

  // --- scene events ---
  //
  // Everything here checks the census first, so a scene listening for none of it pays
  // nothing - which matters for the per-move ones, dragmove and transform.

  /**
   * Raises a drag or transform event on every node taking part, and on the frame when the set
   * is the one it wraps.
   *
   * Both, because the two answer different questions. A listener on a node hears about that
   * node; a listener on the Transformer hears about whatever is currently framed, which is
   * where an application that tracks "the selection" rather than a particular shape puts its
   * handler - and it is where a Konva application already has one.
   *
   * `nodes` carries the whole set on every one of them, so a handler on any single node can
   * see what else moved with it, and `evt` is the pointer event that drove this move.
   */
  private fireOnNodes(type: string, nodes: readonly TransformableNode[], evt?: unknown): void {
    if (nodes.length === 0 || !hasListener(type)) return
    const init = { nodes, evt }
    for (const node of nodes) node.fire(type, init, true)
    if (this.transformer?.has(nodes[0])) this.transformer.fire(type, init, true)
  }

  /** The frame's snap angles in radians, or the dispatcher's own when there is no frame. */
  private snapsInRadians(): readonly number[] | undefined {
    const degrees = this.transformer ? this.transformer.rotationSnaps : this.rotationSnaps
    if (!degrees || degrees.length === 0) return undefined
    if (this.snapCache?.degrees !== degrees) {
      this.snapCache = { degrees, radians: degrees.map(degToRad) }
    }
    return this.snapCache.radians
  }

  private snapToleranceInRadians(): number {
    return degToRad(this.transformer?.rotationSnapTolerance ?? this.rotationSnapTolerance ?? 7)
  }

  /**
   * Whether this pointer's move should skip the hover hit-test entirely.
   *
   * Resolving a hover target means picking, and a pick walks every shape in the scene
   * front-to-back (see scene/picking.ts) - the one genuinely unbounded thing a pointer move
   * can trigger. Measured at 100k shapes it is around a quarter of a second per move, which
   * turns a smooth pan into a slideshow. So it is worth being exact about when nobody could
   * possibly want the answer:
   *
   *   - a TRANSFORMER drag: this pointer belongs to the frame's handle, and what sits under
   *     it in the scene is not what the gesture is about.
   *   - a VIEWPORT pan or pinch: the content is sliding under a stationary pointer. Every
   *     shape it crosses would be reported as hovered on the way past, which is noise even
   *     when it is cheap.
   *   - a MARQUEE: the pointer is pulling out a rectangle. What it sweeps over is answered
   *     once, at the end, by the rectangle itself.
   *   - a NODE DRAG: the dragged node is held under the pointer for the whole gesture (that
   *     is what dragging means here), so a pick returns that same node every time. It could
   *     not report a drop target even in principle - picking answers "what is on top", and
   *     what is on top is the thing being carried.
   *
   * All four are the same condition: a gesture owns this pointer, so nothing is pointing at
   * anything. Hover resumes the moment the button comes back up.
   */
  private hoverIsIdle(pointerId: number): boolean {
    return this.transformPointers.has(pointerId) || this.gestureKind !== 'none' || this.marquee.active
  }

  /** Raises a scene-wide event on the root, which is where such listeners belong. */
  private fireOnRoot(type: string, init: NodeEventInit): void {
    if (!hasListener(type)) return
    this.root.fire(type, init, true)
  }

  private toCanvasPoint(e: PointerEvent | WheelEvent | MouseEvent): Vector2Like {
    const rect = this.canvas?.getBoundingClientRect()
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
  }


  // --- viewport gestures: pan (1 pointer) and pinch (2 pointers) ---
  //
  // Recognised here, applied nowhere. Each reports the pointer (or the midpoint of two),
  // the world point that sat under it when the gesture began, and - for a pinch - how far
  // the two have spread since. That is everything panToAnchor and a zoom need, and it
  // leaves the application to decide whether a given gesture should move the view at all.

  private restartGesture(): void {
    const active = [...this.pointers.values()]
    const next: GestureKind = active.length === 1 ? 'pan' : active.length === 2 ? 'pinch' : 'none'

    if (next !== this.gestureKind && this.gestureKind !== 'none') {
      this.fireGesture(`${this.gestureKind}end`)
    }
    this.gestureKind = next

    if (next === 'pan') {
      this.gestureAnchorWorld = this.worldAt(active[0].x, active[0].y)
      this.gesturePoint = new Vector2(active[0].x, active[0].y)
      this.gestureScale = 1
    } else if (next === 'pinch') {
      const midX = (active[0].x + active[1].x) / 2
      const midY = (active[0].y + active[1].y) / 2
      this.gestureAnchorWorld = this.worldAt(midX, midY)
      this.gesturePoint = new Vector2(midX, midY)
      this.gestureStartDistance = Math.hypot(active[0].x - active[1].x, active[0].y - active[1].y)
      this.gestureScale = 1
    } else {
      this.gestureAnchorWorld = null
      return
    }
    this.fireGesture(`${next}start`)
  }

  private updateGesture(): void {
    if (!this.gestureAnchorWorld) return
    const active = [...this.pointers.values()]

    if (active.length === 1) {
      // Anything that grabbed content moves that content, never the view - including before
      // a drag passes the tap threshold, so nothing can creep under a click.
      if (this.drag || this.transform || this.marquee.active) return
      this.gesturePoint = new Vector2(active[0].x, active[0].y)
      this.gestureScale = 1
      this.fireGesture('panmove')
      return
    }
    if (active.length === 2) {
      const midX = (active[0].x + active[1].x) / 2
      const midY = (active[0].y + active[1].y) / 2
      const distance = Math.hypot(active[0].x - active[1].x, active[0].y - active[1].y)
      this.gesturePoint = new Vector2(midX, midY)
      this.gestureScale = this.gestureStartDistance > 1e-3 ? distance / this.gestureStartDistance : 1
      this.fireGesture('pinchmove')
    }
  }

  private fireGesture(type: string): void {
    if (!this.gestureAnchorWorld || !this.gesturePoint) return
    this.fireOnRoot(type, { point: this.gesturePoint, anchor: this.gestureAnchorWorld, scale: this.gestureScale })
  }

  // --- transformer handles (resize / rotate) ---

  /** The handle under a screen point, with the world point that found it. */
  private anchorUnder(screen: ScreenPoint): { anchor: TransformerAnchor; world: Vector2 } | null {
    if (!this.transformer) return null
    const world = this.worldAt(screen.x, screen.y)
    if (!world) return null
    const anchor = this.transformer.anchorAt(world.x, world.y)
    return anchor ? { anchor, world } : null
  }

  private beginTransform(anchor: TransformerAnchor, world: Vector2, evt?: unknown): void {
    const transformer = this.transformer
    const box = transformer?.currentBox
    if (!transformer || !box) return
    this.transform = {
      anchor,
      box,
      startWorld: world,
      snapshots: transformer.nodes.map((node) => ({ node, transform: node.captureTransform() })),
    }
    transformer.setActiveAnchor(anchor)
    // Turned with the box, so the arrows point along the edge the handle actually moves.
    this.setCursor(anchorCursor(anchor, box.rotation))
    this.fireOnNodes('transformstart', this.transform.snapshots.map((s) => s.node), evt)
  }

  /**
   * Ends a handle gesture where it stands, keeping what it has done. What Transformer's own
   * stopTransform() reaches through to, and the same finish releasing the handle would give.
   */
  stopTransform(): void {
    this.endTransform()
  }

  private updateTransform(world: Vector2, shiftKey: boolean, altKey: boolean, evt?: unknown): void {
    const session = this.transform
    if (!session) return

    // Always rebuild from the transforms captured at press time, so the gesture is a
    // function of pointer position alone and repeated moves cannot compound. This has to
    // put back EVERY transform field: a non-uniform scale on a group whose members
    // are rotated differently (an axis-aligned multi-node box around a turned shape)
    // shears those members, and leaving that shear in place would feed it back into the
    // next move and run away within a few pointer events.
    for (const snap of session.snapshots) {
      snap.node.restoreTransform(snap.transform)
    }

    // Where the drag is READ from, which an anchorDragBoundFunc gets to move - a grid snap, a
    // guide, a clamp to some region. It sees world coordinates and answers in them.
    const bound = this.transformer?.anchorDragBoundFunc
    const at = bound ? bound(session.startWorld, world, evt) : world

    // Every gesture reduces to a box: the one the press started on, and the one the pointer
    // asks for. A boundBoxFunc sits between the two and may hand back a third, so the delta is
    // built from the boxes rather than from the gesture's own factors - whatever it returns is
    // expressible that way.
    let target: OrientedBox
    if (session.anchor === 'rotate') {
      const angle = rotationDelta(
        session.box,
        session.startWorld,
        at,
        this.snapsInRadians(),
        this.snapToleranceInRadians(),
      )
      target = { ...session.box, rotation: session.box.rotation + angle }
    } else {
      // Corners keep their aspect ratio by default - the classic uniform-corner scale. Shift
      // asks for the lock, so with it already configured on, shift changes nothing.
      const corner = isCornerAnchor(session.anchor)
      const transformer = this.transformer
      const keepRatio = corner && ((transformer?.keepRatio ?? true) || shiftKey)
      target = resizedBox(
        session.box,
        resizeFactors(session.box, session.anchor as ResizeAnchor, at, {
          keepRatio,
          centered: (transformer?.centeredScaling ?? false) || altKey,
          flipEnabled: transformer?.flipEnabled ?? true,
        }),
      )
    }

    const finalBox = constrained(this.transformer, session.box, target)
    const delta = deltaBetweenBoxes(session.box, finalBox)
    for (const snap of session.snapshots) {
      applyWorldTransform(snap.node, delta)
    }
    // The frame is re-fitted per frame by its owner, but a multi-node frame has no angle to
    // re-derive from the nodes - it carries its own. Handing the box's angle back is what lets
    // it turn with them. See Transformer.fitRotation.
    if (this.transformer) this.transformer.rotation = radToDeg(finalBox.rotation)

    const nodes = session.snapshots.map((s) => s.node)
    this.fireOnNodes('transform', nodes, evt)
  }

  private endTransform(evt?: unknown): void {
    if (!this.transform) return
    const nodes = this.transform.snapshots.map((s) => s.node)
    this.transform = null
    this.transformer?.setActiveAnchor(null)
    this.setCursor(this.previousCursor)
    this.fireOnNodes('transformend', nodes, evt)
  }

  // --- node dragging ---

  /**
   * Arms a drag over a draggable node, or over the group that node belongs to. `hit` is
   * whatever the press already hit-tested for (see onPointerDown).
   */
  private armDrag(screenX: number, screenY: number, hit: PickableNode | null): boolean {
    if (!hit) return false

    // What the press actually takes hold of. A shape inside a draggable Group is a handle
    // on the GROUP, not on itself - that is what makes a group feel like one object under
    // the pointer, and it is why a shape's own `draggable` is not the whole story: a
    // non-draggable shape in a draggable group still moves the group.
    //
    // Unless the transformer is already wrapping the shape, in which case the application
    // has said that this shape is the thing being worked on, and reaching past it to its
    // group would move things the application did not put in the frame.
    const group = this.transformer?.has(hit) ? null : draggableGroup(hit)
    if (!group && !hit.draggable) return false
    const grabbed: TransformableNode = group ?? hit

    const anchorWorld = this.worldAt(screenX, screenY)
    if (!anchorWorld) return false

    // The transformer's attached set is what "the selection" means here: pressing a node
    // that is in it drags the whole set, pressing one that is not drags only that node.
    // Neither changes the set - an application does that, in response to the press it also
    // heard.
    const nodes = this.transformer?.has(grabbed) ? [...this.transformer.nodes] : [grabbed]

    this.drag = {
      nodes,
      startPositions: nodes.map((node) => ({ x: node.x, y: node.y })),
      anchorWorld,
      active: false,
      grabbed,
    }
    return true
  }

  private updateDrag(pointer: TrackedPointer, evt?: unknown): void {
    const drag = this.drag
    if (!drag) return

    if (!drag.active) {
      const moved = Math.hypot(pointer.x - pointer.downX, pointer.y - pointer.downY)
      // The grabbed node may set its own distance; the dispatcher's threshold is the default
      // for everything that does not. See Node.dragDistance.
      if (moved <= (drag.grabbed.dragDistance ?? this.tapThreshold)) return
      drag.active = true
      this.setCursor('grabbing')
      this.fireOnNodes('dragstart', drag.nodes, evt)
    }

    const world = this.worldAt(pointer.x, pointer.y)
    if (!world) return
    drag.nodes.forEach((node, i) => {
      const start = drag.startPositions[i]
      const next = boundedPosition(node, draggedPosition(node, start.x, start.y, drag.anchorWorld, world))
      node.x = next.x
      node.y = next.y
    })
    // No markGeometryDirty(): x/y are transform-only, applied per frame from the object's
    // world matrix, so a drag never rebuilds geometry however far the nodes travel.
    this.fireOnNodes('dragmove', drag.nodes, evt)
  }

  /** Ends the drag, optionally snapping the nodes back to where the drag started. */
  private endDrag(revert: boolean, evt?: unknown): void {
    const drag = this.drag
    if (!drag) return
    this.drag = null
    this.setCursor(this.previousCursor)
    if (!drag.active) return
    if (revert) {
      drag.nodes.forEach((node, i) => {
        node.x = drag.startPositions[i].x
        node.y = drag.startPositions[i].y
      })
    }
    this.fireOnNodes('dragend', drag.nodes, evt)
  }

  // --- marquee ---
  //
  // The rectangle itself lives in MarqueeTool; this only feeds it while it is active. It is
  // never started from here: an application calls beginMarquee() when it decides a marquee
  // is what the press means, and listens for 'marqueeend' to decide what the result is for.

  /**
   * Starts pulling a rectangle out from a world point. Later moves and the release are fed
   * to it automatically until it finishes. A pointer event's `world` field is the usual
   * source for the argument.
   */
  beginMarquee(world: Vector2): void {
    this.marquee.begin(world)
  }

  private updateMarquee(pointer: TrackedPointer): void {
    const world = this.worldAt(pointer.x, pointer.y)
    if (world) this.marquee.update(world)
  }

  // --- pointer plumbing ---

  private onPointerDown = (e: PointerEvent): void => {
    const point = this.toCanvasPoint(e)

    // A press on a transformer handle is a press on the TRANSFORMER, not on whatever the
    // handle is drawn over, so it is resolved before anything is dispatched.
    //
    // Reporting the shape behind the handle as pressed is not merely extra information: an
    // application that selects on press - the ordinary arrangement - would swap the
    // selection out from under the gesture being started, and the handle would then
    // transform the shape behind it. Worse, the frame is refit once a frame rather than on
    // attach, so the new node would be transformed about the OLD selection's centre.
    //
    // Cheap to test first: anchorAt() measures against the handles, not the scene, and this
    // is also the one press that then needs no hit-test at all.
    const anchor =
      e.button === 0 && this.grabContent && this.pointers.size === 0 ? this.anchorUnder(point) : null
    if (anchor) {
      this.transformPointers.add(e.pointerId)
      this.canvas?.setPointerCapture(e.pointerId)
      this.pointers.set(e.pointerId, { x: point.x, y: point.y, downX: point.x, downY: point.y, type: e.pointerType })
      this.beginTransform(anchor.anchor, anchor.world, e)
      this.restartGesture()
      e.preventDefault()
      return
    }

    // Events report what the pointer did and go out before any of the gesture branching
    // below decides what to do about it, so the stream a listener sees is the same however
    // the press is subsequently interpreted. The one hit-test serves both this and the drag
    // arming further down - there is no reason to pay for it twice.
    const hit = this.pick(point.x, point.y)
    this.down(e, point, hit)

    // The middle button is tracked but never grabs content, so its drag always reports as
    // a pan - the one press whose meaning is fixed here, since there is nothing under it
    // to grab in the first place.
    if (e.button === 1) {
      this.panningWithButton = true
      this.canvas?.setPointerCapture(e.pointerId)
      this.pointers.set(e.pointerId, { x: point.x, y: point.y, downX: point.x, downY: point.y, type: e.pointerType })
      this.restartGesture()
      e.preventDefault()
      return
    }
    if (e.button !== 0) return

    const p = point
    this.canvas?.setPointerCapture(e.pointerId)
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, downX: p.x, downY: p.y, type: e.pointerType })

    if (this.pointers.size >= 2) {
      this.multiTouch = true
      // A second finger means a pinch. Put anything mid-gesture back, so content grabbed
      // on the way into a two-finger gesture is not left moved by it.
      this.endDrag(true, e)
      this.endTransform(e)
      this.marquee.cancel()
      this.restartGesture()
      e.preventDefault()
      return
    }

    const world = this.worldAt(p.x, p.y)

    // Handles were resolved at the top of this method, before anything was dispatched.
    if (this.grabContent && world) {
      if (this.dragNodes && this.armDrag(p.x, p.y, hit)) {
        this.restartGesture()
        this.suppressDefault(e, hit)
        return
      }
    }

    this.restartGesture()
    this.suppressDefault(e, hit)
  }

  /**
   * Suppresses the browser's own response to a press - text selection, a scroll, a native image
   * drag - unless the node under the pointer asked to keep it (see Node.preventDefault). Empty
   * space answers like a node that did not ask.
   *
   * Only the presses a NODE is the subject of come through here. The canvas's own gestures - a
   * transformer handle, a middle-button pan, a pinch, the wheel, the context menu - suppress
   * unconditionally, since there is nothing under them whose opinion it would be.
   */
  private suppressDefault(e: PointerEvent, hit: Node | null): void {
    if (hit?.preventDefault ?? true) e.preventDefault()
  }

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.toCanvasPoint(e)
    // Dispatched before the tracked-pointer check below, because hovering happens with no
    // button held and so has no tracked pointer at all. Costs nothing when nothing is
    // listening for a hover event - the dispatcher never hit-tests in that case.
    this.move(e, p)

    const pointer = this.pointers.get(e.pointerId)
    if (!pointer) return
    pointer.x = p.x
    pointer.y = p.y

    if (this.transform) {
      const world = this.worldAt(p.x, p.y)
      if (world) this.updateTransform(world, e.shiftKey, e.altKey, e)
      return
    }
    if (this.drag) {
      this.updateDrag(pointer, e)
      return
    }
    if (this.marquee.active) {
      this.updateMarquee(pointer)
      return
    }
    this.updateGesture()
  }

  // Bound to both pointerup and pointercancel; the raw event's type tells them apart.
  private onPointerUp = (e: PointerEvent): void => {
    const point = this.toCanvasPoint(e)
    if (e.type === 'pointercancel') this.cancel(e, point)
    else this.up(e, point)

    const pointer = this.pointers.get(e.pointerId)
    if (!pointer) return
    this.pointers.delete(e.pointerId)
    if (this.canvas?.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)

    if (e.button === 1 || this.panningWithButton) {
      this.panningWithButton = false
      if (this.pointers.size === 0) this.restartGesture()
      return
    }

    if (this.pointers.size === 0) {
      const moved = Math.hypot(pointer.x - pointer.downX, pointer.y - pointer.downY)
      const hadMarquee = this.marquee.active
      // The dispatcher's own threshold, never a node's dragDistance: this asks whether the
      // press was a CLICK, which is a question about the gesture rather than about whatever it
      // landed on, and a node that is hard to start dragging is not thereby hard to click.
      const wasTap = !this.multiTouch && moved <= this.tapThreshold

      this.endTransform(e)
      this.endDrag(false, e)

      // A press that never travelled dragged out no area, so there is nothing to resolve -
      // but it still ends, so a listener sees one end per start either way.
      if (hadMarquee) {
        if (wasTap) this.marquee.cancel()
        else this.marquee.end()
      }

      this.multiTouch = false
    }

    // Re-reads whatever pointers are left, which announces the end of the gesture the
    // released one was part of - including the last one, where there is nothing left to
    // start in its place.
    this.restartGesture()
  }

  // The pointer left the canvas, so it is no longer over whatever it was over. Not reached
  // mid-drag: the canvas holds the pointer capture until the button comes up.
  private onPointerLeave = (e: PointerEvent): void => {
    this.leave(e, this.toCanvasPoint(e))
  }

  // Middle-click pastes on some platforms and opens a menu on others; the canvas owns it.
  private onContextMenu = (e: Event): void => {
    e.preventDefault()
    if (e instanceof MouseEvent) {
      this.contextMenu({ pointerId: -1, pointerType: 'mouse' }, this.toCanvasPoint(e), e)
    }
  }

  // The wheel is reported, not acted on - see the viewport-gesture section above. The
  // default is still suppressed, because a canvas that scrolls the page under a zoom
  // gesture is never what was wanted.
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    this.wheel({ pointerId: -1, pointerType: 'mouse' }, this.toCanvasPoint(e), e)
  }

  // --- raw input ---

  /**
   * A press. `hit` is the node under the pointer, passed in because the gesture handling
   * below has usually just hit-tested for it and there is no reason to pay for that twice.
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

  /**
   * A move. Costs nothing at all unless something is listening for a hover-class event -
   * and nothing even then while a gesture is driving the view or a tool, because working
   * out what is under the pointer means hit-testing the whole scene (see the note below).
   */
  move(input: PointerInput, screen: ScreenPoint): void {
    if (this.hoverIsIdle(input.pointerId)) return
    if (!hasHoverListeners()) return
    const device = deviceFor(input.pointerType)
    const target = this.captures.get(input.pointerId) ?? this.effectiveTarget(this.pick(screen.x, screen.y))
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
    // A pointer that grabbed a handle never delivered a press, so it has no release and no
    // click to resolve either - releasing a handle is not a click on the shape behind it.
    if (this.transformPointers.delete(input.pointerId)) return
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
    if (this.transformPointers.delete(input.pointerId)) return
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
    this.dispatchReported('wheel', screen, { ...this.initFor(input, screen), evt: raw })
  }

  contextMenu(input: PointerInput, screen: ScreenPoint, raw?: unknown): void {
    this.dispatchReported('contextmenu', screen, { ...this.initFor(input, screen), evt: raw })
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
    this.transformPointers.clear()
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
    return this.effectiveTarget(this.pick(screen.x, screen.y))
  }

  /**
   * Whether the ONLY listeners for a type are on the root - in which case the hit-test that
   * would name the target cannot change who hears the event, because everything bubbles to
   * the root anyway.
   *
   * The census's tally is global and reads high rather than low (a node dropped while still
   * holding listeners leaves its count behind), so a wrong answer here is always "no", and a
   * wrong "no" costs a hit-test that turns out not to have been needed. Nothing is ever
   * skipped that should have run.
   */
  private onlyRootListens(name: string): boolean {
    return listenerCount(name) === this.root.ownListenerCount(name)
  }

  /**
   * Dispatch for an event that is REPORTED rather than acted on - wheel and contextmenu,
   * which the dispatcher forwards and takes no gesture from.
   *
   * These are the two dispatches where naming the target is usually pure cost. A wheel
   * handler on the root - the ordinary way to drive camera zoom - reads the delta and the
   * screen point and never asks what it was over; naming it means hit-testing the scene,
   * front to back, on every wheel event, which at a hundred thousand shapes is the whole
   * frame. And a listener on the ROOT would receive the event whatever was under the cursor,
   * so the answer cannot change who gets called - only what `event.target` says.
   *
   * So when nothing below the root is listening, the event is fired from the root with the
   * target left as a thunk (see NodeEventInit.targetResolver): a handler that reads
   * `event.target` gets exactly what it always got, and one that does not pays nothing. With
   * a listener further down the tree the path genuinely depends on the hit, and this is the
   * eager dispatch it has always been.
   */
  private dispatchReported(name: string, screen: ScreenPoint, init: NodeEventInit): void {
    if (!hasAnyListener([name])) return
    if (this.onlyRootListens(name)) {
      this.dispatchNamed(name, this.root, {
        ...init,
        targetResolver: () => this.effectiveTarget(this.pick(screen.x, screen.y)),
      })
      return
    }
    this.dispatchNamed(name, this.hitTarget(screen, [name]), init)
  }

  /** What a release landed on - worth hit-testing for only if a release or click is wanted. */
  private pickForRelease(input: PointerInput, device: PointerDevice, screen: ScreenPoint): Node | null {
    const wanted = hasAnyListener(eventNamesFor('pointerup', device))
      ? true
      : this.presses.has(input.pointerId) &&
        (hasAnyListener(eventNamesFor('pointerclick', device)) ||
          hasAnyListener(eventNamesFor('pointerdblclick', device)))
    return wanted ? this.pick(screen.x, screen.y) : null
  }

  private initFor(input: PointerInput, screen: ScreenPoint): NodeEventInit {
    return {
      evt: input,
      pointerId: input.pointerId,
      screen: new Vector2(screen.x, screen.y),
      world: this.worldAt(screen.x, screen.y) ?? undefined,
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
    if (Math.hypot(screen.x - press.x, screen.y - press.y) > this.tapThreshold) return

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

/** Re-exported so hosts can type a picked node without reaching into scene/picking. */
export type { PickableNode }
