// Animating a camera: the two ways of saying where it should end up, and what each one does
// on the way there.
//
// The claims worth pinning are all about the PATH rather than the ends. Anything that moves a
// camera arrives eventually; what separates a flight that reads as a steady approach from one
// that lurches is what it did in the middle, and none of that shows in a final value.

import { expect, it } from 'vitest'
import { Camera2D } from './Camera2D'
import { cameraTween, viewForBounds, zoomCameraAbout } from './cameraTween'
import { AABB } from '../math/AABB'
import { Vector3 } from '../math/Vector3'
import { screenToWorld } from '../input/viewport'
import { TweenTicker } from '../tween/ticker'
import { Easings } from '../tween/easings'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

const VIEWPORT = { width: 800, height: 600 }

/** A ticker nothing else is stepping, so one test's frames are not another's. */
function ticker(): TweenTicker {
  const t = new TweenTicker()
  t.autoDrive = false
  return t
}

it('a camera is an ordinary tween target', () => {
  // The seam, not the camera maths: four attributes, read and written by name.
  const camera = new Camera2D()
  assert([...camera.attributeNames()].join() === 'x,y,zoom,rotation', 'it declares its four fields')
  assert(camera.getAttr('zoom') === 1, 'and reads them')
  camera.setAttr('zoom', 3)
  assert(camera.zoom === 3, 'and writes them')

  const clock = ticker()
  camera.to({ ticker: clock, duration: 1, x: 100, y: 50 })
  clock.advance(500)
  assert(camera.x === 50 && camera.y === 25, 'so camera.to() moves the fields like any other attribute')
})

it('refuses an attribute a camera does not have', () => {
  const camera = new Camera2D()
  expect(() => camera.to({ ticker: ticker(), scale: 2 })).toThrow(/Camera2D has no attribute 'scale'/)
})

it('a view tween moves the centre, not the corner', () => {
  // The distinction the module exists for. Holding a CORNER still while the zoom changes slides
  // the content sideways, because the view rectangle grows from that corner - so a flight that
  // only meant to zoom in would drift. The centre is what a caller means by where it is looking.
  const camera = new Camera2D({ zoom: 1 })
  camera.centerOn(0, 0, VIEWPORT.width, VIEWPORT.height)
  const clock = ticker()

  cameraTween(camera, VIEWPORT, { ticker: clock, duration: 1, zoom: 4 }).play()
  for (let i = 0; i < 10; i++) {
    clock.advance(100)
    const centre = camera.center(VIEWPORT.width, VIEWPORT.height)
    assert(near(centre.x, 0, 1e-4) && near(centre.y, 0, 1e-4), 'the centre never moves during a pure zoom')
  }
  assert(near(camera.zoom, 4, 1e-4), 'and it arrives at the zoom asked for')
})

it('the zoom travels geometrically, so each moment magnifies by the same ratio', () => {
  // 1 to 16 in four steps. Linearly, the halfway point is 8.5 - seven eighths of the way to the
  // eye - and the first half of the animation would do almost all of the visible work. Through
  // the logarithm the halfway point is 4, and each quarter multiplies by 2.
  const camera = new Camera2D({ zoom: 1 })
  const clock = ticker()
  cameraTween(camera, VIEWPORT, { ticker: clock, duration: 1, zoom: 16 }).play()

  const seen: number[] = []
  for (let i = 0; i < 4; i++) {
    clock.advance(250)
    seen.push(camera.zoom)
  }
  assert(near(seen[0], 2, 1e-4), `a quarter of the way is x2, not x4.75 (got ${seen[0]})`)
  assert(near(seen[1], 4, 1e-4), `halfway is x4, not x8.5 (got ${seen[1]})`)
  assert(near(seen[2], 8, 1e-4), `three quarters is x8 (got ${seen[2]})`)
  assert(near(seen[3], 16, 1e-4), 'and it lands on what was asked for')

  // Which is the same as saying every step multiplies by the same amount.
  const ratios = seen.map((z, i) => z / (i === 0 ? 1 : seen[i - 1]))
  for (const ratio of ratios) assert(near(ratio, 2, 1e-4), 'every quarter multiplies the zoom equally')
})

it('an overshooting curve cannot drive the zoom through zero', () => {
  // A linear tween of the field can: Back pulls under the start before setting off, and a zoom
  // at or below zero is a view with no size. Two raised to anything is positive.
  const camera = new Camera2D({ zoom: 2 })
  const clock = ticker()
  cameraTween(camera, VIEWPORT, { ticker: clock, duration: 1, easing: Easings.BackEaseIn, zoom: 8 }).play()

  for (let i = 0; i < 20; i++) {
    clock.advance(50)
    assert(camera.zoom > 0, `zoom stays positive (got ${camera.zoom})`)
    assert(Number.isFinite(camera.viewSize(VIEWPORT.width, VIEWPORT.height).width), 'and the view stays finite')
  }
})

/**
 * How far the content moves across the VIEW between two frames: the world-space step the centre
 * took, in the screen units it took it at. This is the number an eye reads as pan speed, and
 * the one a flight has to hold steady for its pan and its zoom to look like one movement.
 */
function screenSteps(samples: readonly { center: { x: number; y: number }; zoom: number }[]): number[] {
  const steps: number[] = []
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    const scale = (a.zoom + b.zoom) / 2
    steps.push(Math.hypot(b.center.x - a.center.x, b.center.y - a.center.y) * scale)
  }
  return steps
}

function flightSamples(camera: Camera2D, clock: TweenTicker, frames: number, ms: number) {
  const samples = [{ center: { ...camera.center(VIEWPORT.width, VIEWPORT.height) }, zoom: camera.zoom }]
  for (let i = 0; i < frames; i++) {
    clock.advance(ms)
    samples.push({ center: { ...camera.center(VIEWPORT.width, VIEWPORT.height) }, zoom: camera.zoom })
  }
  return samples
}

it('pans and zooms as one movement rather than one after the other', () => {
  // The failure this is here for reads as "it zooms first and pans afterwards". Screen pan speed
  // is the world-space speed times the zoom, so a centre travelling at a steady world rate under
  // a zoom going eightfold crosses the view eight times faster at the end than at the start -
  // and the eye reads the slow part as no pan at all.
  const camera = new Camera2D({ zoom: 1 })
  camera.centerOn(0, 0, VIEWPORT.width, VIEWPORT.height)
  const clock = ticker()

  cameraTween(camera, VIEWPORT, { ticker: clock, duration: 1, center: { x: 1000, y: 0 }, zoom: 8 }).play()
  const steps = screenSteps(flightSamples(camera, clock, 20, 50))

  const fastest = Math.max(...steps)
  const slowest = Math.min(...steps)
  assert(fastest / slowest < 1.05, `every frame crosses the view by the same amount (${fastest / slowest})`)
})

it('and gets to the same place, by the same line', () => {
  // Only the timing along the path differs between the two spaces. The path itself is the same
  // straight line, and both ends of it are exact.
  const clock = ticker()
  const screen = new Camera2D({ zoom: 1 })
  screen.centerOn(0, 0, VIEWPORT.width, VIEWPORT.height)
  const world = new Camera2D({ zoom: 1 })
  world.centerOn(0, 0, VIEWPORT.width, VIEWPORT.height)

  cameraTween(screen, VIEWPORT, { ticker: clock, duration: 1, center: { x: 600, y: 300 }, zoom: 8 }).play()
  cameraTween(world, VIEWPORT, { ticker: clock, duration: 1, center: { x: 600, y: 300 }, zoom: 8, pan: 'world' }).play()

  for (let i = 0; i < 10; i++) {
    clock.advance(50)
    const a = screen.center(VIEWPORT.width, VIEWPORT.height)
    const b = world.center(VIEWPORT.width, VIEWPORT.height)
    // Both are somewhere on the line from (0,0) to (600,300), which is y = x / 2.
    assert(near(a.y, a.x / 2, 1e-6) && near(b.y, b.x / 2, 1e-6), 'both stay on the straight line between the ends')
    assert(a.x > b.x, 'and the screen-uniform one is always further along it, having front-loaded the pan')
  }

  clock.advance(600)
  for (const camera of [screen, world]) {
    const centre = camera.center(VIEWPORT.width, VIEWPORT.height)
    assert(near(centre.x, 600, 1e-4) && near(centre.y, 300, 1e-4), 'and both land exactly')
    assert(near(camera.zoom, 8, 1e-4), 'at the zoom asked for')
  }
})

it('a world-space pan is the motion that reads as two movements', () => {
  // The control for the test above: the same flight, panned at a steady world rate, varies its
  // screen speed by very nearly the whole zoom ratio.
  const camera = new Camera2D({ zoom: 1 })
  camera.centerOn(0, 0, VIEWPORT.width, VIEWPORT.height)
  const clock = ticker()

  cameraTween(camera, VIEWPORT, {
    ticker: clock,
    duration: 1,
    center: { x: 1000, y: 0 },
    zoom: 8,
    pan: 'world',
  }).play()
  const steps = screenSteps(flightSamples(camera, clock, 20, 50))

  const ratio = Math.max(...steps) / Math.min(...steps)
  assert(ratio > 6, `the end crosses the view far faster than the start (${ratio.toFixed(1)}x)`)
})

it('pans in a straight line when the zoom does not move at all', () => {
  // With nothing for the centre to follow, the two spaces are the same thing, and the centre is
  // an ordinary tracked attribute again.
  const camera = new Camera2D({ zoom: 2 })
  camera.centerOn(0, 0, VIEWPORT.width, VIEWPORT.height)
  const clock = ticker()

  const tween = cameraTween(camera, VIEWPORT, { ticker: clock, duration: 1, center: { x: 400, y: 0 } })
  assert(tween.attributes.includes('centerX'), 'the centre is tracked rather than derived')
  tween.play()
  clock.advance(500)
  assert(near(camera.center(VIEWPORT.width, VIEWPORT.height).x, 200, 1e-4), 'and moves at a steady rate')
})

it('a second flight takes the view off the first', () => {
  // Ownership is per target, and every view tween on one camera shares a target - so
  // interrupting a flight halfway is a new flight from where the camera got to, not two tweens
  // writing the camera on alternate lines of the same frame.
  const camera = new Camera2D({ zoom: 1 })
  camera.centerOn(0, 0, VIEWPORT.width, VIEWPORT.height)
  const clock = ticker()

  const first = cameraTween(camera, VIEWPORT, { ticker: clock, duration: 1, center: { x: 1000, y: 0 } })
  first.play()
  clock.advance(500)
  const interrupted = camera.center(VIEWPORT.width, VIEWPORT.height)
  assert(near(interrupted.x, 500, 1e-4), 'halfway across')

  cameraTween(camera, VIEWPORT, { ticker: clock, duration: 1, center: { x: 0, y: 0 } }).play()
  assert(first.attributes.length === 0, 'the first tween has nothing left to write')

  clock.advance(500)
  const back = camera.center(VIEWPORT.width, VIEWPORT.height)
  assert(near(back.x, 250, 1e-4), 'and the new one carries on from where the camera actually was')
})

it('framing a box gives the centre and the zoom that fit it', () => {
  const view = viewForBounds({ x: 100, y: 100, width: 400, height: 200 }, VIEWPORT)
  assert(view.center.x === 300 && view.center.y === 200, 'centred on the box')
  // 800/400 = 2 across, 600/200 = 3 down; the tighter axis wins or the box would not fit.
  assert(view.zoom === 2, 'and zoomed by whichever axis is tighter')

  const padded = viewForBounds({ x: 0, y: 0, width: 400, height: 200 }, VIEWPORT, 100)
  assert(padded.zoom === 1.5, 'padding is viewport pixels off every side: 600/400')

  // A point has no extent, so it names no scale - and says so rather than inventing one.
  const point = viewForBounds({ x: 5, y: 7, width: 0, height: 0 }, VIEWPORT)
  assert(point.zoom === undefined, 'a box with no size asks for no zoom')
  assert(point.center.x === 5 && point.center.y === 7, 'but still says where to look')
})

it('an AABB frames the same as the rectangle it describes', () => {
  // Both spellings arrive: getClientRect() hands back x/y/width/height, and localBoundsOf() and
  // viewBounds() hand back an AABB.
  const box = viewForBounds({ x: -50, y: -50, width: 100, height: 100 }, VIEWPORT)
  const aabb = viewForBounds(new AABB(new Vector3(-50, -50, 0), new Vector3(50, 50, 0)), VIEWPORT)
  assert(box.zoom === aabb.zoom && box.center.x === aabb.center.x, 'and describe the same view')
})

it('zooming about a pixel holds that pixel on the same world point the whole way', () => {
  // Not only at the ends. A flight between two views passes through whatever lies between them,
  // and for a zoom aimed at the cursor what lies between has to keep the cursor over the same
  // thing, or the content slides under the pointer and comes back.
  const camera = new Camera2D({ zoom: 1 })
  const clock = ticker()
  const pixel = { x: 200, y: 150 }
  const held = screenToWorld(camera, pixel.x, pixel.y, VIEWPORT)!

  zoomCameraAbout(camera, VIEWPORT, pixel.x, pixel.y, 6, { ticker: clock, duration: 1 }).play()

  for (let i = 0; i < 12; i++) {
    clock.advance(100)
    const under = screenToWorld(camera, pixel.x, pixel.y, VIEWPORT)!
    assert(
      Math.abs(under.x - held.x) < 0.01 && Math.abs(under.y - held.y) < 0.01,
      `the world point under the pixel never moves (off by ${(under.x - held.x).toFixed(4)})`,
    )
  }
  assert(near(camera.zoom, 6, 1e-4), 'and the zoom arrives')
})

it('a view tween reads the viewport each frame, so a resize mid-flight is followed', () => {
  const size = { width: 800, height: 600 }
  const camera = new Camera2D({ zoom: 1 })
  camera.centerOn(0, 0, size.width, size.height)
  const clock = ticker()

  cameraTween(camera, () => size, { ticker: clock, duration: 1, center: { x: 400, y: 0 } }).play()
  clock.advance(500)

  size.width = 400
  size.height = 300
  clock.advance(250)
  const centre = camera.center(size.width, size.height)
  assert(near(centre.x, 300, 1e-4), 'the centre is still the centre of the viewport it is now drawn at')
})
