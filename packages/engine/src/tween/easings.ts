// The easing curves, in the four-argument form the tween timeline calls them with.
//
// An easing takes (elapsed, begin, change, duration) and returns where the value sits at that
// moment: `begin` at elapsed 0 and `begin + change` at elapsed `duration`. The four arguments
// are what makes an easing writable as one expression - the classic penner form - and the
// timeline always passes begin 0 and change 1, so what comes back is the 0..1 position the
// attribute tracks are read at.
//
// SOME OF THEM LEAVE THE 0..1 RANGE on the way. Back pulls under the start before setting off
// and past the end before settling, Elastic oscillates around both; a track therefore
// extrapolates rather than clamps, and a colour channel is the one thing pulled back into
// range (see interpolate.ts). Bounce and the polynomial curves stay inside it.
//
// Elastic takes two more arguments than the rest: amplitude and period. Both are optional and
// derived from `change` and `duration` when absent, which is the form every caller uses; they
// are in the signature so a caller wanting a different spring can partially apply one.

/**
 * A curve, as (elapsed, begin, change, duration) -> value. Elapsed and duration are in the
 * same unit (the timeline uses milliseconds); `change` is the total travel, so the value at
 * `duration` is `begin + change`.
 */
export type EasingFunction = (time: number, begin: number, change: number, duration: number) => number

const BACK_OVERSHOOT = 1.70158

/**
 * Every curve by name. `Linear` is the default; the rest are the usual families, each in its
 * In (slow start), Out (slow finish) and InOut (both) form.
 *
 * ```ts
 * new Tween({ node: box, duration: 0.6, easing: Easings.BackEaseOut, x: 400 }).play()
 * ```
 */
export const Easings = {
  Linear(time: number, begin: number, change: number, duration: number): number {
    return (change * time) / duration + begin
  },

  /** Quadratic. */
  EaseIn(time: number, begin: number, change: number, duration: number): number {
    return change * (time /= duration) * time + begin
  },
  EaseOut(time: number, begin: number, change: number, duration: number): number {
    return -change * (time /= duration) * (time - 2) + begin
  },
  EaseInOut(time: number, begin: number, change: number, duration: number): number {
    if ((time /= duration / 2) < 1) return (change / 2) * time * time + begin
    return (-change / 2) * (--time * (time - 2) - 1) + begin
  },

  /** Quintic - the same shape as EaseIn's, pulled much harder towards the ends. */
  StrongEaseIn(time: number, begin: number, change: number, duration: number): number {
    return change * (time /= duration) * time * time * time * time + begin
  },
  StrongEaseOut(time: number, begin: number, change: number, duration: number): number {
    return change * ((time = time / duration - 1) * time * time * time * time + 1) + begin
  },
  StrongEaseInOut(time: number, begin: number, change: number, duration: number): number {
    if ((time /= duration / 2) < 1) return (change / 2) * time * time * time * time * time + begin
    return (change / 2) * ((time -= 2) * time * time * time * time + 2) + begin
  },

  /** Pulls back past the start before setting off, and past the end before settling. */
  BackEaseIn(time: number, begin: number, change: number, duration: number): number {
    const s = BACK_OVERSHOOT
    return change * (time /= duration) * time * ((s + 1) * time - s) + begin
  },
  BackEaseOut(time: number, begin: number, change: number, duration: number): number {
    const s = BACK_OVERSHOOT
    return change * ((time = time / duration - 1) * time * ((s + 1) * time + s) + 1) + begin
  },
  BackEaseInOut(time: number, begin: number, change: number, duration: number): number {
    // The halved curve overshoots half as far at each end, so the pull is scaled up to keep
    // the same visible kick as the one-sided forms.
    let s = BACK_OVERSHOOT
    if ((time /= duration / 2) < 1) return (change / 2) * (time * time * (((s *= 1.525) + 1) * time - s)) + begin
    return (change / 2) * ((time -= 2) * time * (((s *= 1.525) + 1) * time + s) + 2) + begin
  },

  /**
   * A decaying oscillation about the end value. `amplitude` is how far the first swing
   * reaches and `period` how long one swing lasts; omitted, they come from the travel and
   * the duration.
   */
  ElasticEaseIn(
    time: number,
    begin: number,
    change: number,
    duration: number,
    amplitude?: number,
    period?: number,
  ): number {
    let s = 0
    if (time === 0) return begin
    if ((time /= duration) === 1) return begin + change
    let p = period ?? duration * 0.3
    let a = amplitude ?? 0
    if (!a || a < Math.abs(change)) {
      a = change
      s = p / 4
    } else {
      s = (p / (2 * Math.PI)) * Math.asin(change / a)
    }
    return -(a * Math.pow(2, 10 * (time -= 1)) * Math.sin(((time * duration - s) * (2 * Math.PI)) / p)) + begin
  },
  ElasticEaseOut(
    time: number,
    begin: number,
    change: number,
    duration: number,
    amplitude?: number,
    period?: number,
  ): number {
    let s = 0
    if (time === 0) return begin
    if ((time /= duration) === 1) return begin + change
    const p = period ?? duration * 0.3
    let a = amplitude ?? 0
    if (!a || a < Math.abs(change)) {
      a = change
      s = p / 4
    } else {
      s = (p / (2 * Math.PI)) * Math.asin(change / a)
    }
    return a * Math.pow(2, -10 * time) * Math.sin(((time * duration - s) * (2 * Math.PI)) / p) + change + begin
  },
  ElasticEaseInOut(
    time: number,
    begin: number,
    change: number,
    duration: number,
    amplitude?: number,
    period?: number,
  ): number {
    let s = 0
    if (time === 0) return begin
    if ((time /= duration / 2) === 2) return begin + change
    const p = period ?? duration * (0.3 * 1.5)
    let a = amplitude ?? 0
    if (!a || a < Math.abs(change)) {
      a = change
      s = p / 4
    } else {
      s = (p / (2 * Math.PI)) * Math.asin(change / a)
    }
    if (time < 1) {
      return -0.5 * (a * Math.pow(2, 10 * (time -= 1)) * Math.sin(((time * duration - s) * (2 * Math.PI)) / p)) + begin
    }
    return (
      a * Math.pow(2, -10 * (time -= 1)) * Math.sin(((time * duration - s) * (2 * Math.PI)) / p) * 0.5 + change + begin
    )
  },

  /** Four parabolic hops of decreasing height, landing exactly on the end value. */
  BounceEaseOut(time: number, begin: number, change: number, duration: number): number {
    if ((time /= duration) < 1 / 2.75) {
      return change * (7.5625 * time * time) + begin
    } else if (time < 2 / 2.75) {
      return change * (7.5625 * (time -= 1.5 / 2.75) * time + 0.75) + begin
    } else if (time < 2.5 / 2.75) {
      return change * (7.5625 * (time -= 2.25 / 2.75) * time + 0.9375) + begin
    }
    return change * (7.5625 * (time -= 2.625 / 2.75) * time + 0.984375) + begin
  },
  BounceEaseIn(time: number, begin: number, change: number, duration: number): number {
    return change - Easings.BounceEaseOut(duration - time, 0, change, duration) + begin
  },
  BounceEaseInOut(time: number, begin: number, change: number, duration: number): number {
    if (time < duration / 2) return Easings.BounceEaseIn(time * 2, 0, change, duration) * 0.5 + begin
    return Easings.BounceEaseOut(time * 2 - duration, 0, change, duration) * 0.5 + change * 0.5 + begin
  },
} satisfies Record<string, EasingFunction>

/** The name of one of the curves above - for a UI that offers them, or a serialized document. */
export type EasingName = keyof typeof Easings
