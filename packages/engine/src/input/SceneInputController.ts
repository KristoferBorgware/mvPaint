// SceneInputController - wires a canvas to the Pointer Events API (one code path for
// mouse, touch and pen) plus wheel and keyboard, and drives camera pan/zoom and node
// picking through a SceneRendererHandle. It owns no rendering state of its own; it only
// calls the handle's setZoom()/pick() and mutates handle.camera directly (pan is not
// behind the "zoom factor" abstraction, so it's safe to adjust every frame without
// fighting the renderer).
//
// Gestures:
//  - one pointer down+drag over a draggable node moves THAT NODE; over empty space (or a
//    non-draggable one) it pans the camera instead - the "grab what's under the cursor,
//    otherwise grab the canvas" model direct-manipulation editors use.
//  - two pointers down+drag (pinch) zooms about their midpoint and pans with it, so a
//    pinch that also drifts sideways pans and zooms at once, like a map app.
//  - mouse wheel zooms toward the cursor.
//  - arrow keys pan, +/- zoom (both about the viewport center), Escape clears the
//    selection - skipped while an editable element (an input, textarea...) has focus.
//  - a pointer session that stays within `tapThreshold` px and never involved a second
//    pointer counts as a tap/click: it picks the node under it (or clears the selection
//    if it hits empty space) via `onPick`. That same threshold arms a node drag, so a
//    click that wobbles a pixel or two still selects instead of nudging the node.

import type { SceneRendererHandle } from '../webgpu/SceneRenderer'
import type { PickableNode } from '../scene/picking'
import type { Vector2 } from '../math/Vector2'
import { screenToWorld, type Viewport } from './viewport'
import { panToAnchor, zoomToward } from './cameraControls'
import { draggedPosition } from './nodeDrag'

export interface SceneInputControllerOptions {
  /** Zoom factor bounds (same units as SceneRendererHandle.setZoom/getZoom). Default [0.05, 10]. */
  minZoom?: number
  maxZoom?: number
  /** Max total pointer movement (CSS px) for a gesture to still count as a tap/click. Default 6. */
  tapThreshold?: number
  /** Called with the picked node on a tap/click, or null when it hits empty space or Escape is pressed. */
  onPick?: (node: PickableNode | null) => void
  /** Set false to always pan the camera on a one-pointer drag, never move a node. Default true. */
  dragNodes?: boolean
  /** Called when a node drag begins (after the tap threshold is passed), ends, or moves the node. */
  onDragStart?: (node: PickableNode) => void
  onDrag?: (node: PickableNode) => void
  onDragEnd?: (node: PickableNode) => void
}

interface TrackedPointer {
  x: number
  y: number
  downX: number
  downY: number
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

/**
 * A one-pointer drag that grabbed a node: the node itself, the world point under the
 * pointer when it went down, and the node's own x/y at that moment. Everything is
 * resolved against that fixed anchor rather than accumulated per move, so a drag can
 * never drift, and the grabbed point of the shape stays exactly under the pointer.
 * `active` stays false until the pointer passes the tap threshold, so a click that
 * wobbles slightly selects the node instead of nudging it.
 */
interface NodeDrag {
  node: PickableNode
  anchorWorld: Vector2
  startX: number
  startY: number
  active: boolean
}

export class SceneInputController {
  private readonly canvas: HTMLCanvasElement
  private readonly handle: SceneRendererHandle
  private readonly minZoom: number
  private readonly maxZoom: number
  private readonly tapThreshold: number
  private readonly onPick: (node: PickableNode | null) => void
  private readonly dragNodes: boolean
  private readonly onDragStart: (node: PickableNode) => void
  private readonly onDrag: (node: PickableNode) => void
  private readonly onDragEnd: (node: PickableNode) => void
  private readonly previousTouchAction: string
  private readonly previousCursor: string

  private readonly pointers = new Map<number, TrackedPointer>()
  private gestureAnchorWorld: Vector2 | null = null
  private gestureStartDistance = 0
  private gestureStartZoom = 1
  private multiTouch = false
  private drag: NodeDrag | null = null

  constructor(canvas: HTMLCanvasElement, handle: SceneRendererHandle, options: SceneInputControllerOptions = {}) {
    this.canvas = canvas
    this.handle = handle
    this.minZoom = options.minZoom ?? DEFAULT_MIN_ZOOM
    this.maxZoom = options.maxZoom ?? DEFAULT_MAX_ZOOM
    this.tapThreshold = options.tapThreshold ?? DEFAULT_TAP_THRESHOLD
    this.onPick = options.onPick ?? (() => {})
    this.dragNodes = options.dragNodes ?? true
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
    window.addEventListener('keydown', this.onKeyDown)
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    window.removeEventListener('keydown', this.onKeyDown)
    this.canvas.style.touchAction = this.previousTouchAction
    this.canvas.style.cursor = this.previousCursor
    this.pointers.clear()
    this.drag = null
  }

  private viewport(): Viewport {
    return { width: this.canvas.clientWidth, height: this.canvas.clientHeight }
  }

  private toCanvasPoint(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  // --- pointer gestures: pan (1 pointer) and pinch zoom+pan (2 pointers) ---

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
      // A pointer that grabbed a node moves that node, never the camera - including
      // before the drag passes the tap threshold, so the view can't creep under a click.
      if (this.drag) return
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

  // --- node dragging (one pointer, grabbing a draggable node) ---

  /** Arms a drag if a draggable node sits under the pointer; otherwise leaves it to pan. */
  private armDrag(screenX: number, screenY: number): void {
    const node = this.handle.pick(screenX, screenY)
    if (!node || !node.draggable) return
    const anchorWorld = screenToWorld(this.handle.camera, screenX, screenY, this.viewport())
    if (!anchorWorld) return
    this.drag = { node, anchorWorld, startX: node.x, startY: node.y, active: false }
  }

  private updateDrag(pointer: TrackedPointer): void {
    const drag = this.drag
    if (!drag) return

    if (!drag.active) {
      const moved = Math.hypot(pointer.x - pointer.downX, pointer.y - pointer.downY)
      if (moved <= this.tapThreshold) return
      drag.active = true
      this.canvas.style.cursor = 'grabbing'
      this.onDragStart(drag.node)
    }

    const world = screenToWorld(this.handle.camera, pointer.x, pointer.y, this.viewport())
    if (!world) return

    const next = draggedPosition(drag.node, drag.startX, drag.startY, drag.anchorWorld, world)
    drag.node.x = next.x
    drag.node.y = next.y
    // No markGeometryDirty(): x/y are transform-only, applied per frame from the object's
    // world matrix, so a drag never rebuilds geometry however far the node travels.
    this.onDrag(drag.node)
  }

  /** Ends the drag, optionally snapping the node back to where the drag started. */
  private endDrag(revert: boolean): void {
    const drag = this.drag
    if (!drag) return
    this.drag = null
    this.canvas.style.cursor = this.previousCursor
    if (!drag.active) return
    if (revert) {
      drag.node.x = drag.startX
      drag.node.y = drag.startY
    }
    this.onDragEnd(drag.node)
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return
    const p = this.toCanvasPoint(e)
    this.canvas.setPointerCapture(e.pointerId)
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, downX: p.x, downY: p.y })
    if (this.pointers.size >= 2) {
      this.multiTouch = true
      // A second finger means a pinch, not a drag. Put the node back where it started:
      // grabbing a shape on the way into a two-finger zoom shouldn't displace it.
      this.endDrag(true)
    } else if (this.dragNodes) {
      this.armDrag(p.x, p.y)
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
    if (this.drag) {
      this.updateDrag(pointer)
      return
    }
    this.updateGesture()
  }

  private onPointerUp = (e: PointerEvent): void => {
    const pointer = this.pointers.get(e.pointerId)
    if (!pointer) return
    this.pointers.delete(e.pointerId)
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)

    if (this.pointers.size === 0) {
      const moved = Math.hypot(pointer.x - pointer.downX, pointer.y - pointer.downY)
      this.endDrag(false)
      if (!this.multiTouch && moved <= this.tapThreshold) {
        this.onPick(this.handle.pick(pointer.x, pointer.y))
      }
      this.multiTouch = false
      this.gestureAnchorWorld = null
    } else {
      this.restartGesture()
    }
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

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isEditableTarget(document.activeElement)) return

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
        this.onPick(null)
        return
      default:
        return
    }
    e.preventDefault()
  }
}
