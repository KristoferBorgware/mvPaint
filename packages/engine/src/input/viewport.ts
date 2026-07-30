// screenToWorld - maps a viewport pixel to the Z=0 plane the 2D scene lives in, by
// casting the camera's view ray through that pixel and intersecting it with the plane.
// Written against the ray rather than against x/y/zoom, so it stays correct for whatever
// the camera's view-projection turns out to be - a turned view today, a perspective one if
// the engine ever grows a 3D mode. Pan/zoom layer on top of it (see cameraControls.ts).

import type { Camera2D } from '../camera/Camera2D'
import { Vector2 } from '../math/Vector2'

export interface Viewport {
  /** CSS pixel size of the render viewport (e.g. canvas.clientWidth/clientHeight). */
  width: number
  height: number
}

/**
 * World-space point on the Z=0 plane under a viewport pixel (CSS px, relative to the
 * viewport's own top-left, y-down - matching pointer-event coordinates). Returns null
 * only if the camera's view ray is exactly parallel to the plane (looking edge-on),
 * which never happens for a Camera2D - it always looks straight at the plane.
 */
export function screenToWorld(camera: Camera2D, screenX: number, screenY: number, viewport: Viewport): Vector2 | null {
  const ray = camera.screenPointToRay(screenX, screenY, viewport.width, viewport.height)
  if (Math.abs(ray.direction.z) < 1e-9) return null
  const t = -ray.origin.z / ray.direction.z
  return new Vector2(ray.origin.x + ray.direction.x * t, ray.origin.y + ray.direction.y * t)
}
