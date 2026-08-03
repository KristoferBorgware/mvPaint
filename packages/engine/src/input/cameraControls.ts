// Pure pan/zoom math for a Camera2D, shared by the pointer-drag, pinch and wheel handling
// an application builds on the pan/pinch events. All of it is expressed as "keep this world
// point pinned under this viewport pixel", which is what makes drag-to-pan and
// zoom-toward-cursor/pinch-centre feel stable: the world point under the pointer never
// slides, whether it moves (pan) or the scale changes around it.
//
// The anchor is a parameter throughout rather than something read here, because WHICH point
// a gesture is aimed at is the gesture's own business and outlives any one step of it - a
// pinch pins what its two fingers landed on, and a wheel burst pins what the cursor was over
// when the burst began, however many notches follow.
//
// Both go through screenToWorld rather than adjusting x/y arithmetically. That is what
// keeps them correct on a TURNED view, where a screen-space delta is not a world-space
// delta, and what would keep them correct under a projection that is not orthographic.

import type { Camera2D } from '../camera/Camera2D'
import type { Vector2 } from '../math/Vector2'
import { screenToWorld, type Viewport } from './viewport'

/** Moves the camera so world point `anchor` renders at viewport pixel (screenX, screenY). */
export function panToAnchor(
  camera: Camera2D,
  viewport: Viewport,
  screenX: number,
  screenY: number,
  anchor: Vector2,
): void {
  const current = screenToWorld(camera, screenX, screenY, viewport)
  if (!current) return
  camera.x += anchor.x - current.x
  camera.y += anchor.y - current.y
}

/**
 * Sets the camera's zoom while keeping the world point currently under (screenX, screenY)
 * fixed on screen - "zoom toward the cursor/pinch centre" rather than toward the camera's
 * own corner. The anchor is read BEFORE the zoom changes and restored after, so the two
 * steps compose without either needing to know the other's arithmetic.
 *
 * For ONE zoom. A gesture made of many - a wheel burst, a pinch - should read its anchor
 * once and hand it to zoomAbout below for every step, rather than call this repeatedly; see
 * the note there for why re-reading an anchor that ought to be identical is not.
 */
export function zoomToward(
  camera: Camera2D,
  viewport: Viewport,
  screenX: number,
  screenY: number,
  nextZoom: number,
): void {
  const anchor = screenToWorld(camera, screenX, screenY, viewport)
  if (!anchor) {
    camera.zoom = nextZoom > 0 ? nextZoom : camera.zoom
    return
  }
  zoomAbout(camera, viewport, screenX, screenY, anchor, nextZoom)
}

/**
 * zoomToward with the anchor SUPPLIED rather than read: sets the zoom and puts `anchor` back
 * under (screenX, screenY). This is the form a gesture wants, because a gesture already knows
 * what it is aimed at and must go on being aimed at the same thing.
 *
 * Reading the anchor afresh on each step of a burst looks equivalent - the world point was
 * pinned under that pixel a moment ago, so unprojecting the pixel again should hand it back -
 * and in exact arithmetic it is. In floating point it is not. Every read is a 4x4 inverse
 * through a camera the previous step just wrote, and every write is a correction measured
 * FROM that read, so a rounded answer becomes the next step's target: error that would have
 * cancelled instead accumulates, and over a long scroll the content creeps out from under
 * the cursor. Held, each step corrects back to one fixed point and the error stays whatever
 * the last step's rounding was.
 */
export function zoomAbout(
  camera: Camera2D,
  viewport: Viewport,
  screenX: number,
  screenY: number,
  anchor: Vector2,
  nextZoom: number,
): void {
  camera.zoom = nextZoom > 0 ? nextZoom : camera.zoom
  panToAnchor(camera, viewport, screenX, screenY, anchor)
}
