// Self-test for the pan/zoom/pick math (screenToWorld, panToAnchor, zoomToward). Pure
// camera/geometry, no DOM - SceneInputController itself is a thin event-wiring layer
// over these and isn't covered here. Run with:
//   npx tsx src/input/selfTest.ts

import { OrthographicCamera } from '../camera/OrthographicCamera'
import { screenToWorld, type Viewport } from './viewport'
import { panToAnchor, zoomToward } from './cameraControls'

let count = 0
function assert(cond: boolean, msg: string): void {
  count++
  if (!cond) throw new Error(`[input] self-test FAILED: ${msg}`)
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps

// --- screenToWorld: viewport center maps to the camera's look-at point; corners follow
//     viewHeight/aspect, with screen y-down flipped to world y-up ---
{
  const camera = new OrthographicCamera()
  camera.viewHeight = 10
  const viewport: Viewport = { width: 200, height: 100 } // aspect 2 -> world width 20

  const center = screenToWorld(camera, 100, 50, viewport)
  assert(center !== null && near(center.x, 0) && near(center.y, 0), 'viewport center is the look-at point')

  const topLeft = screenToWorld(camera, 0, 0, viewport)
  assert(topLeft !== null && near(topLeft.x, -10) && near(topLeft.y, 5), 'top-left corner: -halfWidth, +halfHeight')

  const bottomRight = screenToWorld(camera, 200, 100, viewport)
  assert(
    bottomRight !== null && near(bottomRight.x, 10) && near(bottomRight.y, -5),
    'bottom-right corner: +halfWidth, -halfHeight',
  )
}

// --- panToAnchor: pins a captured world point under a moving screen position ---
{
  const camera = new OrthographicCamera()
  camera.viewHeight = 10
  const viewport: Viewport = { width: 200, height: 100 }

  const anchor = screenToWorld(camera, 100, 50, viewport) // world (0,0), at the center
  assert(anchor !== null, 'anchor captured')

  // Drag from the center to (150, 70): the point that was under the pointer should
  // follow it to the new position.
  panToAnchor(camera, viewport, 150, 70, anchor!)
  const atNewPointer = screenToWorld(camera, 150, 70, viewport)
  assert(atNewPointer !== null && near(atNewPointer.x, 0) && near(atNewPointer.y, 0), 'anchor follows the pointer to its new position')

  // The old screen position now shows different content (the camera moved).
  const atOldPointer = screenToWorld(camera, 100, 50, viewport)
  assert(atOldPointer !== null && !near(atOldPointer.x, 0), 'old screen position no longer shows the anchor')
}

// --- zoomToward: changes viewHeight while keeping the point under the cursor fixed ---
{
  const camera = new OrthographicCamera()
  camera.viewHeight = 10
  const viewport: Viewport = { width: 200, height: 100 }

  const cursorX = 150
  const cursorY = 70
  const before = screenToWorld(camera, cursorX, cursorY, viewport)
  assert(before !== null, 'pre-zoom anchor captured')

  zoomToward(camera, viewport, cursorX, cursorY, 4) // zoom in: viewHeight 10 -> 4
  assert(near(camera.viewHeight, 4), 'zoomToward sets the requested viewHeight')

  const after = screenToWorld(camera, cursorX, cursorY, viewport)
  assert(
    after !== null && near(after.x, before!.x) && near(after.y, before!.y),
    'the world point under the cursor is unchanged by the zoom',
  )

  // A second zoom step (still anchored at the same cursor position) should keep pinning
  // the same world point, not the point from the first step's stale anchor.
  zoomToward(camera, viewport, cursorX, cursorY, 2) // zoom in further: 4 -> 2
  const stillFixed = screenToWorld(camera, cursorX, cursorY, viewport)
  assert(
    stillFixed !== null && near(stillFixed.x, before!.x) && near(stillFixed.y, before!.y),
    'repeated zoomToward calls keep pinning the same anchor',
  )
  assert(Math.hypot(before!.x, before!.y) > 0, 'sanity: the cursor anchor was not exactly the world origin')
}

console.log(`[input] self-test passed (${count} assertions)`)
