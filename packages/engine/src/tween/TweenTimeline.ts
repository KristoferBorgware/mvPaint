// The clock and the state machine a tween is driven by: where in its duration it is, which
// way it is going, and what to call when any of that changes.
//
// It knows nothing about nodes or attributes. It holds a time between 0 and the duration, maps
// that time through an easing to a POSITION, and hands the position to a callback - so what is
// being animated is entirely the caller's business. Tween.ts supplies a callback that writes
// attributes; a caller animating a camera, a shader uniform or a number in an application's own
// state supplies its own.
//
// TIME IS SUPPLIED, never read from a global clock. Each step is `onEnterFrame()` against a
// ticker's own milliseconds (see ticker.ts), which is what makes an animation reproducible: a
// test steps it by hand, and a renderer steps every tween by the same frame delta.
//
// Playing and reversing are separate states rather than a signed rate, because the time each
// derives from the same start stamp differently: playing counts up from it, reversing counts
// the duration down. `reverse()` therefore mirrors the current time as it switches, so the
// value continues from exactly where it was rather than jumping to its opposite.
//
// yoyo turns the two ends into turning points: reaching the finish reverses instead of
// finishing, and reaching the start plays instead of resetting - so the animation runs until it
// is paused. Without it, either end stops the timeline and fires onFinish or onReset.

import type { EasingFunction } from './easings'

/** Which way the timeline is going, or that it is not going. */
export type TweenState = 'paused' | 'playing' | 'reversing'

export interface TweenTimelineOptions {
  /** Milliseconds from start to finish. */
  duration: number
  easing: EasingFunction
  /** Called with the eased position each time the timeline settles on a new time. */
  onPosition: (position: number) => void
  /** Bounce between the ends instead of stopping at them. */
  yoyo?: boolean
}

export class TweenTimeline {
  readonly duration: number
  private readonly easing: EasingFunction
  private readonly onPosition: (position: number) => void
  private readonly yoyo: boolean

  private _state: TweenState = 'paused'
  private _time = 0
  private _position = 0
  /** The ticker time `_time` is measured from - reset whenever the direction changes. */
  private startTime = 0

  // Assigned by the owner rather than taken as options: Tween needs to subscribe to the ticker
  // from onPlay, and the ticker subscription is what makes the timeline run, so the two are
  // wired up after construction.
  onPlay?: () => void
  onReverse?: () => void
  onPause?: () => void
  onFinish?: () => void
  onReset?: () => void
  onSeek?: () => void
  onUpdate?: () => void

  constructor(options: TweenTimelineOptions) {
    this.duration = options.duration
    this.easing = options.easing
    this.onPosition = options.onPosition
    this.yoyo = options.yoyo ?? false
  }

  get state(): TweenState {
    return this._state
  }

  /** True while a ticker should be stepping this timeline. */
  get isRunning(): boolean {
    return this._state !== 'paused'
  }

  /** Milliseconds into the duration, whichever way it is going. */
  get time(): number {
    return this._time
  }

  /** The eased position the last update settled on - 0 at the start, 1 at the finish. */
  get position(): number {
    return this._position
  }

  /** Runs forward from wherever it is. `now` is the ticker's time in milliseconds. */
  play(now: number): void {
    this._state = 'playing'
    this.startTime = now - this._time
    this.advanceTo(now)
    this.onPlay?.()
  }

  /**
   * Runs backward from wherever it is. The stored time is mirrored, because a reversing
   * timeline counts the duration DOWN from its start stamp - so the mirrored time is what makes
   * the next step land on the value the timeline is already showing.
   */
  reverse(now: number): void {
    this._state = 'reversing'
    this._time = this.duration - this._time
    this.startTime = now - this._time
    this.advanceTo(now)
    this.onReverse?.()
  }

  /** Stops where it is. The position stands; nothing is re-applied. */
  pause(): void {
    this._state = 'paused'
    this.onPause?.()
  }

  /**
   * Stops and jumps to `time` milliseconds in, held inside the duration - so a scrub past
   * either end lands on that end rather than on a position the easing extrapolated to.
   */
  seek(time: number): void {
    this.pause()
    this._time = time < 0 ? 0 : time > this.duration ? this.duration : time
    this.update()
    this.onSeek?.()
  }

  /** Stops at the start. */
  reset(): void {
    this.pause()
    this._time = 0
    this.update()
    this.onReset?.()
  }

  /** Stops at the finish. */
  finish(): void {
    this.pause()
    this._time = this.duration
    this.update()
    this.onFinish?.()
  }

  /** One frame. `now` is the ticker's time in milliseconds. Does nothing while paused. */
  step(now: number): void {
    if (this._state === 'paused') return
    this.advanceTo(now)
  }

  /**
   * How far `now` is from the start stamp, read forwards or backwards according to the state,
   * and then applied.
   */
  private advanceTo(now: number): void {
    const elapsed = now - this.startTime
    this.setTime(this._state === 'reversing' ? this.duration - elapsed : elapsed, now)
  }

  /**
   * Moves to a time, handling the two ends. Past the finish or before the start, a yoyo turns
   * around and anything else stops there - which is where onFinish and onReset come from, so a
   * timeline that runs to its end announces it without the caller watching the clock.
   *
   * The ends are CROSSED rather than touched: a frame landing exactly on the duration shows the
   * finish value and the next one ends the timeline. Stopping on the boundary instead would end
   * a timeline the moment it was played, since play() applies its first value at elapsed zero,
   * which for a reversed one is exactly the boundary at the other end.
   */
  private setTime(time: number, now: number): void {
    if (time > this.duration) {
      if (this.yoyo) this.turnAround('reversing', now)
      else this.finish()
    } else if (time < 0) {
      if (this.yoyo) this.turnAround('playing', now)
      else this.reset()
    } else {
      this._time = time
      this.update()
    }
  }

  /**
   * Bounces off an end. The turn happens at the moment the end was actually crossed, which is
   * part-way through the frame that discovered it, and the rest of that frame is then applied in
   * the new direction - so a yoyo passes through its extremes rather than resting on one for a
   * frame each time it arrives.
   *
   * Both directions leave the time at 0 measured from the crossing: for a reversing timeline
   * that reads as the full duration, which is the end it just reached, and for a playing one as
   * the start it just came back to.
   */
  private turnAround(state: TweenState, now: number): void {
    this.startTime += this.duration
    this._time = 0
    this._state = state
    if (state === 'reversing') this.onReverse?.()
    else this.onPlay?.()
    this.advanceTo(now)
  }

  /** Maps the current time through the easing and hands the position on. */
  private update(): void {
    this._position = this.easing(this._time, 0, 1, this.duration)
    this.onPosition(this._position)
    this.onUpdate?.()
  }
}
