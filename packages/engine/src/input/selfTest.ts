// Self-test for the pan/zoom/pick math (screenToWorld, panToAnchor, zoomToward), the
// node-drag math (draggedPosition), and how SceneInputDispatcher resolves a press.
//
// The dispatcher is mostly event wiring over the pure math above, but the ORDER in which it
// resolves a press is behaviour in its own right: what a press means has to be settled
// before it is reported, or an application acting on the report changes the state the
// gesture is about to use. It is driven here through a stub canvas that just collects the
// listeners it registers - no DOM, no GPU. Run with:
//   npx tsx src/input/selfTest.ts

import { OrthographicCamera } from '../camera/OrthographicCamera'
import { Container } from '../shapes/Container'
import { Rect , type RectOptions } from '../shapes/Rect'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Vector2 } from '../math/Vector2'
import { Vector3 } from '../math/Vector3'
import { screenToWorld, type Viewport } from './viewport'
import { panToAnchor, zoomToward } from './cameraControls'
import { draggedPosition } from './nodeDrag'
import { SceneInputDispatcher } from './SceneInputDispatcher'
import { Transformer } from '../shapes/Transformer'
import { Circle } from '../shapes/Circle'
import { resetListenerCensus } from '../events/listenerCensus'
import type { Shape } from '../shapes/Shape'

let count = 0
function assert(cond: boolean, msg: string): void {
  count++
  if (!cond) throw new Error(`[input] self-test FAILED: ${msg}`)
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps

/**
 * A Rect CENTRED on (x, y). A Rect's own origin is its top-left corner (see Shape's
 * header), so this applies the pivot offset that puts its middle back on the position -
 * which is the frame the geometry below is written in.
 */
const centredRect = (options: RectOptions = {}): Rect =>
  new Rect({ ...options, offsetX: (options.width ?? 1) / 2, offsetY: -(options.height ?? 1) / 2 })



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

// --- draggedPosition: a node follows the pointer in WORLD space, while its own x/y stay
//     relative to whatever transform its parent imposes ---
{
  // A container whose local transform the test sets directly, so a node can be parented
  // under an arbitrary rotate/scale/flip frame without a whole scene.
  class TransformGroup extends Container {
    matrix = Matrix4x4.identity()
    override localMatrix(): Matrix4x4 {
      return this.matrix
    }
  }

  // No parent: the world delta applies to x/y unchanged.
  const loose = centredRect({ x: 10, y: 20 })
  const moved = draggedPosition(loose, 10, 20, { x: 0, y: 0 }, { x: 5, y: -3 })
  assert(near(moved.x, 15) && near(moved.y, 17), 'an unparented node takes the world delta directly')

  // A parent's TRANSLATION must not leak into the delta - it's a direction, not a point.
  // (Getting this wrong would fling the node by the parent's offset on the first move.)
  const translated = new TransformGroup()
  translated.matrix = Matrix4x4.translation(new Vector3(1000, -500, 0))
  const inTranslated = translated.addChild(centredRect({ x: 0, y: 0 }))
  const t = draggedPosition(inTranslated, 0, 0, { x: 0, y: 0 }, { x: 5, y: -3 })
  assert(near(t.x, 5) && near(t.y, -3), "a parent's translation does not offset the drag delta")

  // A parent's SCALE divides the world delta: 2x parent means 10 world units of drag is
  // only 5 units in the child's own coordinates.
  const scaled = new TransformGroup()
  scaled.matrix = Matrix4x4.scaling(new Vector3(2, 2, 1))
  const inScaled = scaled.addChild(centredRect({ x: 0, y: 0 }))
  const s = draggedPosition(inScaled, 0, 0, { x: 0, y: 0 }, { x: 10, y: 10 })
  assert(near(s.x, 5) && near(s.y, 5), "a parent's scale divides the drag delta")

  // A Y-flipping parent (what the SVG loader's root matrix does) inverts dy: dragging
  // the pointer UP in world space must still move the node up on screen.
  const flipped = new TransformGroup()
  flipped.matrix = Matrix4x4.scaling(new Vector3(1, -1, 1))
  const inFlipped = flipped.addChild(centredRect({ x: 0, y: 0 }))
  const f = draggedPosition(inFlipped, 0, 0, { x: 0, y: 0 }, { x: 4, y: 10 })
  assert(near(f.x, 4) && near(f.y, -10), "a parent's Y flip inverts the drag delta's y")

  // The invariant that actually matters, under a combined translate+rotate+scale parent:
  // applying the result moves the node by EXACTLY the world-space drag delta, which is
  // what keeps the grabbed point of the shape under the pointer.
  const gnarly = new TransformGroup()
  gnarly.matrix = Matrix4x4.translation(new Vector3(30, -15, 0))
    .mul(Matrix4x4.rotationZ(0.9))
    .mul(Matrix4x4.scaling(new Vector3(1.7, 0.4, 1)))
  const child = gnarly.addChild(centredRect({ x: 7, y: -2 }))
  const origin = new Vector3(0, 0, 0)

  const worldBefore = child.worldMatrix().transformPoint(origin)
  const anchor = { x: 3, y: 4 }
  const dragged = draggedPosition(child, child.x, child.y, anchor, { x: anchor.x + 12, y: anchor.y - 5 })
  child.x = dragged.x
  child.y = dragged.y
  const worldAfter = child.worldMatrix().transformPoint(origin)
  assert(
    near(worldAfter.x - worldBefore.x, 12) && near(worldAfter.y - worldBefore.y, -5),
    'the node moves by exactly the world drag delta, whatever its parent transform',
  )

  // Resolved from the fixed drag-start values, never accumulated: dragging the pointer
  // through a long path of intermediate positions (each one applied to the node, as a
  // real pointermove stream would) must land exactly where a single jump to the final
  // position would - i.e. the world offset still equals the total pointer delta, with no
  // drift accumulated across the steps.
  const dragStart = { x: child.x, y: child.y }
  const beforeStepping = child.worldMatrix().transformPoint(origin)
  const path = [
    { x: 6, y: 2 },
    { x: 19, y: -8 },
    { x: 33, y: 17 },
    { x: 40, y: 25 },
  ]
  for (const step of path) {
    const mid = draggedPosition(child, dragStart.x, dragStart.y, anchor, {
      x: anchor.x + step.x,
      y: anchor.y + step.y,
    })
    child.x = mid.x
    child.y = mid.y
  }
  const afterStepping = child.worldMatrix().transformPoint(origin)
  const total = path[path.length - 1]
  assert(
    near(afterStepping.x - beforeStepping.x, total.x) && near(afterStepping.y - beforeStepping.y, total.y),
    'a stepped drag lands exactly on the total pointer delta - no accumulated drift',
  )
}

// --- draggable: on by default (a drag only ever reaches a pickable node), opt-out per node ---
{
  assert(centredRect().draggable, 'a shape is draggable by default')
  assert(!centredRect({ draggable: false }).draggable, 'draggable can be turned off per node')
}


// --- resolving a press: a transformer handle is not the shape behind it -----------------
//
// Reproduces the reported failure directly. A circle is selected and its rotate handle is
// pressed; the handle happens to sit over an image stacked behind it. The press must belong
// to the handle, so nothing about the selection may change - if the press were reported
// against the shape behind it first, an application that selects on press would swap the
// selection out from under the gesture, and since the frame is refit once a frame rather
// than on attach, the newly selected shape would then be rotated about the OLD selection's
// centre.
{
  // A canvas stand-in: the dispatcher only ever adds listeners, captures the pointer, and
  // sets a cursor on it, and its own coordinates are already client coordinates here.
  const listeners = new Map<string, (e: never) => void>()
  const canvas = {
    addEventListener: (type: string, fn: (e: never) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    style: { cursor: '' },
  }

  const root = new Container()
  const circle = new Circle({ name: 'circle', x: 0, y: 0, radius: 40 })
  const behind = centredRect({ name: 'behind', x: 0, y: 0, width: 400, height: 400 })
  root.addChild(behind)
  root.addChild(circle)

  const transformer = new Transformer()
  root.addChild(transformer)
  transformer.attach([circle])
  // What the renderer does once a frame: fit the frame around the selection.
  const box = { cx: 0, cy: 0, halfW: 40, halfH: 40, rotation: 0 }
  transformer.update(box, 1)

  const rotateAnchor = { x: 0, y: 76 } // above the top edge, where the rotate handle sits
  assert(transformer.anchorAt(rotateAnchor.x, rotateAnchor.y) === 'rotate', 'the rotate handle is where the test presses')

  resetListenerCensus()
  const dispatcher = new SceneInputDispatcher(canvas as unknown as HTMLCanvasElement, {
    root,
    // Everything under the pointer is the shape stacked behind - the situation that made
    // the failure visible.
    pick: () => behind,
    toWorld: (x, y) => new Vector2(x, y),
    transformer,
  })

  const presses: string[] = []
  root.on('pointerdown', (e) => {
    presses.push((e.target as { name?: string }).name ?? 'root')
    // The ordinary application policy: a press selects what it landed on.
    const hit = e.target as Shape
    if (hit !== (root as unknown as Shape)) transformer.attach([hit])
  })

  const press = (type: string, x: number, y: number) =>
    listeners.get(type)?.({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y, shiftKey: false, altKey: false, preventDefault: () => {}, type } as never)

  press('pointerdown', rotateAnchor.x, rotateAnchor.y)
  assert(presses.length === 0, 'pressing a handle reports no press against the shape behind it')
  assert(transformer.nodes.length === 1 && transformer.nodes[0] === circle, 'so the selection is left exactly as it was')

  // And the gesture that follows transforms what was selected, about its own centre.
  press('pointermove', 76, 0) // a quarter turn round the box centre
  assert(transformer.nodes[0] === circle, 'the rotation stays on the selected node')
  assert(Math.abs(circle.rotation) > 0.5, 'which really did rotate')
  assert(near(behind.rotation, 0), 'and the shape behind was not touched')

  press('pointerup', 76, 0)
  assert(presses.length === 0, 'releasing a handle is not a press or a click on anything either')

  // A press that is NOT on a handle still reports normally - the fix must not swallow the
  // ordinary case it sits in front of.
  press('pointerdown', 200, 200)
  assert(presses.length === 1 && presses[0] === 'behind', 'a press away from the handles reports as usual')
  press('pointerup', 200, 200)
  dispatcher.destroy()
  resetListenerCensus()
}

console.log(`[input] self-test passed (${count} assertions)`)
