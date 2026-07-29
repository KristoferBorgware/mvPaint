// SceneInputController - wires a canvas to the Pointer Events API (one code path for
// mouse, touch and pen) plus wheel and keyboard, and drives camera pan/zoom, node dragging
// and the Transformer through a SceneRendererHandle. It owns no rendering state of its own.
//
// A pointer press resolves in priority order: a transformer handle, then a draggable node,
// then empty space. What empty space means is not decided here - a one-finger drag over it
// pans the camera, and anything else an application wants from it (pulling out a marquee,
// clearing what is selected) is that application's to arrange, from the events below.
//
// Two pointers always pinch-zoom and pan together, like a map.
//
// Gestures resolve against the values captured when the press began, never accumulated
// per move, so no gesture can drift over a long drag.
//
// Alongside all of that it feeds a PointerDispatcher (`events`), which turns the same raw
// input into scene-graph events on whichever node the pointer is over - press, release,
// move, the hover crossings, click and double click. Those go out before any of the gesture
// branching here, so what a listener sees does not depend on how a press is subsequently
// interpreted, and the two are otherwise independent: the dispatcher decides nothing about
// dragging or the camera.
//
// The gestures themselves also report what they are doing, as scene events (see
// events/sceneEvents): dragstart/dragmove/dragend and transformstart/transform/transformend
// on each node taking part, and marqueestart/marqueemove/marqueeend on the scene root.
// Listening to those is how a host observes all of this without being wired in as a
// callback at construction time.
//
// The marquee (`marquee`, a MarqueeTool) is provided but never triggered from here. An
// application calls beginMarquee() when it decides a press means one - a selection tool
// being active, a modifier held, a long press it recognised itself - and this feeds the
// rectangle until the pointer comes up. See MarqueeTool for why that split.

import type { SceneRendererHandle } from '../webgpu/SceneRenderer'
import type { PickableNode } from '../scene/picking'
import type { Shape, ShapeTransform } from '../shapes/Shape'
import type { Transformer } from '../shapes/Transformer'
import type { Vector2 } from '../math/Vector2'
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
import { panToAnchor, zoomToward } from './cameraControls'
import { draggedPosition } from './nodeDrag'
import { PointerDispatcher } from '../events/PointerDispatcher'
import { MarqueeTool } from './MarqueeTool'
import { hasListener } from '../events/listenerCensus'
import type { NodeEventInit } from '../events/NodeEvent'

export interface SceneInputControllerOptions {
  /** Zoom factor bounds (same units as SceneRendererHandle.setZoom/getZoom). Default [0.05, 10]. */
  minZoom?: number
  maxZoom?: number
  /** Max total pointer movement (CSS px) for a gesture to still count as a tap/click. Default 6. */
  tapThreshold?: number
  /** Called whenever the selection changes, with every selected node (empty when cleared). */
  onSelectionChange?: (nodes: Shape[]) => void
  /** The transformer whose handles take priority over dragging/selecting. */
  transformer?: Transformer
  /** Set false to always pan the camera on a one-pointer drag, never move a node. Default true. */
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

/** A one-pointer drag moving the selection. Each node keeps its own start position. */
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

const DEFAULT_MIN_ZOOM = 0.05
const DEFAULT_MAX_ZOOM = 10
const DEFAULT_TAP_THRESHOLD = 6
const WHEEL_ZOOM_SENSITIVITY = 0.002 // ~18% zoom change per 100px of wheel delta
const KEY_ZOOM_FACTOR = 1.2
const KEY_PAN_STEP_PX = 40

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isEditableTarget(el: Element | null): boolean {
  if (!el) return false
  if ((el as HTMLElement).isContentEditable) return true
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** Corner anchors scale both axes at once, so they are the ones keepRatio applies to. */
function isCornerAnchor(anchor: TransformerAnchor): boolean {
  return (
    anchor === 'top-left' || anchor === 'top-right' || anchor === 'bottom-left' || anchor === 'bottom-right'
  )
}

export class SceneInputController {
  private readonly canvas: HTMLCanvasElement
  private readonly handle: SceneRendererHandle
  private readonly minZoom: number
  private readonly maxZoom: number
  private readonly tapThreshold: number
  private readonly rotationSnaps?: readonly number[]
  private readonly rotationSnapTolerance: number
  private readonly transformer?: Transformer
  private readonly dragNodes: boolean
  private readonly onSelectionChange: (nodes: Shape[]) => void
  private readonly onDragStart: (nodes: readonly Shape[]) => void
  private readonly onDrag: (nodes: readonly Shape[]) => void
  private readonly onDragEnd: (nodes: readonly Shape[]) => void
  private readonly previousTouchAction: string
  private readonly previousCursor: string
  /** Turns raw pointer input into scene-graph events. Owns no gesture state. */
  readonly events: PointerDispatcher

  private readonly pointers = new Map<number, TrackedPointer>()
  private gestureAnchorWorld: Vector2 | null = null
  private gestureStartDistance = 0
  private gestureStartZoom = 1
  private multiTouch = false
  private panningWithButton = false

  private selection: Shape[] = []
  private drag: NodeDragSession | null = null
  private transform: TransformSession | null = null
  /** The rubber-band rectangle. Started by the application, fed from here - see beginMarquee. */
  readonly marquee: MarqueeTool
  private spaceHeld = false

  constructor(canvas: HTMLCanvasElement, handle: SceneRendererHandle, options: SceneInputControllerOptions = {}) {
    this.canvas = canvas
    this.handle = handle
    this.minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM
    this.maxZoom = options.maxZoom ?? DEFAULT_MAX_ZOOM
    this.tapThreshold = options.tapThreshold ?? DEFAULT_TAP_THRESHOLD
    this.rotationSnaps = options.rotationSnaps
    this.rotationSnapTolerance = options.rotationSnapTolerance ?? 0.12
    this.transformer = options.transformer
    this.dragNodes = options.dragNodes ?? true
    this.onSelectionChange = options.onSelectionChange ?? (() => {})
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
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.canvas.style.touchAction = this.previousTouchAction
    this.canvas.style.cursor = this.previousCursor
    this.pointers.clear()
    this.events.reset()
    this.marquee.cancel()
    this.drag = null
    this.transform = null
  }

  /** The currently selected nodes. */
  getSelection(): readonly Shape[] {
    return this.selection
  }

  /** Replaces the selection (and re-points the transformer at it). */
  setSelection(nodes: readonly Shape[]): void {
    this.selection = nodes.filter((node) => !this.transformer?.owns(node))
    this.transformer?.attach(this.selection)
    this.onSelectionChange([...this.selection])
    this.fireOnRoot('selectionchange', { selection: this.selection })
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

  // --- camera gestures: pan (1 pointer) and pinch zoom+pan (2 pointers) ---

  private restartGesture(): void {
    const active = [...this.pointers.values()]
    const viewport = this.viewport()
    if (active.length === 1) {
      this.gestureAnchorWorld = screenToWorld(this.handle.camera, active[0].x, active[0].y, viewport)
    } else if (active.length === 2) {
      const midX = (active[0].x + active[1].x) / 2
      const midY = (active[0].y + active[1].y) / 2
      this.gestureAnchorWorld = screenToWorld(this.handle.camera, midX, midY, viewport)
      this.gestureStartDistance = Math.hypot(active[0].x - active[1].x, active[0].y - active[1].y)
      this.gestureStartZoom = this.handle.getZoom()
    } else {
      this.gestureAnchorWorld = null
    }
  }

  private updateGesture(): void {
    if (!this.gestureAnchorWorld) return
    const active = [...this.pointers.values()]
    const viewport = this.viewport()

    if (active.length === 1) {
      // Anything that grabbed content moves that content, never the camera - including
      // before a drag passes the tap threshold, so the view can't creep under a click.
      if (this.drag || this.transform || this.marquee.active) return
      panToAnchor(this.handle.camera, viewport, active[0].x, active[0].y, this.gestureAnchorWorld)
      return
    }
    if (active.length === 2) {
      const midX = (active[0].x + active[1].x) / 2
      const midY = (active[0].y + active[1].y) / 2
      const distance = Math.hypot(active[0].x - active[1].x, active[0].y - active[1].y)
      if (this.gestureStartDistance > 1e-3) {
        const nextZoom = clamp(this.gestureStartZoom * (distance / this.gestureStartDistance), this.minZoom, this.maxZoom)
        this.handle.camera.viewHeight = Math.max(1e-3, this.canvas.clientHeight / nextZoom)
        this.handle.setZoom(nextZoom)
      }
      panToAnchor(this.handle.camera, viewport, midX, midY, this.gestureAnchorWorld)
    }
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
    // put back EVERY transform field: a non-uniform scale on a selection whose members
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
   * Arms a drag over a draggable node, selecting it first if it wasn't already. `hit` is
   * whatever the press already hit-tested for (see onPointerDown).
   */
  private armDrag(screenX: number, screenY: number, shiftKey: boolean, hit: PickableNode | null): boolean {
    if (!hit || !hit.draggable) return false
    const anchorWorld = this.worldAt(screenX, screenY)
    if (!anchorWorld) return false

    // Pressing a node already in the selection drags the WHOLE selection; pressing a new
    // one selects it first (adding to the selection when shift is held).
    if (!this.selection.includes(hit)) {
      this.setSelection(shiftKey ? [...this.selection, hit] : [hit])
    }
    const nodes = this.selection.includes(hit) ? [...this.selection] : [hit]

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

    // Middle-drag pans, which is how a mouse still reaches panning now that its primary
    // drag rubber-bands a selection.
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
      // A second finger means a pinch. Put anything mid-gesture back and let the camera
      // take over: grabbing content on the way into a two-finger zoom shouldn't move it.
      this.endDrag(true)
      this.endTransform()
      this.marquee.cancel()
      this.restartGesture()
      e.preventDefault()
      return
    }

    const world = this.worldAt(p.x, p.y)

    // Space+drag is the other desktop pan, matching every editor that rebinds the primary
    // drag to something else.
    if (!this.spaceHeld && world) {
      const anchor = this.transformer?.anchorAt(world.x, world.y) ?? null
      if (anchor) {
        this.beginTransform(anchor, world)
        this.restartGesture()
        e.preventDefault()
        return
      }
      if (this.dragNodes && this.armDrag(p.x, p.y, e.shiftKey, hit)) {
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
      if (this.pointers.size === 0) this.gestureAnchorWorld = null
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
      this.gestureAnchorWorld = null
    } else {
      this.restartGesture()
    }
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

  // --- wheel zoom, toward the cursor ---

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const p = this.toCanvasPoint(e)
    this.events.wheel({ pointerId: -1, pointerType: 'mouse' }, p, e)
    const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY)
    const nextZoom = clamp(this.handle.getZoom() * factor, this.minZoom, this.maxZoom)
    this.applyAnchoredZoom(p.x, p.y, nextZoom)
  }

  private applyAnchoredZoom(screenX: number, screenY: number, nextZoom: number): void {
    const nextViewHeight = this.canvas.clientHeight / nextZoom
    zoomToward(this.handle.camera, this.viewport(), screenX, screenY, nextViewHeight)
    this.handle.setZoom(nextZoom)
  }

  // --- keyboard: arrow-key pan, +/- zoom (about the viewport center), Escape deselects ---

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === ' ') {
      this.spaceHeld = false
      this.canvas.style.cursor = this.previousCursor
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isEditableTarget(document.activeElement)) return

    if (e.key === ' ') {
      if (!this.spaceHeld) {
        this.spaceHeld = true
        this.canvas.style.cursor = 'grab'
      }
      e.preventDefault()
      return
    }

    const camera = this.handle.camera
    const viewport = this.viewport()
    const worldPerPixel = camera.viewHeight / Math.max(1, viewport.height)
    const step = KEY_PAN_STEP_PX * worldPerPixel

    switch (e.key) {
      case 'ArrowLeft':
        camera.eye.x -= step
        camera.target.x -= step
        break
      case 'ArrowRight':
        camera.eye.x += step
        camera.target.x += step
        break
      case 'ArrowUp':
        camera.eye.y += step
        camera.target.y += step
        break
      case 'ArrowDown':
        camera.eye.y -= step
        camera.target.y -= step
        break
      case '+':
      case '=':
        this.applyAnchoredZoom(viewport.width / 2, viewport.height / 2, clamp(this.handle.getZoom() * KEY_ZOOM_FACTOR, this.minZoom, this.maxZoom))
        break
      case '-':
      case '_':
        this.applyAnchoredZoom(viewport.width / 2, viewport.height / 2, clamp(this.handle.getZoom() / KEY_ZOOM_FACTOR, this.minZoom, this.maxZoom))
        break
      case 'Escape':
        this.setSelection([])
        return
      default:
        return
    }
    e.preventDefault()
  }
}

/** Re-exported so hosts can type a selection callback without reaching into scene/picking. */
export type { PickableNode }
