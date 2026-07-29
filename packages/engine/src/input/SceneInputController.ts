// SceneInputController - wires a canvas to the Pointer Events API (one code path for
// mouse, touch and pen) plus the wheel, and drives node dragging and the Transformer
// through a SceneRendererHandle. It owns no rendering state of its own.
//
// A pointer press resolves in priority order: a transformer handle, then a draggable node,
// then empty space. What any of it MEANS is not decided here - the press is reported, and
// anything an application wants from it (pulling out a marquee, changing what is selected,
// moving the view) is that application's to arrange, from the events below.
//
// There is no selection here. What is selected is an application's own idea, and often a
// broader one than a frame around some shapes - rows in a panel, a locked layer, a group
// edited together. Where this needs to know which nodes move as a unit, it asks the
// Transformer what it is wrapping (see armDrag), because that set is the one thing the
// engine genuinely does have to know about, and the application decides what goes in it.
//
// Gestures resolve against the values captured when the press began, never accumulated
// per move, so no gesture can drift over a long drag.
//
// It feeds a PointerDispatcher (`events`), which turns the same raw input into scene-graph
// events on whichever node the pointer is over - press, release, move, the hover crossings,
// click and double click. Those go out before any of the gesture branching here, so what a
// listener sees does not depend on how a press is subsequently interpreted.
//
// The gestures themselves report as scene events (see events/sceneEvents):
// dragstart/dragmove/dragend and transformstart/transform/transformend on each node taking
// part, and marqueestart/marqueemove/marqueeend plus panstart/panmove/panend and
// pinchstart/pinchmove/pinchend on the scene root. A press that should change what is
// selected is heard through the ordinary pointer events, on whichever node it landed.
//
// Two things are deliberately provided rather than performed:
//
//  - the marquee (`marquee`, a MarqueeTool) is fed from here but never started here; an
//    application calls beginMarquee() when it decides a press means one.
//  - viewport gestures are recognised but never applied. A pan or pinch reports the pointer,
//    the world point that was under it, and how far a pinch has spread - everything
//    panToAnchor and a zoom need - and the application moves the camera, or does not.
//    Nothing here reads or writes the camera except to turn screen coordinates into world
//    ones, so keyboard bindings, zoom limits and what a wheel notch is worth all belong to
//    whoever is driving.

import type { SceneRendererHandle } from '../webgpu/SceneRenderer'
import type { PickableNode } from '../scene/picking'
import type { Shape, ShapeTransform } from '../shapes/Shape'
import type { Transformer } from '../shapes/Transformer'
import { Vector2 } from '../math/Vector2'
import {
  applyWorldTransform,
  resizeFactors,
  rotateAbout,
  rotationDelta,
  scaleAbout,
  type OrientedBox,
  type ResizeAnchor,
  type TransformerAnchor,
} from '../shapes/transformerMath'
import { screenToWorld, type Viewport } from './viewport'
import { draggedPosition } from './nodeDrag'
import { PointerDispatcher } from '../events/PointerDispatcher'
import { MarqueeTool } from './MarqueeTool'
import { hasListener } from '../events/listenerCensus'
import type { NodeEventInit } from '../events/NodeEvent'

export interface SceneInputControllerOptions {
  /** Max total pointer movement (CSS px) for a gesture to still count as a tap/click. Default 6. */
  tapThreshold?: number
  /** The transformer whose handles take priority over dragging/selecting. */
  transformer?: Transformer
  /** Set false so a one-pointer drag is never a node drag, whatever it presses on. Default true. */
  dragNodes?: boolean
  /** Called when a node drag begins (after the tap threshold is passed), ends, or moves. */
  onDragStart?: (nodes: readonly Shape[]) => void
  onDrag?: (nodes: readonly Shape[]) => void
  onDragEnd?: (nodes: readonly Shape[]) => void
  /** Angles (radians) a rotate drag settles onto when within `rotationSnapTolerance`. */
  rotationSnaps?: readonly number[]
  /** How close (radians) a rotation must come to a snap to take it. Default 0.12 (~7 degrees). */
  rotationSnapTolerance?: number
  /** How long two clicks may be apart and still make a double click (ms). Default 400. */
  dblClickWindow?: number
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
  node: Shape
  transform: ShapeTransform
}

/** A one-pointer drag moving nodes. Each keeps its own start position. */
interface NodeDragSession {
  nodes: Shape[]
  startPositions: { x: number; y: number }[]
  anchorWorld: Vector2
  active: boolean
}

/** A drag on a transformer handle: resize (eight anchors) or rotate. */
interface TransformSession {
  anchor: TransformerAnchor
  box: OrientedBox
  startWorld: Vector2
  snapshots: NodeSnapshot[]
}

const DEFAULT_TAP_THRESHOLD = 6

/** Corner anchors scale both axes at once, so they are the ones keepRatio applies to. */
function isCornerAnchor(anchor: TransformerAnchor): boolean {
  return (
    anchor === 'top-left' || anchor === 'top-right' || anchor === 'bottom-left' || anchor === 'bottom-right'
  )
}

export class SceneInputController {
  private readonly canvas: HTMLCanvasElement
  private readonly handle: SceneRendererHandle
  private readonly tapThreshold: number
  private readonly rotationSnaps?: readonly number[]
  private readonly rotationSnapTolerance: number
  private readonly transformer?: Transformer
  private readonly dragNodes: boolean
  private readonly onDragStart: (nodes: readonly Shape[]) => void
  private readonly onDrag: (nodes: readonly Shape[]) => void
  private readonly onDragEnd: (nodes: readonly Shape[]) => void
  private readonly previousTouchAction: string
  private readonly previousCursor: string
  /** Turns raw pointer input into scene-graph events. Owns no gesture state. */
  readonly events: PointerDispatcher

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
   * modifier - holding space, a hand tool - which is a binding the engine has no view on.
   */
  grabContent = true


  constructor(canvas: HTMLCanvasElement, handle: SceneRendererHandle, options: SceneInputControllerOptions = {}) {
    this.canvas = canvas
    this.handle = handle
    this.tapThreshold = options.tapThreshold ?? DEFAULT_TAP_THRESHOLD
    this.rotationSnaps = options.rotationSnaps
    this.rotationSnapTolerance = options.rotationSnapTolerance ?? 0.12
    this.transformer = options.transformer
    this.dragNodes = options.dragNodes ?? true
    this.onDragStart = options.onDragStart ?? (() => {})
    this.onDrag = options.onDrag ?? (() => {})
    this.onDragEnd = options.onDragEnd ?? (() => {})

    this.marquee = new MarqueeTool(handle.scene.root, (from, to) => handle.nodesInBox(from, to))

    this.events = new PointerDispatcher({
      root: handle.scene.root,
      pick: (x, y) => handle.pick(x, y),
      toWorld: (x, y) => this.worldAt(x, y),
      // A click and a tap are the same judgement the gestures already make about whether a
      // press stayed put, so they share one threshold rather than disagreeing at the edges.
      clickThreshold: this.tapThreshold,
      dblClickWindow: options.dblClickWindow,
    })

    // Stop the browser's native touch scroll/pinch-zoom from competing with our own
    // gesture handling on touch devices.
    this.previousTouchAction = canvas.style.touchAction
    canvas.style.touchAction = 'none'
    this.previousCursor = canvas.style.cursor

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('contextmenu', this.onContextMenu)
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    this.canvas.style.touchAction = this.previousTouchAction
    this.canvas.style.cursor = this.previousCursor
    this.pointers.clear()
    this.events.reset()
    this.marquee.cancel()
    this.drag = null
    this.transform = null
  }

  // --- scene events ---
  //
  // Each is raised alongside the matching callback option, not instead of it. Everything
  // here checks the census first, so a scene that listens for none of it pays nothing -
  // which matters for the per-move ones, dragmove and transform.

  /** Raises a drag or transform event on every node taking part, carrying the whole set. */
  private fireOnNodes(type: string, nodes: readonly Shape[]): void {
    if (nodes.length === 0 || !hasListener(type)) return
    for (const node of nodes) node.fire(type, { nodes }, true)
  }

  /** Raises a scene-wide event on the root, which is where such listeners belong. */
  private fireOnRoot(type: string, init: NodeEventInit): void {
    if (!hasListener(type)) return
    this.handle.scene.root.fire(type, init, true)
  }

  private viewport(): Viewport {
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight }
  }

  private toCanvasPoint(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  private worldAt(screenX: number, screenY: number): Vector2 | null {
    return screenToWorld(this.handle.camera, screenX, screenY, this.viewport())
  }

  // --- viewport gestures: pan (1 pointer) and pinch (2 pointers) ---
  //
  // Recognised here, applied nowhere. Each reports the pointer (or the midpoint of two),
  // the world point that sat under it when the gesture began, and - for a pinch - how far
  // the two have spread since. That is everything panToAnchor and a zoom need, and it
  // leaves the application to decide whether a given gesture should move the view at all.

  private restartGesture(): void {
    const active = [...this.pointers.values()]
    const viewport = this.viewport()
    const next: GestureKind = active.length === 1 ? 'pan' : active.length === 2 ? 'pinch' : 'none'

    if (next !== this.gestureKind && this.gestureKind !== 'none') {
      this.fireGesture(`${this.gestureKind}end`)
    }
    this.gestureKind = next

    if (next === 'pan') {
      this.gestureAnchorWorld = screenToWorld(this.handle.camera, active[0].x, active[0].y, viewport)
      this.gesturePoint = new Vector2(active[0].x, active[0].y)
      this.gestureScale = 1
    } else if (next === 'pinch') {
      const midX = (active[0].x + active[1].x) / 2
      const midY = (active[0].y + active[1].y) / 2
      this.gestureAnchorWorld = screenToWorld(this.handle.camera, midX, midY, viewport)
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

  private beginTransform(anchor: TransformerAnchor, world: Vector2): void {
    const transformer = this.transformer
    const box = transformer?.currentBox
    if (!transformer || !box) return
    this.transform = {
      anchor,
      box,
      startWorld: world,
      snapshots: transformer.nodes.map((node: Shape) => ({ node, transform: node.captureTransform() })),
    }
    this.canvas.style.cursor = anchor === 'rotate' ? 'grabbing' : 'nwse-resize'
    this.fireOnNodes('transformstart', this.transform.snapshots.map((s) => s.node))
  }

  private updateTransform(world: Vector2, shiftKey: boolean, altKey: boolean): void {
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

    let delta
    if (session.anchor === 'rotate') {
      const angle = rotationDelta(
        session.box,
        session.startWorld,
        world,
        this.rotationSnaps,
        this.rotationSnapTolerance,
      )
      delta = rotateAbout({ x: session.box.cx, y: session.box.cy }, angle)
    } else {
      // Corners keep their aspect ratio by default (the classic uniform-corner scale);
      // shift inverts whichever way the transformer is configured, so it toggles either
      // into or out of uniform scaling depending on the setting.
      const corner = isCornerAnchor(session.anchor)
      const configured = this.transformer?.keepRatio ?? true
      const keepRatio = corner && (shiftKey ? !configured : configured)
      const factors = resizeFactors(session.box, session.anchor as ResizeAnchor, world, {
        keepRatio,
        centered: altKey,
      })
      delta = scaleAbout(factors.fixed, factors.rotation, factors.scaleX, factors.scaleY)
    }

    for (const snap of session.snapshots) {
      applyWorldTransform(snap.node, delta)
    }
    const nodes = session.snapshots.map((s) => s.node)
    this.onDrag(nodes)
    this.fireOnNodes('transform', nodes)
  }

  private endTransform(): void {
    if (!this.transform) return
    const nodes = this.transform.snapshots.map((s) => s.node)
    this.transform = null
    this.canvas.style.cursor = this.previousCursor
    this.onDragEnd(nodes)
    this.fireOnNodes('transformend', nodes)
  }

  // --- node dragging ---

  /**
   * Arms a drag over a draggable node. `hit` is whatever the press already hit-tested for
   * (see onPointerDown).
   */
  private armDrag(screenX: number, screenY: number, hit: PickableNode | null): boolean {
    if (!hit || !hit.draggable) return false
    const anchorWorld = this.worldAt(screenX, screenY)
    if (!anchorWorld) return false

    // The transformer's attached set is what "the group" means here: pressing a node that
    // is in it drags the whole set, pressing one that is not drags only that node. Neither
    // changes the set - an application does that, in response to the press it also heard.
    const nodes = this.transformer?.has(hit) ? [...this.transformer.nodes] : [hit]

    this.drag = {
      nodes,
      startPositions: nodes.map((node) => ({ x: node.x, y: node.y })),
      anchorWorld,
      active: false,
    }
    return true
  }

  private updateDrag(pointer: TrackedPointer): void {
    const drag = this.drag
    if (!drag) return

    if (!drag.active) {
      const moved = Math.hypot(pointer.x - pointer.downX, pointer.y - pointer.downY)
      if (moved <= this.tapThreshold) return
      drag.active = true
      this.canvas.style.cursor = 'grabbing'
      this.onDragStart(drag.nodes)
      this.fireOnNodes('dragstart', drag.nodes)
    }

    const world = this.worldAt(pointer.x, pointer.y)
    if (!world) return
    drag.nodes.forEach((node, i) => {
      const start = drag.startPositions[i]
      const next = draggedPosition(node, start.x, start.y, drag.anchorWorld, world)
      node.x = next.x
      node.y = next.y
    })
    // No markGeometryDirty(): x/y are transform-only, applied per frame from the object's
    // world matrix, so a drag never rebuilds geometry however far the nodes travel.
    this.onDrag(drag.nodes)
    this.fireOnNodes('dragmove', drag.nodes)
  }

  /** Ends the drag, optionally snapping the nodes back to where the drag started. */
  private endDrag(revert: boolean): void {
    const drag = this.drag
    if (!drag) return
    this.drag = null
    this.canvas.style.cursor = this.previousCursor
    if (!drag.active) return
    if (revert) {
      drag.nodes.forEach((node, i) => {
        node.x = drag.startPositions[i].x
        node.y = drag.startPositions[i].y
      })
    }
    this.onDragEnd(drag.nodes)
    this.fireOnNodes('dragend', drag.nodes)
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
    // Events report what the pointer did and go out before any of the gesture branching
    // below decides what to do about it, so the stream a listener sees is the same however
    // the press is subsequently interpreted. The one hit-test serves both this and the drag
    // arming further down - there is no reason to pay for it twice.
    const point = this.toCanvasPoint(e)
    const hit = this.handle.pick(point.x, point.y)
    this.events.down(e, point, hit)

    // The middle button is tracked but never grabs content, so its drag always reports as
    // a pan - the one press whose meaning is fixed here, since there is nothing under it
    // to grab in the first place.
    if (e.button === 1) {
      this.panningWithButton = true
      this.canvas.setPointerCapture(e.pointerId)
      this.pointers.set(e.pointerId, { x: point.x, y: point.y, downX: point.x, downY: point.y, type: e.pointerType })
      this.restartGesture()
      e.preventDefault()
      return
    }
    if (e.button !== 0) return

    const p = point
    this.canvas.setPointerCapture(e.pointerId)
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, downX: p.x, downY: p.y, type: e.pointerType })

    if (this.pointers.size >= 2) {
      this.multiTouch = true
      // A second finger means a pinch. Put anything mid-gesture back, so content grabbed
      // on the way into a two-finger gesture is not left moved by it.
      this.endDrag(true)
      this.endTransform()
      this.marquee.cancel()
      this.restartGesture()
      e.preventDefault()
      return
    }

    const world = this.worldAt(p.x, p.y)

    if (this.grabContent && world) {
      const anchor = this.transformer?.anchorAt(world.x, world.y) ?? null
      if (anchor) {
        this.beginTransform(anchor, world)
        this.restartGesture()
        e.preventDefault()
        return
      }
      if (this.dragNodes && this.armDrag(p.x, p.y, hit)) {
        this.restartGesture()
        e.preventDefault()
        return
      }
    }

    this.restartGesture()
    e.preventDefault()
  }

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.toCanvasPoint(e)
    // Dispatched before the tracked-pointer check below, because hovering happens with no
    // button held and so has no tracked pointer at all. Costs nothing when nothing is
    // listening for a hover event - the dispatcher never hit-tests in that case.
    this.events.move(e, p)

    const pointer = this.pointers.get(e.pointerId)
    if (!pointer) return
    pointer.x = p.x
    pointer.y = p.y

    if (this.transform) {
      const world = this.worldAt(p.x, p.y)
      if (world) this.updateTransform(world, e.shiftKey, e.altKey)
      return
    }
    if (this.drag) {
      this.updateDrag(pointer)
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
    if (e.type === 'pointercancel') this.events.cancel(e, point)
    else this.events.up(e, point)

    const pointer = this.pointers.get(e.pointerId)
    if (!pointer) return
    this.pointers.delete(e.pointerId)
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)

    if (e.button === 1 || this.panningWithButton) {
      this.panningWithButton = false
      if (this.pointers.size === 0) this.restartGesture()
      return
    }

    if (this.pointers.size === 0) {
      const moved = Math.hypot(pointer.x - pointer.downX, pointer.y - pointer.downY)
      const hadMarquee = this.marquee.active
      const wasTap = !this.multiTouch && moved <= this.tapThreshold

      this.endTransform()
      this.endDrag(false)

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
    this.events.leave(e, this.toCanvasPoint(e))
  }

  // Middle-click pastes on some platforms and opens a menu on others; the canvas owns it.
  private onContextMenu = (e: Event): void => {
    e.preventDefault()
    if (e instanceof MouseEvent) {
      const rect = this.canvas.getBoundingClientRect()
      this.events.contextMenu(
        { pointerId: -1, pointerType: 'mouse' },
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        e,
      )
    }
  }

  // The wheel is reported, not acted on - see the viewport-gesture section above. The
  // default is still suppressed, because a canvas that scrolls the page under a zoom
  // gesture is never what was wanted.
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    this.events.wheel({ pointerId: -1, pointerType: 'mouse' }, this.toCanvasPoint(e), e)
  }
}

/** Re-exported so hosts can type a picked node without reaching into scene/picking. */
export type { PickableNode }
