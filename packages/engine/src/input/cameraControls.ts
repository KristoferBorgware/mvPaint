// Pure pan/zoom math for a 2D OrthographicCamera, shared by pointer-drag, pinch and
// wheel handling an application builds on the pan/pinch events. Both are expressed as "keep this
// world point pinned under this viewport pixel", which is what makes drag-to-pan and
// zoom-toward-cursor/pinch-center feel stable: the world point under the pointer never
// slides, whether it moves (pan) or the scale changes around it (zoom).

import type { OrthographicCamera } from '../camera/OrthographicCamera'
import type { Vector2 } from '../math/Vector2'
import { screenToWorld, type Viewport } from './viewport'

/**
 * Shifts the camera (eye and target move together, so orientation is unaffected) so
 * that world point `anchor` renders at viewport pixel (screenX, screenY).
 */
export function panToAnchor(
  camera: OrthographicCamera,
  viewport: Viewport,
  screenX: number,
  screenY: number,
  anchor: Vector2,
): void {
  const current = screenToWorld(camera, screenX, screenY, viewport)
  if (!current) return
  const dx = anchor.x - current.x
  const dy = anchor.y - current.y
  camera.eye.x += dx
  camera.eye.y += dy
  camera.target.x += dx
  camera.target.y += dy
}

/**
 * Sets the camera's viewHeight (its zoom knob) while keeping the world point currently
 * under (screenX, screenY) fixed on screen - "zoom toward the cursor/pinch center"
 * instead of toward the world origin.
 */
export function zoomToward(
  camera: OrthographicCamera,
  viewport: Viewport,
  screenX: number,
  screenY: number,
  nextViewHeight: number,
): void {
  const anchor = screenToWorld(camera, screenX, screenY, viewport)
  camera.viewHeight = Math.max(1e-3, nextViewHeight)
  if (anchor) panToAnchor(camera, viewport, screenX, screenY, anchor)
}
