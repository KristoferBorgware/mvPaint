// What the Fit buttons aim at, checked against a real scene graph.
//
// The flight itself is the engine's, and tested there. What is tested here is the application's
// two judgements - what counts as the scene, and how far a fit may magnify - because both are
// invisible when they go wrong: a fit that quietly included the selection frame would frame a
// slightly different box depending on what was selected, and a fit with no ceiling would fly
// into a small shape and look like a bug in the camera.

import { expect, it } from 'vitest'
import { Container, Group, Rect, Scene } from '@mvpaint/engine'
import { fitPlan, MAX_FIT_ZOOM, sceneContent, unionBounds, unionRect } from './cameraFlight'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

const VIEWPORT = { width: 980, height: 720 }
/** Nothing here draws text, so nothing here needs the atlas a text node would be measured in. */
const noText = () => null

it('measures the union of what it is given, in the space asked for', () => {
  const scene = new Scene()
  scene.root.addChild(new Rect({ x: -100, y: -50, width: 100, height: 50, strokeWidth: 0 }))
  scene.root.addChild(new Rect({ x: 200, y: 100, width: 60, height: 40, strokeWidth: 0 }))

  const box = unionBounds(scene.root.children, scene.root, noText)!
  assert(box.x === -100 && box.y === -50, 'the union starts at the top-left of the leftmost')
  assert(box.width === 360 && box.height === 190, 'and reaches the bottom-right of the furthest')
})

it('measures a nested node where it actually is, not where its parent thinks it is', () => {
  // A selected node is often inside a group, so its own client rect is in the group's space.
  // Framing it in that space would aim the camera at wherever the group's transform happened
  // to put the origin.
  const scene = new Scene()
  const group = scene.root.addChild(new Group({ x: 500, y: 300, scaleX: 2, scaleY: 2 }))
  const child = group.addChild(new Rect({ x: 10, y: 10, width: 50, height: 50, strokeWidth: 0 }))

  const box = unionBounds([child], scene.root, noText)!
  assert(box.x === 520 && box.y === 320, 'the group transform is composed in')
  assert(box.width === 100 && box.height === 100, 'including its scale')
})

it('leaves out editor furniture and anything hidden', () => {
  const scene = new Scene()
  scene.root.addChild(new Rect({ x: 0, y: 0, width: 100, height: 100, strokeWidth: 0 }))
  // Stands in for the selection frame and the debug overlay: in the same root, miles away, and
  // not part of the drawing.
  const frame = scene.root.addChild(new Container())
  frame.addChild(new Rect({ x: 9000, y: 9000, width: 10, height: 10, strokeWidth: 0 }))
  const hidden = scene.root.addChild(new Rect({ x: -9000, y: 0, width: 10, height: 10, visible: false }))

  const content = sceneContent(scene.root.children, new Set([frame]))
  assert(!content.includes(frame), 'furniture is not content')
  assert(content.includes(hidden), 'but a hidden node is - it is the measuring that skips it')

  const box = unionBounds(content, scene.root, noText)!
  assert(box.width === 100 && box.height === 100, 'so neither reaches the box that gets framed')
})

it('reports nothing to frame for an empty scene', () => {
  const scene = new Scene()
  assert(unionBounds(scene.root.children, scene.root, noText) === null, 'an empty scene has no box')
  // Which is what the button reads to do nothing at all, rather than flying somewhere arbitrary.
  assert(unionBounds([], scene.root, noText) === null, 'and neither does an empty selection')
})

it('fits a box by whichever axis is tighter, with room left around it', () => {
  // 980x720 of viewport, 48 off every side: 884 x 624 to fill.
  const plan = fitPlan({ x: 0, y: 0, width: 884, height: 100 }, VIEWPORT)
  assert(near(plan.zoom!, 1), 'a box exactly the width of the padded viewport fits at 1x')
  assert(plan.center.x === 442 && plan.center.y === 50, 'centred on the box')
  assert(plan.rotation === 0, 'and upright, since the fit was solved for an unturned viewport')

  const tall = fitPlan({ x: 0, y: 0, width: 100, height: 1248 }, VIEWPORT)
  assert(near(tall.zoom!, 0.5), 'a box twice the padded height fits at half')
})

it('will not fly into a small shape', () => {
  // Arithmetically this asks for 884x - which is right, and not what anybody pressing the
  // button meant.
  const plan = fitPlan({ x: 0, y: 0, width: 1, height: 1 }, VIEWPORT)
  assert(plan.zoom === MAX_FIT_ZOOM, `the magnification is capped (got ${plan.zoom})`)
  assert(plan.center.x === 0.5, 'and it still centres on what was asked for')
})

it('asks for no zoom at all when what it framed has no size', () => {
  // A zoom of Infinity is the honest arithmetic answer and a useless one. Absent means the
  // flight moves the centre and leaves the zoom where the user had it.
  const plan = fitPlan({ x: 40, y: 60, width: 0, height: 0 }, VIEWPORT)
  assert(plan.zoom === undefined, 'a point names no scale')
  assert(plan.center.x === 40 && plan.center.y === 60, 'but still says where to look')
})

it('unions two boxes into the one that covers both', () => {
  const box = unionRect({ x: 0, y: 0, width: 10, height: 10 }, { x: -5, y: 20, width: 10, height: 10 })
  assert(box.x === -5 && box.y === 0, 'top-left of the pair')
  assert(box.width === 15 && box.height === 30, 'and far enough to reach both bottom-rights')
})
