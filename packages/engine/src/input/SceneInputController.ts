// SceneInputController - wires a canvas to the Pointer Events API (one code path for
// mouse, touch and pen) plus wheel and keyboard, and drives camera pan/zoom, selection,
// node dragging and the Transformer through a SceneRendererHandle. It owns no rendering
// state of its own.
//
// A pointer press resolves in priority order: a transformer handle, then a node, then
// empty space. What empty space does depends on the input, because the two devices want
// opposite defaults:
//
//  - mouse/pen: left-drag on empty space rubber-bands a SELECTION BOX. Panning moves to
//    middle-drag or space+drag, the way desktop editors do it - a mouse has spare buttons
//    and a keyboard, so the primary drag is spent on selection.
//  - touch: a one-finger drag on empty space still PANS, since a finger has nothing else
//    to fall back on. Press and hold instead (see `longPressMs`) to arm the selection box,
//    confirmed with a haptic tick where the browser supports one.
//
// Two pointers always pinch-zoom and pan together, like a map.
//
// Gestures resolve against the values captured when the press began, never accumulated
// per move, so no gesture can drift over a long drag.

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

export interface SceneInputControllerOptions {
  /** Zoom factor bounds (same units as SceneRendererHandle.setZoom/getZoom). Default [0.05, 10]. */
  minZoom?: number
  maxZoom?: number
  /** Max total pointer movement (CSS px) for a gesture to still count as a tap/click. Default 6. */
  tapThreshold?: number
  /** Called whenever the selection changes, with every selected node (empty when cleared). */
  onSelectionChange?: (nodes: Shape[]) => void
  /**
   * Called as the selection box is dragged, with its two world-space corners - and with
   * null when it ends - so the host can draw it. Nothing is selected until it is released.
   */
  onMarquee?: (corners: { from: Vector2; to: Vector2 } | null) => void
  /** The transformer whose handles take priority over dragging/selecting. */
  transformer?: Transformer
  /** Set false to always pan the camera on a one-pointer drag, never move a node. Default true. */
  dragNodes?: boolean
  /** Called when a node drag begins (after the tap threshold is passed), ends, or moves. */
  onDragStart?: (nodes: readonly Shape[]) => void
  onDrag?: (nodes: readonly Shape[]) => void
  onDragEnd?: (nodes: readonly Shape[]) => void
  /** Hold time (ms) before a stationary touch arms the selection box. Default 450. */
  longPressMs?: number
  /** Buzz when a long press arms the selection box, where supported. Default true. */
  haptics?: boolean
  /** Angles (radians) a rotate drag settles onto when within `rotationSnapTolerance`. */
  rotationSnaps?: readonly number[]
  /** How close (radians) a rotation must come to a snap to take it. Default 0.12 (~7 degrees). */
  rotationSnapTolerance?: number
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

/** A rubber-band selection in progress. */
interface MarqueeSession {
  from: Vector2
  to: Vector2
  additive: boolean
}

const DEFAULT_MIN_ZOOM = 0.05
const DEFAULT_MAX_ZOOM = 10
const DEFAULT_TAP_THRESHOLD = 6
const DEFAULT_LONG_PRESS_MS = 450
const WHEEL_ZOOM_SENSITIVITY = 0.002 // ~18% zoom change per 100px of wheel delta
const KEY_ZOOM_FACTOR = 1.2
const KEY_PAN_STEP_PX = 40
const LONG_PRESS_HAPTIC_MS = 12

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
  private readonly longPressMs: number
  private readonly haptics: boolean
  private readonly rotationSnaps?: readonly number[]
  private readonly rotationSnapTolerance: number
  private readonly transformer?: Transformer
  private readonly dragNodes: boolean
  private readonly onSelectionChange: (nodes: Shape[]) => void
  private readonly onMarquee: (corners: { from: Vector2; to: Vector2 } | null) => void
  private readonly onDragStart: (nodes: readonly Shape[]) => void
  private readonly onDrag: (nodes: readonly Shape[]) => void
  private readonly onDragEnd: (nodes: readonly Shape[]) => void
  private readonly previousTouchAction: string
  private readonly previousCursor: string

  private readonly pointers = new Map<number, TrackedPointer>()
  private gestureAnchorWorld: Vector2 | null = null
  private gestureStartDistance = 0
  private gestureStartZoom = 1
  private multiTouch = false
  private panningWithButton = false

  private selection: Shape[] = []
  private drag: NodeDragSession | null = null
  private transform: TransformSession | null = null
  private marquee: MarqueeSession | null = null
  private longPressTimer: ReturnType<typeof setTimeout> | null = null
  private marqueeArmed = false
  // True from press to release whenever the press hit neither a transformer handle nor a
  // draggable node - i.e. empty space. A mouse click on empty space clears the selection
  // via the marquee branch below (it rubber-bands immediately, so `hadMarquee` is always
  // true there); a touch tap releases before the long-press timer ever arms a marquee, so
  // `hadMarquee` is false for it and this flag is what lets onPointerUp still clear the
  // selection for that case.
  private tappedEmptySpace = false
  private spaceHeld = false

  constructor(canvas: HTMLCanvasElement, handle: SceneRendererHandle, options: SceneInputControllerOptions = {}) {
    this.canvas = canvas
    this.handle = handle
    this.minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM
    this.maxZoom = options.maxZoom ?? DEFAULT_MAX_ZOOM
    this.tapThreshold = options.tapThreshold ?? DEFAULT_TAP_THRESHOLD
    this.longPressMs = options.longPressMs ?? DEFAULT_LONG_PRESS_MS
    this.haptics = options.haptics ?? true
    this.rotationSnaps = options.rotationSnaps
    this.rotationSnapTolerance = options.rotationSnapTolerance ?? 0.12
    this.transformer = options.transformer
    this.dragNodes = options.dragNodes ?? true
    this.onSelectionChange = options.onSelectionChange ?? (() => {})
    this.onMarquee = options.onMarquee ?? (() => {})
    this.onDragStart = options.onDragStart ?? (() => {})
    this.onDrag = options.onDrag ?? (() => {})
    this.onDragEnd = options.onDragEnd ?? (() => {})

    // Stop the browser's native touch scroll/pinch-zoom from competing with our own
    // gesture handling on touch devices.
    this.previousTouchAction = canvas.style.touchAction
    canvas.style.touchAction = 'none'
    this.previousCursor = canvas.style.cursor

    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
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
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.canvas.style.touchAction = this.previousTouchAction
    this.canvas.style.cursor = this.previousCursor
    this.clearLongPress()
    this.pointers.clear()
    this.drag = null
    this.transform = null
    this.marquee = null
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
      if (this.drag || this.transform || this.marquee) return
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
      snapshots: transformer.selection.map((node) => ({ node, transform: node.captureTransform() })),
    }
    this.canvas.style.cursor = anchor === 'rotate' ? 'grabbing' : 'nwse-resize'
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
    this.onDrag(session.snapshots.map((s) => s.node))
  }

  private endTransform(): void {
    if (!this.transform) return
    const nodes = this.transform.snapshots.map((s) => s.node)
    this.transform = null
    this.canvas.style.cursor = this.previousCursor
    this.onDragEnd(nodes)
  }

  // --- node dragging ---

  /** Arms a drag over a draggable node, selecting it first if it wasn't already. */
  private armDrag(screenX: number, screenY: number, shiftKey: boolean): boolean {
    const hit = this.handle.pick(screenX, screenY)
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
  }

  // --- selection box (marquee) ---

  private beginMarquee(world: Vector2, additive: boolean): void {
    this.marquee = { from: world, to: world, additive }
    this.onMarquee({ from: world, to: world })
  }

  private updateMarquee(pointer: TrackedPointer): void {
    if (!this.marquee) return
    const world = this.worldAt(pointer.x, pointer.y)
    if (!world) return
    this.marquee.to = world
    this.onMarquee({ from: this.marquee.from, to: this.marquee.to })
  }

  private endMarquee(): void {
    const session = this.marquee
    this.marquee = null
    this.marqueeArmed = false
    this.onMarquee(null)
    if (!session) return

    const hits = this.handle.nodesInBox(session.from, session.to)
    const picked = hits.filter((node) => !this.transformer?.owns(node))
    if (session.additive) {
      const merged = [...this.selection]
      for (const node of picked) if (!merged.includes(node)) merged.push(node)
      this.setSelection(merged)
    } else {
      this.setSelection(picked)
    }
  }

  private armLongPress(pointer: TrackedPointer, additive: boolean): void {
    this.clearLongPress()
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null
      // Only if the finger is still parked - any real movement means they meant to pan.
      const moved = Math.hypot(pointer.x - pointer.downX, pointer.y - pointer.downY)
      if (moved > this.tapThreshold || this.drag || this.transform) return
      const world = this.worldAt(pointer.downX, pointer.downY)
      if (!world) return
      this.marqueeArmed = true
      this.vibrate()
      this.beginMarquee(world, additive)
    }, this.longPressMs)
  }

  private clearLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer)
      this.longPressTimer = null
    }
  }

  /** A short haptic tick, where the browser offers one (notably not iOS Safari). */
  private vibrate(): void {
    if (!this.haptics) return
    const vibrate = typeof navigator !== 'undefined' ? navigator.vibrate?.bind(navigator) : undefined
    try {
      vibrate?.(LONG_PRESS_HAPTIC_MS)
    } catch {
      // A browser may refuse (no user gesture yet, or the feature is policy-blocked);
      // haptics are a nicety, never a reason to break the gesture.
    }
  }

  // --- pointer plumbing ---

  private onPointerDown = (e: PointerEvent): void => {
    // Middle-drag pans, which is how a mouse still reaches panning now that its primary
    // drag rubber-bands a selection.
    if (e.button === 1) {
      this.panningWithButton = true
      this.canvas.setPointerCapture(e.pointerId)
      const p = this.toCanvasPoint(e)
      this.pointers.set(e.pointerId, { x: p.x, y: p.y, downX: p.x, downY: p.y, type: e.pointerType })
      this.restartGesture()
      e.preventDefault()
      return
    }
    if (e.button !== 0) return

    const p = this.toCanvasPoint(e)
    this.canvas.setPointerCapture(e.pointerId)
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, downX: p.x, downY: p.y, type: e.pointerType })
    this.tappedEmptySpace = false

    if (this.pointers.size >= 2) {
      this.multiTouch = true
      // A second finger means a pinch. Put anything mid-gesture back and let the camera
      // take over: grabbing content on the way into a two-finger zoom shouldn't move it.
      this.clearLongPress()
      this.endDrag(true)
      this.endTransform()
      if (this.marquee) {
        this.marquee = null
        this.marqueeArmed = false
        this.onMarquee(null)
      }
      this.restartGesture()
      e.preventDefault()
      return
    }

    const world = this.worldAt(p.x, p.y)
    const touch = e.pointerType === 'touch'

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
      if (this.dragNodes && this.armDrag(p.x, p.y, e.shiftKey)) {
        this.restartGesture()
        e.preventDefault()
        return
      }
      // Empty space: rubber-band right away on a mouse, or arm the hold on a touch.
      this.tappedEmptySpace = true
      if (touch) {
        this.armLongPress(this.pointers.get(e.pointerId)!, e.shiftKey)
      } else {
        this.beginMarquee(world, e.shiftKey)
      }
    }

    this.restartGesture()
    e.preventDefault()
  }

  private onPointerMove = (e: PointerEvent): void => {
    const pointer = this.pointers.get(e.pointerId)
    if (!pointer) return
    const p = this.toCanvasPoint(e)
    pointer.x = p.x
    pointer.y = p.y

    // Movement before the hold fires means they meant to pan, not to select.
    if (this.longPressTimer !== null) {
      const moved = Math.hypot(pointer.x - pointer.downX, pointer.y - pointer.downY)
      if (moved > this.tapThreshold) this.clearLongPress()
    }

    if (this.transform) {
      const world = this.worldAt(p.x, p.y)
      if (world) this.updateTransform(world, e.shiftKey, e.altKey)
      return
    }
    if (this.drag) {
      this.updateDrag(pointer)
      return
    }
    if (this.marquee) {
      this.updateMarquee(pointer)
      return
    }
    this.updateGesture()
  }

  private onPointerUp = (e: PointerEvent): void => {
    const pointer = this.pointers.get(e.pointerId)
    if (!pointer) return
    this.pointers.delete(e.pointerId)
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)

    if (e.button === 1 || this.panningWithButton) {
      this.panningWithButton = false
      if (this.pointers.size === 0) this.gestureAnchorWorld = null
      return
    }

    this.clearLongPress()

    if (this.pointers.size === 0) {
      const moved = Math.hypot(pointer.x - pointer.downX, pointer.y - pointer.downY)
      const hadMarquee = this.marquee !== null
      const wasTap = !this.multiTouch && moved <= this.tapThreshold

      this.endTransform()
      this.endDrag(false)

      if (hadMarquee) {
        if (wasTap && !this.marqueeArmed) {
          // A plain click on empty space clears the selection instead of selecting the
          // zero-area rectangle it technically dragged out.
          this.marquee = null
          this.onMarquee(null)
          if (!e.shiftKey) this.setSelection([])
        } else {
          this.endMarquee()
        }
      } else if (wasTap && this.tappedEmptySpace) {
        // Touch: a quick tap releases before the long-press timer ever arms a marquee
        // (see armLongPress), so `hadMarquee` above is false - this is the touch
        // equivalent of the mouse's "plain click on empty space" branch just above.
        if (!e.shiftKey) this.setSelection([])
      }

      this.multiTouch = false
      this.marqueeArmed = false
      this.gestureAnchorWorld = null
    } else {
      this.restartGesture()
    }
  }

  // Middle-click pastes on some platforms and opens a menu on others; the canvas owns it.
  private onContextMenu = (e: Event): void => {
    e.preventDefault()
  }

  // --- wheel zoom, toward the cursor ---

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    const p = this.toCanvasPoint(e)
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
