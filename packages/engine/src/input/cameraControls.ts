// Pure pan/zoom math for a Camera2D, shared by the pointer-drag, pinch and wheel handling
// an application builds on the pan/pinch events. Both are expressed as "keep this world
// point pinned under this viewport pixel", which is what makes drag-to-pan and
// zoom-toward-cursor/pinch-centre feel stable: the world point under the pointer never
// slides, whether it moves (pan) or the scale changes around it.
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
 */
export function zoomToward(
  camera: Camera2D,
  viewport: Viewport,
  screenX: number,
  screenY: number,
  nextZoom: number,
): void {
  const anchor = screenToWorld(camera, screenX, screenY, viewport)
  camera.zoom = nextZoom > 0 ? nextZoom : camera.zoom
  if (anchor) panToAnchor(camera, viewport, screenX, screenY, anchor)
}
