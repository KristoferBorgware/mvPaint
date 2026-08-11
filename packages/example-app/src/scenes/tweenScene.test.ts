// The tween scene, checked as motion rather than looked at.
//
// Most of what a scene demonstrates is a picture. Four of this one's claims are not: they are
// statements about where the values got to after a given number of seconds, and each would fail
// on screen as something a reader would take for a design choice - a runner drifting off the
// curve it is drawn against, a morph collapsing to three points instead of eight, a chained
// hop quietly stopping after its first leg, an attribute that was supposed to change hands and
// did not. Those are pinned here.
//
// Everything below drives the scene the way the app does: `content.onFrame(dt, speed)`, which is
// what steps the ticker the scene owns.

import { expect, it } from 'vitest'
import { Circle, Polyline, Rect, Scene, type Node, type Vector2Like } from '@mvpaint/engine'
import { buildTweenScene } from './tweenScene'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}

function built() {
  const scene = new Scene()
  const content = buildTweenScene(scene)
  const find = <T>(name: string): T => {
    const node = scene.root.findOne(`.${name}`)
    if (!node) throw new Error(`the scene has no node named '${name}'`)
    return node as T
  }
  /** One frame of the size the app delivers, at the default speed. */
  const frame = (seconds: number): void => content.onFrame?.(seconds, 1)
  return { scene, content, find, frame }
}

/** The drawn curve's own y at an x, by walking the samples it was plotted from. */
function curveAt(curve: Polyline, x: number): number {
  const points = curve.points
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (x >= a.x && x <= b.x) return a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y)
  }
  return x <= points[0].x ? points[0].y : points[points.length - 1].y
}

const CURVE_NAMES = ['Linear', 'EaseInOut', 'BackEaseOut', 'ElasticEaseOut', 'BounceEaseInOut']

it('every runner stays on the curve it is drawn against', () => {
  // The claim the whole grid rests on. Each runner is two tweens on one node - x through Linear,
  // y through the cell's own curve - and they are only a picture of that curve while the two
  // stay in phase. The plot is sampled from the same easing, so a runner off the line means the
  // two tweens have drifted apart.
  const { find, frame } = built()

  for (const seconds of [0.37, 0.4, 0.51]) {
    frame(seconds)
    for (const name of CURVE_NAMES) {
      const runner = find<Circle>(`runner-${name}`)
      const curve = find<Polyline>(`curve-${name}`)
      const drawn = curveAt(curve, runner.x)
      // The plot is 48 straight segments across a curve, so the runner sits on the true curve
      // and the line it is checked against is the chord - a unit of slack covers that.
      assert(Math.abs(runner.y - drawn) < 1, `${name} runner is on its curve (${runner.y} vs ${drawn})`)
    }
  }
})

it('and stays on it through a turnaround', () => {
  // A yoyo turns around part-way through the frame that discovers the end, and the rest of that
  // frame is applied in the new direction. The two tweens of a runner therefore have to turn on
  // the same frame and by the same amount, or the pair comes back out of phase.
  const { find, frame } = built()

  // 1.6s is one traverse; this lands well past it, so every runner has bounced.
  frame(1.1)
  frame(1.3)
  for (const name of CURVE_NAMES) {
    const runner = find<Circle>(`runner-${name}`)
    const curve = find<Polyline>(`curve-${name}`)
    assert(Math.abs(runner.y - curveAt(curve, runner.x)) < 1, `${name} is on its curve after the bounce`)
  }
})

it('the morph is eight points from the first frame, and they start out on the zigzag', () => {
  // A points list of a different length runs through a resampled stand-in, so the line is eight
  // points from the moment the tween is played - and at position 0 those eight are still the
  // three-point zigzag, five of them sitting on segments they will later leave. A stand-in built
  // any other way (points at the origin, points repeated at one end) would show as a shape that
  // is not the zigzag before anything has moved.
  const { find, frame } = built()
  const morph = find<Polyline>('morph')

  assert(morph.points.length === 8, 'played at once, and resampled to the longer list')
  // The zigzag turns once, and none of the eight lands exactly on the corner - so the turn is
  // shared between the two triples that straddle it, and every other interior point is straight.
  assert(kinks(morph.points) <= 2, 'the eight lie on the zigzag, in two straight runs')

  // Half way: a real wave, which turns at nearly every point.
  frame(1.3)
  assert(morph.points.length === 8, 'it stays eight points while it runs')
  assert(kinks(morph.points) >= 4, 'and has become the wave')
})

/** How many of a path's interior points are corners rather than passing points. */
function kinks(points: readonly Vector2Like[]): number {
  let count = 0
  for (let i = 1; i + 1 < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const c = points[i + 1]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) > 1) count++
  }
  return count
}

it('the chained hop starts its next leg from the finish of the last', () => {
  // `to()` destroys itself at the finish, and the handler that starts the next leg runs after
  // it has done so - which is what lets the new tween claim x and y at all. A chain that stops
  // after one leg is what a claim that had not let go would look like.
  const { scene, frame } = built()
  const hopper = firstCircleNamed(scene, 11)
  const start = { x: hopper.x, y: hopper.y }

  // Each leg is 0.75s; three of them plus slack takes it round three corners.
  for (let i = 0; i < 40; i++) frame(1 / 30)
  assert(hopper.x !== start.x || hopper.y !== start.y, 'it left the first corner')

  // Round the whole square: four legs is 3s, and it is back where it began.
  const positions: Vector2Like[] = []
  for (let i = 0; i < 60; i++) {
    frame(1 / 30)
    positions.push({ x: hopper.x, y: hopper.y })
  }
  const moved = positions.filter((p, i) => i > 0 && (p.x !== positions[i - 1].x || p.y !== positions[i - 1].y))
  assert(moved.length > 50, 'and keeps moving leg after leg rather than stopping at one')
})

/** The hopper is the only Circle of its radius outside the curve grid, which names its runners. */
function firstCircleNamed(scene: Scene, radius: number): Circle {
  const found = scene.root.find((node: Node) => node instanceof Circle && node.radius === radius)
  if (found.length !== 1) throw new Error(`expected one circle of radius ${radius}, found ${found.length}`)
  return found[0] as Circle
}

it('one tween takes x off the other, and the first carries on with y', () => {
  // The ownership rule, made visible: the square keeps descending on the drift's y while its
  // horizontal motion belongs to somebody else. If the takeover had stopped the drift outright,
  // y would stand still from that moment.
  const { scene, frame } = built()
  const square = scene.root.find((node: Node) => node instanceof Rect && node.width === 26)[0] as Rect
  const startX = square.x

  // Just before the handover at 1.5s.
  for (let i = 0; i < 44; i++) frame(1 / 30)
  const atHandover = { x: square.x, y: square.y }
  assert(atHandover.x > startX + 50, 'the drift has carried it well to the right')

  // And a second later, with the takeover running.
  for (let i = 0; i < 30; i++) frame(1 / 30)
  assert(square.x < atHandover.x, 'x is being pulled back by the tween that took it')
  assert(square.y > atHandover.y, 'while y is still being written by the drift that kept it')
})
