// The polyline scene, checked as geometry rather than looked at.
//
// Most of what it demonstrates is a picture and belongs on screen. Four of its claims are not.
// A spline that missed the points it was drawn through, a ring that filled nothing, a bounding
// box that no longer matched what the shape measures - each would read on screen as a design
// choice rather than as the mistake it is. Those are pinned here.

import { expect, it } from 'vitest'
import { Circle, Polyline, Rect, Scene } from '@mvpaint/engine'
import { buildPolylineScene } from './polylineScene'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps

function built() {
  const scene = new Scene()
  const content = buildPolylineScene(scene)
  const find = <T>(name: string): T => {
    const node = scene.root.findOne(`.${name}`)
    if (!node) throw new Error(`the scene has no node named '${name}'`)
    return node as T
  }
  return { scene, content, find }
}

/** The middle three of the five points every curve in the first section is drawn through. */
const THROUGH = [
  { x: -395, y: -126 },
  { x: -280, y: -196 },
  { x: -165, y: -196 },
]

it('every tension still lands on the points it was drawn through', () => {
  // The claim the section is built to make, and the one that would go unnoticed: a spline that
  // merely passed NEAR its points would look like a curve either way.
  const { find } = built()
  for (const i of [0, 1, 2, 3]) {
    const outline = find<Polyline>(`tension-${i}`).outline()
    for (const point of THROUGH) {
      assert(
        outline.some((p) => p.x === point.x && p.y === point.y),
        `tension-${i} passes exactly through (${point.x}, ${point.y})`,
      )
    }
  }
})

it('a tension above 1 leans further into the turns than the points do', () => {
  // The five points span 70 units vertically. The straight reading is exactly that band; the
  // overshooting one has to be outside it, or the crimson line is drawing the same picture as
  // the navy one and the legend is lying.
  const { find } = built()
  assert(near(find<Polyline>('tension-0').height, 70), 'the straight reading is the point band itself')
  assert(find<Polyline>('tension-2').height > 70, 'the uniform spline already reaches past it')
  assert(
    find<Polyline>('tension-3').height > find<Polyline>('tension-2').height,
    'and 1.5 reaches further still',
  )
})

it('a closed ring has an interior; an open curve does not', () => {
  const { find } = built()
  assert(find<Polyline>('ring-plain').hitTestLocal(-420, 160), 'the heptagon is hit at its centre')
  assert(find<Polyline>('ring-smooth').hitTestLocal(-250, 160), 'so is the spline through it')

  // Inside the arch of the bezier curve, which is open: there is nothing there to hit.
  const curve = find<Polyline>('bezier-curve')
  assert(!curve.hitTestLocal(155, -150), 'the middle of an open arch is empty')
  // The first cubic's midpoint: (y0 + 3y1 + 3y2 + y3) / 8 = -170, at x = 155.
  assert(curve.hitTestLocal(155, -170), 'while the curve itself, at the top of the same arch, is not')
})

it('the box is drawn from what the curve measures', () => {
  // Two independent claims that have to agree: the shape's width/height are the extent of the
  // outline it draws, and the hairline box is drawn from those two numbers rather than from the
  // points the curve was built from.
  const { find } = built()
  const curve = find<Polyline>('measured-curve')
  const box = find<Rect>('measured-box')
  const outline = curve.outline()
  const width = Math.max(...outline.map((p) => p.x)) - Math.min(...outline.map((p) => p.x))
  const height = Math.max(...outline.map((p) => p.y)) - Math.min(...outline.map((p) => p.y))

  assert(near(curve.width, width) && near(curve.height, height), 'the curve measures its own outline')
  assert(near(box.width, curve.width) && near(box.height, curve.height), 'and the box is drawn from that')
  assert(box.height > 110, 'the spline reaches below the points, which is why the box is not the point band')
})

it('a frame carries the disc along the curve and re-tessellates the breathing ring', () => {
  const { content, find } = built()
  const traveller = find<Circle>('traveller')
  const breathing = find<Polyline>('ring-breathing')
  const version = breathing.geometryVersion

  content.onFrame?.(0.5, 1)
  assert(traveller.x >= 70 && traveller.x <= 450, 'the disc is somewhere along the curve')
  assert(traveller.y >= 150 && traveller.y <= 280, 'and not off it')
  assert(breathing.geometryVersion > version, 'an animated tension is a rebuild per frame')
})
