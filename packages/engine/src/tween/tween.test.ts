// The tween engine: the curves, the timeline's state machine, and what a tween does to a node's
// attributes over the frames it runs for.
//
// Every test here steps a ticker of its own, by hand. That is not a stand-in for a real frame -
// it is the same path a real frame takes (see ticker.ts), with the milliseconds supplied rather
// than sampled - so what is asserted below is what a browser shows, and nothing here waits.

import { expect, it } from 'vitest'
import { Easings } from './easings'
import { Tween } from './Tween'
import { TweenTicker, driveTweens } from './ticker'
import { Circle } from '../shapes/Circle'
import { Polyline } from '../shapes/Polyline'
import { Rect } from '../shapes/Rect'
import type { RGBA } from '../render/color'

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps

/** A ticker nothing else is stepping, so one test's frames are not another's. */
function ticker(): TweenTicker {
  const t = new TweenTicker()
  // Nothing schedules an animation frame under Node anyway; saying so keeps the test's frames
  // the only ones there are on a runner that does have one.
  t.autoDrive = false
  return t
}

// --- the curves ---------------------------------------------------------------------------

it('every easing starts at the begin value and ends at begin + change', () => {
  for (const [name, easing] of Object.entries(Easings)) {
    expect(near(easing(0, 10, 90, 400), 10), `${name} at 0`).toBe(true)
    expect(near(easing(400, 10, 90, 400), 100), `${name} at the duration`).toBe(true)
  }
})

it('Linear is the position itself, and the eased curves bend away from it', () => {
  expect(Easings.Linear(50, 0, 1, 100)).toBe(0.5)
  // Quadratic in: a quarter of the way along at half the time. Out is its mirror.
  expect(Easings.EaseIn(50, 0, 1, 100)).toBe(0.25)
  expect(Easings.EaseOut(50, 0, 1, 100)).toBe(0.75)
  expect(Easings.EaseInOut(50, 0, 1, 100)).toBe(0.5)
})

it('Back overshoots both ends, and Bounce stays inside them', () => {
  expect(Easings.BackEaseIn(10, 0, 1, 100)).toBeLessThan(0)
  expect(Easings.BackEaseOut(90, 0, 1, 100)).toBeGreaterThan(1)
  for (let t = 0; t <= 100; t += 5) {
    const p = Easings.BounceEaseOut(t, 0, 1, 100)
    expect(p >= 0 && p <= 1, `bounce at ${t}`).toBe(true)
  }
})

// --- a number over frames -----------------------------------------------------------------

it('carries an attribute from where it is to where it should be', () => {
  const clock = ticker()
  const box = new Rect({ x: 0, width: 10, height: 10 })
  const tween = new Tween({ node: box, ticker: clock, duration: 1, x: 100 })

  // Constructing writes nothing: the node is already at the start of every track.
  expect(box.x).toBe(0)

  tween.play()
  clock.advance(250)
  expect(box.x).toBe(25)
  clock.advance(250)
  expect(box.x).toBe(50)
  clock.advance(500)
  expect(box.x).toBe(100)
})

it('stops itself at the finish, and says so', () => {
  const clock = ticker()
  const box = new Rect({ x: 0, width: 10, height: 10 })
  let finished = 0
  const tween = new Tween({ node: box, ticker: clock, duration: 1, x: 100, onFinish: () => finished++ })

  tween.play()
  expect(clock.runningCount).toBe(1)
  clock.advance(1500)

  expect(finished).toBe(1)
  expect(box.x).toBe(100)
  expect(tween.isRunning).toBe(false)
  // Nothing left to step, so a self-driving ticker would have stopped scheduling frames here.
  expect(clock.runningCount).toBe(0)

  clock.advance(1000)
  expect(finished).toBe(1)
})

it('defaults to 300ms, and animates several attributes at once', () => {
  const clock = ticker()
  const dot = new Circle({ radius: 10, opacity: 1, fill: 'black' })
  const tween = new Tween({ node: dot, ticker: clock, radius: 20, opacity: 0 })

  expect(tween.duration).toBe(0.3)
  tween.play()
  clock.advance(150)
  expect(dot.radius).toBe(15)
  expect(dot.opacity).toBe(0.5)
})

it('runs the position through the easing rather than the clock', () => {
  const clock = ticker()
  const box = new Rect({ x: 0, width: 10, height: 10 })
  new Tween({ node: box, ticker: clock, duration: 1, easing: Easings.EaseIn, x: 100 }).play()

  clock.advance(500)
  expect(box.x).toBe(25)
})

// --- the state machine --------------------------------------------------------------------

it('reverses from where it is, and continues from the same value', () => {
  const clock = ticker()
  const box = new Rect({ x: 0, width: 10, height: 10 })
  const tween = new Tween({ node: box, ticker: clock, duration: 1, x: 100 })

  tween.play()
  clock.advance(600)
  expect(box.x).toBe(60)

  tween.reverse()
  // The switch itself moves nothing - only the direction the next frame is read in.
  expect(box.x).toBe(60)
  clock.advance(200)
  expect(box.x).toBe(40)
  clock.advance(500)
  expect(box.x).toBe(0)
  expect(tween.isRunning).toBe(false)
})

it('bounces between the ends when it yoyos, instead of stopping at either', () => {
  const clock = ticker()
  const box = new Rect({ x: 0, width: 10, height: 10 })
  let finished = 0
  const tween = new Tween({ node: box, ticker: clock, duration: 1, yoyo: true, x: 100, onFinish: () => finished++ })

  tween.play()
  clock.advance(800)
  expect(box.x).toBe(80)
  // Past the end: it turns around rather than finishing, so the far side is 200ms back down.
  clock.advance(400)
  expect(near(box.x, 80)).toBe(true)
  expect(tween.state).toBe('reversing')
  // And past the start it turns around again.
  clock.advance(1000)
  expect(near(box.x, 20)).toBe(true)
  expect(tween.state).toBe('playing')
  expect(finished).toBe(0)
  expect(tween.isRunning).toBe(true)
})

it('pauses where it is, seeks to a moment, and resets to the start', () => {
  const clock = ticker()
  const box = new Rect({ x: 0, width: 10, height: 10 })
  const tween = new Tween({ node: box, ticker: clock, duration: 1, x: 100 })

  tween.play()
  clock.advance(300)
  tween.pause()
  clock.advance(500)
  expect(box.x).toBe(30)
  expect(clock.runningCount).toBe(0)

  tween.seek(0.75)
  expect(box.x).toBe(75)
  expect(tween.isRunning).toBe(false)

  // Held inside the duration, rather than extrapolated past the end.
  tween.seek(4)
  expect(box.x).toBe(100)

  tween.reset()
  expect(box.x).toBe(0)

  // Resumed from the start, and the frames it was paused for are not owed to it.
  tween.play()
  clock.advance(100)
  expect(box.x).toBe(10)
})

it('finishes on demand, landing exactly on the end value', () => {
  const clock = ticker()
  const box = new Rect({ x: 0, width: 10, height: 10 })
  const tween = new Tween({ node: box, ticker: clock, duration: 1, x: 33.3 })

  tween.play()
  clock.advance(100)
  tween.finish()
  expect(box.x).toBe(33.3)
})

// --- colours ------------------------------------------------------------------------------

const rgba = (c: unknown): number[] => [...(c as RGBA)]

it('mixes a colour channel by channel, in the tuple a shape reads back', () => {
  const clock = ticker()
  const box = new Rect({ width: 10, height: 10, fill: '#000000' })
  new Tween({ node: box, ticker: clock, duration: 1, fill: '#ffffff' }).play()

  clock.advance(500)
  expect(rgba(box.fill)).toEqual([0.5, 0.5, 0.5, 1])
  clock.advance(500)
  expect(rgba(box.fill)).toEqual([1, 1, 1, 1])
})

it('fades a fill in from its own colour rather than through black, and lands on no fill at all', () => {
  const clock = ticker()
  const box = new Rect({ width: 10, height: 10 })
  expect(box.fill).toBe(null)

  const tween = new Tween({ node: box, ticker: clock, duration: 1, fill: 'red' })
  tween.play()
  clock.advance(500)
  // Red all the way, arriving by its alpha.
  expect(rgba(box.fill)).toEqual([1, 0, 0, 0.5])
  clock.advance(500)
  expect(rgba(box.fill)).toEqual([1, 0, 0, 1])

  // And back out: a transparent red is not the same state of the shape as having no fill, so
  // the reverse end is landed on exactly.
  tween.reverse()
  clock.advance(1200)
  expect(box.fill).toBe(null)
})

it('holds a colour channel inside 0..1 even when the curve overshoots', () => {
  const clock = ticker()
  const box = new Rect({ width: 10, height: 10, fill: 'black' })
  new Tween({ node: box, ticker: clock, duration: 1, easing: Easings.BackEaseIn, fill: 'white' }).play()

  clock.advance(100)
  for (const channel of rgba(box.fill)) expect(channel >= 0 && channel <= 1).toBe(true)
})

// --- lists --------------------------------------------------------------------------------

it('animates a dash pattern element by element, growing the tail out of nothing', () => {
  const clock = ticker()
  const box = new Rect({ width: 10, height: 10, dash: [10, 10] })
  new Tween({ node: box, ticker: clock, duration: 1, dash: [20, 20, 4, 4] }).play()

  clock.advance(500)
  expect(box.dash).toEqual([15, 15, 2, 2])
  clock.advance(500)
  expect(box.dash).toEqual([20, 20, 4, 4])
})

it('moves a gradient: its geometry as points, its stops as offset and colour', () => {
  const clock = ticker()
  const box = new Rect({ width: 10, height: 10 })
  box.fillLinearGradientStartPoint = { x: 0, y: 0 }
  // Written flat, and read back as stops - so a tween has to accept the form it was written in.
  box.fillLinearGradientColorStops = [0, 'black', 1, 'white']

  new Tween({
    node: box,
    ticker: clock,
    duration: 1,
    fillLinearGradientStartPoint: { x: 100, y: 40 },
    fillLinearGradientColorStops: [0.5, 'white', 1, 'black'],
  }).play()

  clock.advance(500)
  expect(box.fillLinearGradientStartPoint).toEqual({ x: 50, y: 20 })
  expect(box.fillLinearGradientColorStops).toEqual([
    { offset: 0.25, color: [0.5, 0.5, 0.5, 1] },
    { offset: 1, color: [0.5, 0.5, 0.5, 1] },
  ])
})

it('grows a points list by starting its new points on the outline they are joining', () => {
  const clock = ticker()
  const line = new Polyline({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] })
  const end = [
    { x: 0, y: 0 },
    { x: 50, y: -50 },
    { x: 100, y: 0 },
  ]
  const tween = new Tween({ node: line, ticker: clock, duration: 1, points: end })

  tween.play()
  // The middle point does not exist at the start, so it stands in at its nearest place on the
  // segment it is being inserted into - not at the origin, which would fly across the scene.
  clock.advance(0)
  expect(line.points).toEqual([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }])

  clock.advance(500)
  expect(line.points).toEqual([{ x: 0, y: 0 }, { x: 50, y: -25 }, { x: 100, y: 0 }])

  clock.advance(500)
  expect(line.points).toEqual(end)
})

it('puts back the list that was written when a resampled tween is reset', () => {
  const clock = ticker()
  const start = [{ x: 0, y: 0 }, { x: 100, y: 0 }]
  const line = new Polyline({ points: start })
  // The flat form, which is the other way a points list is written.
  const tween = new Tween({ node: line, ticker: clock, duration: 1, points: [0, 0, 50, -50, 100, 0] })

  tween.play()
  clock.advance(500)
  expect(line.points).toHaveLength(3)

  tween.reset()
  expect(line.points).toEqual(start)
})

// --- who owns an attribute ------------------------------------------------------------------

it('gives an attribute to the newest tween, and leaves the older one its others', () => {
  const clock = ticker()
  const box = new Rect({ x: 0, y: 0, width: 10, height: 10 })

  const move = new Tween({ node: box, ticker: clock, duration: 1, x: 100, y: 100 })
  move.play()
  clock.advance(500)
  expect(box.x).toBe(50)
  expect(box.y).toBe(50)

  // The second tween takes x. The first keeps y, and carries on with it alone.
  const nudge = new Tween({ node: box, ticker: clock, duration: 1, x: 0 })
  expect(move.attributes).toEqual(['y'])
  expect(nudge.attributes).toEqual(['x'])

  nudge.play()
  clock.advance(500)
  expect(box.x).toBe(25)
  expect(box.y).toBe(100)
})

it('lets go of its attributes when it is destroyed, and stops writing them', () => {
  const clock = ticker()
  const box = new Rect({ x: 0, width: 10, height: 10 })
  const tween = new Tween({ node: box, ticker: clock, duration: 1, x: 100 })

  tween.play()
  clock.advance(500)
  tween.destroy()

  clock.advance(500)
  expect(box.x).toBe(50)
  expect(clock.runningCount).toBe(0)

  // Free again, so a new tween on x starts from what is there now.
  new Tween({ node: box, ticker: clock, duration: 1, x: 150 }).play()
  clock.advance(500)
  expect(box.x).toBe(100)
})

// --- node.to ---------------------------------------------------------------------------------

it('to() plays at once and clears itself away at the finish', () => {
  const clock = ticker()
  const box = new Rect({ x: 0, width: 10, height: 10 })
  let finished = 0

  const tween = box.to({ ticker: clock, duration: 1, x: 100, onFinish: () => finished++ })
  expect(tween.isRunning).toBe(true)

  clock.advance(500)
  expect(box.x).toBe(50)
  // A frame lands past the duration rather than on it - see TweenTimeline.setTime.
  clock.advance(600)
  expect(box.x).toBe(100)
  expect(finished).toBe(1)
  // Destroyed with the finish, so the attribute is free for whatever the handler starts next.
  expect(tween.attributes).toEqual([])
})

// --- what it refuses ----------------------------------------------------------------------

it('refuses an attribute the node does not have, and one with no midpoint', () => {
  const clock = ticker()
  const box = new Rect({ width: 10, height: 10 })

  expect(() => new Tween({ node: box, ticker: clock, wobble: 1 })).toThrow(/no attribute 'wobble'/)
  // A compound accessor is not an attribute - see Node.attrKeys.
  expect(() => new Tween({ node: box, ticker: clock, scale: { x: 2, y: 2 } })).toThrow(/no attribute 'scale'/)
  // And a string is not a thing to be half-way along.
  expect(() => new Tween({ node: box, ticker: clock, name: 'other' })).toThrow(/no midpoint/)
})

// --- the frame ------------------------------------------------------------------------------

/**
 * The animation frame, stubbed: one pending callback, fired with whatever timestamp a test
 * wants. Node has no requestAnimationFrame, which is exactly why the self-driving path needs
 * one built here - it is the path every application that does nothing at all takes.
 */
function fakeFrames() {
  const real = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame }
  let pending: FrameRequestCallback | null = null
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    pending = callback
    return 1
  }
  globalThis.cancelAnimationFrame = () => {
    pending = null
  }
  return {
    get scheduled() {
      return pending !== null
    },
    /** Runs the pending callback with this timestamp, as a browser would. */
    frame(stamp: number) {
      const callback = pending
      pending = null
      callback?.(stamp)
    },
    restore() {
      globalThis.requestAnimationFrame = real.raf
      globalThis.cancelAnimationFrame = real.caf
    },
  }
}

it('drives itself off the animation frame, advancing by the time between stamps', () => {
  // The default path: nothing set up, nothing subscribed, a tween just played. Every other test
  // here advances the ticker by hand, which is precisely why this one has to exist - a ticker
  // that measured every frame as zero would pass all of them and animate nothing on a page.
  const frames = fakeFrames()
  try {
    const clock = new TweenTicker()
    const box = new Rect({ x: 0, width: 10, height: 10 })
    new Tween({ node: box, ticker: clock, duration: 1, x: 100 }).play()

    // Playing schedules the loop. The first frame has nothing to measure from, so it moves
    // nothing: its stamp is a moment in the page's life, not this ticker's.
    expect(frames.scheduled).toBe(true)
    frames.frame(5000)
    expect(box.x).toBe(0)

    // And from there, each frame is worth the time since the one before it.
    frames.frame(5250)
    expect(box.x).toBe(25)
    frames.frame(5500)
    expect(box.x).toBe(50)
    frames.frame(6100)
    expect(box.x).toBe(100)

    // Finished, so the loop stops rather than burning a frame a tick forever.
    expect(frames.scheduled).toBe(false)
  } finally {
    frames.restore()
  }
})

it('does not charge a new tween for the time nothing was running', () => {
  // The loop stops when the last tween finishes and starts again when the next one plays, and
  // the gap between the two is a page sitting idle. Measured from the stamp the old loop ended
  // on, a tween played a minute later would be over before its first frame was drawn.
  const frames = fakeFrames()
  try {
    const clock = new TweenTicker()
    const first = new Rect({ x: 0, width: 10, height: 10 })
    new Tween({ node: first, ticker: clock, duration: 1, x: 100 }).play()
    frames.frame(1000)
    frames.frame(2200)
    expect(first.x).toBe(100)
    expect(frames.scheduled).toBe(false)

    // A minute of nothing, and then a second tween.
    const second = new Rect({ x: 0, width: 10, height: 10 })
    new Tween({ node: second, ticker: clock, duration: 1, x: 100 }).play()
    frames.frame(62200)
    expect(second.x).toBe(0)
    frames.frame(62500)
    expect(second.x).toBe(30)
  } finally {
    frames.restore()
  }
})

it('steps from a renderer frame when one is handed to it', () => {
  const clock = new TweenTicker()
  const listeners = new Set<(dt: number) => void>()
  const handle = {
    addFrameListener(listener: (dt: number) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  const stop = driveTweens(handle, clock)
  expect(clock.autoDrive).toBe(false)

  const box = new Rect({ x: 0, width: 10, height: 10 })
  new Tween({ node: box, ticker: clock, duration: 1, x: 100 }).play()

  // Seconds from the renderer, milliseconds inside the ticker.
  for (const listener of listeners) listener(0.25)
  expect(box.x).toBe(25)

  stop()
  expect(listeners.size).toBe(0)
  expect(clock.autoDrive).toBe(true)
})
