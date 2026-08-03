// Self-test for Camera2D: where a default camera puts the world, what zoom and rotation do
// to that, and that screen->world really is the inverse of what the projection shows.
// No GPU - the camera is plain matrix math. Run with:
//   npx vitest run packages/engine/src/camera/camera.test.ts

import { expect, it } from 'vitest'
import type { Vector2Like } from '../math/Vector2'
import { Camera2D } from './Camera2D'
import { Vector3 } from '../math/Vector3'
import { Vector4 } from '../math/Vector4'
import { screenToWorld } from '../input/viewport'
import { panToAnchor, zoomToward } from '../input/cameraControls'

/**
 * Every check in this file goes through here, so each one reads as the sentence it is making
 * and vitest reports that sentence when it stops being true.
 */
function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}
// Matrix4x4 stores float32, so the achievable precision is RELATIVE: an "exactly zero" NDC
// coordinate comes back as a few times 1e-8, and a world coordinate in the hundreds is off
// by a few times 1e-5. Scaling the tolerance by magnitude is what makes one comparison
// usable for both; an absolute epsilon would be either too loose near zero or unmeetable
// out at the edges of a view.
const near = (a: number, b: number, eps = 1e-5) =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b))

const W = 800
const H = 600
const viewport = { width: W, height: H }

/** Where a world point lands in clip space, as NDC (x,y in [-1,1], y UP). */
function toNdc(camera: Camera2D, wx: number, wy: number): Vector2Like {
  const h = camera.viewProjection(W, H).transformVector4(new Vector4(wx, wy, 0, 1))
  return { x: h.x / h.w, y: h.y / h.w }
}

//
// This is what a scene renders through when the application supplies no camera at all, so
// it is worth pinning exactly rather than describing.
it('the default camera: world (0,0) at the top-left corner, one unit per pixel', () => {
    const camera = new Camera2D()
    assert(
      camera.x === 0 && camera.y === 0 && camera.zoom === 1 && camera.rotation === 0,
      'a default camera is at the origin, unzoomed and unturned',
    )

    // NDC (-1, 1) IS the top-left corner. World (0,0) must land exactly there.
    const corner = toNdc(camera, 0, 0)
    assert(near(corner.x, -1) && near(corner.y, 1), 'world (0,0) renders at the viewport top-left')

    // One world unit per pixel: the far corner of the viewport is (W, -H), the scene being
    // y-up, so the view hangs DOWNWARD from its origin exactly as a Rect does.
    const far = toNdc(camera, W, -H)
    assert(near(far.x, 1) && near(far.y, -1), 'world (width, -height) renders at the bottom-right')

    const bounds = camera.viewBounds(W, H)
    assert(near(bounds.min.x, 0) && near(bounds.max.x, W), 'the visible world spans [0, width] in x')
    assert(near(bounds.max.y, 0) && near(bounds.min.y, -H), 'and [-height, 0] in y')
})

it('zoom is pixels per world unit, anchored at the same top-left corner', () => {
    const camera = new Camera2D({ zoom: 2 })
    const corner = toNdc(camera, 0, 0)
    assert(near(corner.x, -1) && near(corner.y, 1), 'zooming does not move the corner the camera is anchored at')
    // At 2 px per unit the viewport covers half as much world.
    const far = toNdc(camera, W / 2, -H / 2)
    assert(near(far.x, 1) && near(far.y, -1), 'twice the zoom shows half the world')
    const size = camera.viewSize(W, H)
    assert(near(size.width, W / 2) && near(size.height, H / 2), 'viewSize reports the world rectangle, not the pixel one')

    camera.zoom = 0.5
    assert(near(camera.viewSize(W, H).width, W * 2), 'half the zoom shows twice the world')
})

it('x/y move the view: the camera\'s own position is the world at the corner', () => {
    const camera = new Camera2D({ x: 100, y: -40 })
    const corner = toNdc(camera, 100, -40)
    assert(near(corner.x, -1) && near(corner.y, 1), 'the camera position is by definition what sits at the top-left')
    assert(toNdc(camera, 0, 0).x < -1, 'so the world origin is now off the left edge')

    const centre = camera.center(W, H)
    assert(near(centre.x, 100 + W / 2) && near(centre.y, -40 - H / 2), 'the centre is half a viewport in and down from there')
    const middle = toNdc(camera, centre.x, centre.y)
    assert(near(middle.x, 0) && near(middle.y, 0), 'and it renders dead centre')

    camera.centerOn(500, 500, W, H)
    const recentred = toNdc(camera, 500, 500)
    assert(near(recentred.x, 0) && near(recentred.y, 0), 'centerOn puts the given world point in the middle')
})

it('rotation turns what you see counter-clockwise, about the view centre', () => {
    const camera = new Camera2D()
    const c = camera.center(W, H)

    // A point one unit to the RIGHT of the centre. Turning the view a quarter turn
    // counter-clockwise must carry it to directly ABOVE the centre, i.e. NDC +y. The
    // viewport is not square, so compare against the centre rather than expecting +1.
    camera.rotation = Math.PI / 2
    const turned = toNdc(camera, c.x + 1, c.y)
    assert(near(turned.x, 0), 'a quarter turn puts a point right of centre onto the vertical axis')
    assert(turned.y > 0, 'above the centre, not below - positive rotation turns the scene counter-clockwise')

    // The centre itself is the pivot, so it does not move however far the view is turned.
    for (const angle of [0.3, 1.1, -2.4, Math.PI]) {
      camera.rotation = angle
      const middle = toNdc(camera, c.x, c.y)
      assert(near(middle.x, 0) && near(middle.y, 0), 'the view centre is the pivot, at every angle')
    }

    // A turned view covers a bigger axis-aligned box than an unturned one - the corners of
    // the rotated rectangle reach further out.
    camera.rotation = Math.PI / 4
    const turnedBounds = camera.viewBounds(W, H)
    const flat = new Camera2D().viewBounds(W, H)
    assert(turnedBounds.max.x > flat.max.x, 'cull bounds grow to cover a turned view')
    assert(near((turnedBounds.min.x + turnedBounds.max.x) / 2, c.x), 'still centred on the same point')
})

it('screen <-> world round-trips, which is what picking and dragging rely on', () => {
    for (const camera of [
      new Camera2D(),
      new Camera2D({ x: -320, y: 210, zoom: 2.5 }),
      new Camera2D({ x: 77, y: -13, zoom: 0.4, rotation: 0.9 }),
    ]) {
      const c = camera.center(W, H)
      const atMiddle = screenToWorld(camera, W / 2, H / 2, viewport)!
      assert(near(atMiddle.x, c.x) && near(atMiddle.y, c.y), 'the middle pixel is the view centre, turned or not')

      // Round-trip: a world point projected to NDC, back to a pixel, and unprojected again.
      for (const [wx, wy] of [
        [c.x + 37, c.y - 12],
        [c.x - 400, c.y + 250],
        [c.x, c.y],
      ]) {
        const ndc = toNdc(camera, wx, wy)
        const px = ((ndc.x + 1) / 2) * W
        const py = ((1 - ndc.y) / 2) * H
        const back = screenToWorld(camera, px, py, viewport)!
        assert(near(back.x, wx) && near(back.y, wy), 'screenToWorld inverts the projection exactly')
      }
    }

    // On an UNTURNED view the top-left pixel is the camera position, by definition.
    const flat = new Camera2D({ x: -320, y: 210, zoom: 2.5 })
    const atCorner = screenToWorld(flat, 0, 0, viewport)!
    assert(near(atCorner.x, flat.x) && near(atCorner.y, flat.y), 'pixel (0,0) is the camera position')
})

//
// Asserted in PIXELS rather than world units, because that is what the guarantee is about:
// the content under the pointer must not visibly slide. A world-unit tolerance would have
// to be relative to be meetable at a zoomed-out view and absolute to mean anything near the
// origin, and a pixel measure is simply the right unit for the claim.
it('pan and zoom keep the grabbed world point under the pointer', () => {
    const camera = new Camera2D({ x: 10, y: 20, zoom: 1.5 })
    const HAIR = 0.01 // pixels - a hundredth of one, far below anything visible
    const samePixel = (a: Vector2Like, b: Vector2Like) =>
      Math.hypot(a.x - b.x, a.y - b.y) * camera.zoom < HAIR

    const anchor = screenToWorld(camera, 200, 150, viewport)!
    panToAnchor(camera, viewport, 640, 480, anchor)
    assert(samePixel(screenToWorld(camera, 640, 480, viewport)!, anchor), 'panToAnchor puts the world point under the pixel asked for')

    for (const nextZoom of [3, 0.25, 1]) {
      const under = screenToWorld(camera, 300, 100, viewport)!
      zoomToward(camera, viewport, 300, 100, nextZoom)
      assert(near(camera.zoom, nextZoom), 'the zoom is applied')
      assert(samePixel(screenToWorld(camera, 300, 100, viewport)!, under), 'and the world under that pixel never moved')
    }

    // The same holds on a turned view, which is where adjusting x/y arithmetically instead of
    // going through screenToWorld would send the content sliding off under the cursor.
    camera.rotation = 0.7
    const under = screenToWorld(camera, 120, 500, viewport)!
    zoomToward(camera, viewport, 120, 500, 2.2)
    assert(samePixel(screenToWorld(camera, 120, 500, viewport)!, under), 'zoom-toward holds on a turned view too')

    // And repeating it is stable rather than creeping - a drifting anchor would show up as
    // motion over many wheel steps even if one step looked fine.
    for (let i = 0; i < 20; i++) {
      const held = screenToWorld(camera, 120, 500, viewport)!
      zoomToward(camera, viewport, 120, 500, 2.2)
      assert(samePixel(screenToWorld(camera, 120, 500, viewport)!, held), 'twenty repeats never creep')
    }
})

it('a degenerate zoom cannot produce a degenerate matrix', () => {
    const camera = new Camera2D({ zoom: 0 })
    const size = camera.viewSize(W, H)
    assert(Number.isFinite(size.width) && size.width > 0, 'zoom 0 is clamped rather than dividing by zero')
    assert(camera.viewProjection(W, H).m.every((v) => Number.isFinite(v)), 'so the view-projection stays finite')
    assert(camera.viewBounds(W, H).valid(), 'and the cull bounds stay usable')
})

it('the camera is not in the scene, and holds no reference to it', () => {
    const camera = new Camera2D()
    assert(!('parent' in camera), 'a camera has no parent link - it is not a node')
    assert(!('children' in camera), 'and holds nothing')
    const keys = Object.keys(camera)
    assert(
      keys.every((k) => ['x', 'y', 'zoom', 'rotation', 'nearZ', 'farZ'].includes(k)),
      `a camera is only its own view parameters (has: ${keys.join(', ')})`,
    )
    // Two cameras over one scene is the point of it not being a node: they are independent.
    const a = new Camera2D({ zoom: 1 })
    const b = new Camera2D({ zoom: 4 })
    a.x = 999
    assert(b.x === 0, 'one camera moving never disturbs another')
    assert(!near(toNdc(a, 0, 0).x, toNdc(b, 0, 0).x), 'and the same world point projects differently through each')
})

it('world points sit on the Z=0 plane the 2D scene lives in', () => {
    const camera = new Camera2D({ x: 5, y: -5, zoom: 2, rotation: 0.4 })
    const ray = camera.screenPointToRay(123, 456, W, H)
    assert(Math.abs(ray.direction.z) > 0.9, 'the view ray looks along -Z, straight at the plane')
    const t = -ray.origin.z / ray.direction.z
    const hit = new Vector3(ray.origin.x + ray.direction.x * t, ray.origin.y + ray.direction.y * t, 0)
    const world = screenToWorld(camera, 123, 456, viewport)!
    assert(near(hit.x, world.x) && near(hit.y, world.y), 'screenToWorld is that ray meeting Z=0')
})
