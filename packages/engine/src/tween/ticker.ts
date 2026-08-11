// What steps a running tween, and where its milliseconds come from.
//
// The ticker holds a time of its own and hands it to every timeline it is stepping, rather than
// each timeline reading a wall clock. That single seam is what makes an animation reproducible:
// a test advances the ticker by 100ms and gets exactly the frame it would have got at 100ms,
// and every tween in a scene shares one notion of when "now" is instead of each sampling the
// clock a few microseconds apart.
//
// It drives ITSELF by default. A tween that is played starts an animation frame loop, and the
// loop stops the moment the last tween pauses - so a scene with nothing animating schedules
// nothing, and an application that only ever writes `node.to({ x: 100 })` never has to know the
// ticker exists.
//
// AN APPLICATION THAT ALREADY HAS A FRAME can take it over instead, with driveTweens(handle).
// Tweens then step inside the render loop, before the draw that shows them, which is one frame
// rather than two and puts the animation in the same order as everything else the frame does.
// Taking it over switches the ticker's own loop off; the returned function gives it back.
//
// Where there is no requestAnimationFrame at all - a test, a worker - self-driving is simply
// inert. Nothing throws and nothing is scheduled, and advance() is how the time moves.

/** What a timeline looks like to the ticker: something to step with the current time. */
export interface Steppable {
  step(now: number): void
}

/** Anything that calls back once a frame with the seconds elapsed - a renderer handle. */
export interface FrameSource {
  addFrameListener(listener: (dt: number) => void): () => void
}

export class TweenTicker {
  private readonly running = new Set<Steppable>()
  private _time = 0
  private _autoDrive = true
  private frame: number | null = null
  /** The previous frame's timestamp, or null before the loop has had one to measure from. */
  private previousStamp: number | null = null

  /** Milliseconds this ticker has counted. Monotonic, and only moves in advance(). */
  get time(): number {
    return this._time
  }

  /** How many timelines are being stepped. */
  get runningCount(): number {
    return this.running.size
  }

  /**
   * Whether the ticker schedules its own animation frames. True by default; false leaves the
   * time still until something calls advance().
   */
  get autoDrive(): boolean {
    return this._autoDrive
  }
  set autoDrive(value: boolean) {
    if (value === this._autoDrive) return
    this._autoDrive = value
    if (value) this.schedule()
    else this.cancel()
  }

  /** Starts stepping a timeline. Called by Tween when it plays. */
  add(steppable: Steppable): void {
    this.running.add(steppable)
    this.schedule()
  }

  /** Stops stepping a timeline. Called by Tween when it pauses, finishes or resets. */
  remove(steppable: Steppable): void {
    this.running.delete(steppable)
    if (this.running.size === 0) this.cancel()
  }

  /**
   * Moves the time on and steps everything running. `deltaMs` of 0 re-steps at the same
   * moment, which is what a paused editor's scrub does.
   */
  advance(deltaMs: number): void {
    this._time += deltaMs
    // Walked directly rather than over a copy. A Set tolerates being edited while it is walked,
    // and a timeline that reaches its end removes itself from inside this loop - which is the
    // common case, not an edge one. A tween started by an onFinish handler joins the set and is
    // stepped in the same pass, at a time equal to its own start, so it applies its first
    // frame's value rather than waiting one frame to appear.
    for (const steppable of this.running) steppable.step(this._time)
  }

  /**
   * Asks for the next frame, if one is wanted and not already booked.
   *
   * It leaves `previousStamp` ALONE, which is the whole of what makes the loop measure
   * anything: this runs again at the end of every frame to book the next, and clearing the
   * stamp here would make each frame's delta the distance from a stamp that was just thrown
   * away - zero, every time, forever. The stamp is cleared where the loop STOPS instead.
   */
  private schedule(): void {
    if (!this._autoDrive || this.frame !== null || this.running.size === 0) return
    if (typeof requestAnimationFrame !== 'function') return
    this.frame = requestAnimationFrame(this.tick)
  }

  /**
   * Stops the loop, and forgets when the last frame was.
   *
   * Unconditional rather than guarded on a frame being booked, because the usual way a loop
   * ends has none: a tween that finishes does so from inside tick(), which has already taken
   * the booking down. Left set, the stamp would still be there whenever the next tween played,
   * and the first frame of that one would be charged for however long the page sat idle -
   * which for anything but the shortest wait is the whole animation, over before it is seen.
   */
  private cancel(): void {
    if (this.frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.frame)
    this.frame = null
    this.previousStamp = null
  }

  private readonly tick = (stamp: number): void => {
    this.frame = null
    // The first frame of a loop has nothing to measure from, so it advances by nothing: the
    // stamp it carries is a moment in the page's life, not this ticker's, and treating it as a
    // delta would jump every tween to its end.
    const delta = this.previousStamp === null ? 0 : stamp - this.previousStamp
    this.previousStamp = stamp
    this.advance(delta)
    this.schedule()
  }
}

/**
 * The ticker tweens use when they are not given one. One per page, so everything animating
 * shares a clock.
 */
export const tweenTicker = new TweenTicker()

/**
 * Steps tweens from a renderer's frame instead of from their own animation frame, and returns
 * the function that hands the ticker back its loop.
 *
 * ```ts
 * const stop = driveTweens(handle)
 * ```
 *
 * The renderer already has a frame, and running the tweens inside it means an attribute written
 * this frame is drawn this frame. It also puts them in a definite order with the rest of the
 * loop - `handle.onFrame` runs first, then the frame listeners in the order they subscribed.
 */
export function driveTweens(source: FrameSource, ticker: TweenTicker = tweenTicker): () => void {
  ticker.autoDrive = false
  const unsubscribe = source.addFrameListener((dt) => ticker.advance(dt * 1000))
  return () => {
    unsubscribe()
    ticker.autoDrive = true
  }
}
