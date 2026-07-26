// Behavioural self-test for the ported cameras. Run with:
//   npx tsx src/camera/selfTest.ts

import { FreeFloatCamera } from './FreeFloatCamera'
import { OrbitCamera } from './OrbitCamera'
import { OrthographicCamera } from './OrthographicCamera'
import { Vector3 } from '../math/Vector3'

let count = 0
function assert(cond: boolean, msg: string): void {
  count++
  if (!cond) throw new Error(`[camera] self-test FAILED: ${msg}`)
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps

// --- FreeFloatCamera: default pose looks down -Z ---
{
  const cam = new FreeFloatCamera()
  cam.eye = new Vector3(0, 0, 9)
  // World origin sits 9 units in front of the camera -> view space (0,0,-9).
  const p = cam.view().transformPoint(new Vector3(0, 0, 0))
  assert(p.nearEquals(new Vector3(0, 0, -9), 1e-3), 'default view maps origin to (0,0,-9)')
}

// --- FreeFloatCamera: W flies forward (down -Z), D strafes +X ---
{
  const cam = new FreeFloatCamera()
  cam.eye = new Vector3(0, 0, 9)
  cam.update(1, { moveForward: 1 }) // 1 second, full forward
  assert(near(cam.eye.z, 9 - cam.moveSpeed), 'W moves along -Z by moveSpeed')

  const cam2 = new FreeFloatCamera()
  cam2.eye = new Vector3(0, 0, 9)
  cam2.update(1, { moveRight: 1 })
  assert(near(cam2.eye.x, cam2.moveSpeed), 'D strafes +X by moveSpeed')
}

// --- FreeFloatCamera: mouse-look yaw turns the view; +90deg yaw looks down -X ---
{
  const cam = new FreeFloatCamera()
  cam.eye = new Vector3(0, 0, 0)
  // yaw -= lookX * sensitivity; we want yaw = +PI/2, so lookX negative.
  const lookX = -(Math.PI / 2) / cam.lookSensitivity
  cam.update(0, { lookX })
  // Looking down -X: a point one unit ahead should be at world (-1,0,0)... check via
  // forward direction recovered from the view (row/col-agnostic behavioural check).
  const fwd = cam.view().inverse().transformDirection(new Vector3(0, 0, -1))
  assert(fwd.nearEquals(new Vector3(-1, 0, 0), 1e-3), '+90deg yaw looks toward -X')
}

// --- FreeFloatCamera: pitch is clamped, never vertical ---
{
  const cam = new FreeFloatCamera()
  cam.update(0, { lookY: 1e6 }) // huge downward look
  const fwd = cam.view().inverse().transformDirection(new Vector3(0, 0, -1))
  assert(Math.abs(fwd.y) < 1, 'pitch clamp keeps the view off vertical')
}

// --- Camera.screenPointToRay: centre pixel shoots along the look direction ---
{
  const cam = new FreeFloatCamera()
  cam.eye = new Vector3(0, 0, 9)
  const ray = cam.screenPointToRay(400, 300, 800, 600)
  assert(ray.direction.nearEquals(new Vector3(0, 0, -1), 1e-2), 'centre ray points down -Z')
}

// --- OrbitCamera: default sits on +Z, wheel zoom pulls in ---
{
  const cam = new OrbitCamera()
  cam.update({}) // sync eye
  assert(cam.eye.nearEquals(new Vector3(0, 0, cam.distance), 1e-3), 'orbit starts on +Z')
  const d0 = cam.distance
  cam.update({ zoom: 1 }) // one notch in
  assert(cam.distance < d0, 'wheel zoom-in reduces distance')
}

// --- OrthographicCamera.viewBounds: a world-space rectangle centered on the camera,
//     used for viewport culling (scene/culling.ts) - no plane/frustum math needed since
//     an orthographic 2D frustum IS just an axis-aligned box ---
{
  const cam = new OrthographicCamera()
  cam.eye = new Vector3(10, -5, 20) // z is irrelevant here (the camera always looks down -Z)
  cam.viewHeight = 20
  const bounds = cam.viewBounds(2) // 2:1 aspect -> width follows viewHeight * aspect
  assert(near(bounds.min.x, 10 - 20) && near(bounds.max.x, 10 + 20), 'view width is viewHeight * aspect, centered on eye.x')
  assert(near(bounds.min.y, -5 - 10) && near(bounds.max.y, -5 + 10), 'view height is viewHeight, centered on eye.y')

  // Panning (eye moves) shifts the rectangle; zooming (viewHeight shrinks) shrinks it -
  // the same pan/zoom model input/cameraControls.ts already drives.
  cam.eye.x += 5
  const panned = cam.viewBounds(2)
  assert(near(panned.min.x, bounds.min.x + 5), 'panning the camera shifts the view rectangle with it')

  cam.viewHeight = 10
  const zoomedIn = cam.viewBounds(2)
  assert(
    zoomedIn.max.y - zoomedIn.min.y < bounds.max.y - bounds.min.y,
    'a smaller viewHeight (zoomed in) shrinks the view rectangle',
  )
}

console.log(`[camera] self-test passed (${count} assertions)`)
