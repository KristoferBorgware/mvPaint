// Browser input for a FreeFloatCamera. Translates keyboard/mouse events on a canvas
// into per-frame CameraInput and FOV zoom. Not part of the ported math - this is the
// mvPaint glue that binds DOM events to the platform-agnostic camera.
//
// Controls:
//   WASD           move (forward/back + strafe), fly along the look direction
//   Shift          move faster
//   Right-mouse    hold + move to look around (yaw/pitch)
//   Mouse wheel    zoom (field of view)
//   Middle-mouse   hold + drag up/down to zoom (field of view)

import type { FreeFloatCamera } from './FreeFloatCamera'

const DEG2RAD = Math.PI / 180

export interface FreeFlyControllerOptions {
  /** Radians of FOV change per unit of wheel deltaY. */
  wheelZoomSensitivity?: number
  /** Radians of FOV change per pixel of middle-mouse drag. */
  dragZoomSensitivity?: number
  minFovY?: number
  maxFovY?: number
}

const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD'])

export class FreeFlyController {
  private readonly canvas: HTMLCanvasElement
  private readonly camera: FreeFloatCamera

  private readonly wheelZoomSensitivity: number
  private readonly dragZoomSensitivity: number
  private readonly minFovY: number
  private readonly maxFovY: number

  private readonly keys = new Set<string>()
  private looking = false
  private zooming = false
  // Accumulated since the last update() call.
  private lookDX = 0
  private lookDY = 0
  private fovDelta = 0

  constructor(
    canvas: HTMLCanvasElement,
    camera: FreeFloatCamera,
    options: FreeFlyControllerOptions = {},
  ) {
    this.canvas = canvas
    this.camera = camera
    this.wheelZoomSensitivity = options.wheelZoomSensitivity ?? 0.0015
    this.dragZoomSensitivity = options.dragZoomSensitivity ?? 0.005
    this.minFovY = options.minFovY ?? 10 * DEG2RAD
    this.maxFovY = options.maxFovY ?? 100 * DEG2RAD

    this.canvas.addEventListener('mousedown', this.onMouseDown)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('mouseup', this.onMouseUp)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
  }

  /** Apply this frame's accumulated input to the camera, then clear per-frame deltas. */
  update(dt: number): void {
    const forward = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0)
    const right = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0)
    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')

    this.camera.update(dt, {
      moveForward: forward,
      moveRight: right,
      lookX: this.lookDX,
      lookY: this.lookDY,
      fast,
    })

    if (this.fovDelta !== 0) {
      const next = this.camera.fovY + this.fovDelta
      this.camera.fovY = Math.max(this.minFovY, Math.min(this.maxFovY, next))
    }

    this.lookDX = 0
    this.lookDY = 0
    this.fovDelta = 0
  }

  dispose(): void {
    this.canvas.removeEventListener('mousedown', this.onMouseDown)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
  }

  private readonly onMouseDown = (e: MouseEvent) => {
    if (e.button === 2) {
      this.looking = true
      e.preventDefault()
    } else if (e.button === 1) {
      this.zooming = true
      e.preventDefault() // middle button otherwise triggers autoscroll
    }
  }

  private readonly onMouseMove = (e: MouseEvent) => {
    if (this.looking) {
      this.lookDX += e.movementX
      this.lookDY += e.movementY
    }
    if (this.zooming) {
      this.fovDelta += e.movementY * this.dragZoomSensitivity
    }
  }

  private readonly onMouseUp = (e: MouseEvent) => {
    if (e.button === 2) this.looking = false
    else if (e.button === 1) this.zooming = false
  }

  private readonly onWheel = (e: WheelEvent) => {
    this.fovDelta += e.deltaY * this.wheelZoomSensitivity
    e.preventDefault() // don't scroll the page
  }

  private readonly onContextMenu = (e: MouseEvent) => {
    e.preventDefault() // right-drag look shouldn't pop the context menu
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.code)
    if (MOVE_KEYS.has(e.code)) e.preventDefault()
  }

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code)
  }

  // Dropping focus (alt-tab, etc.) should release all held state so keys don't stick.
  private readonly onBlur = () => {
    this.keys.clear()
    this.looking = false
    this.zooming = false
  }
}
