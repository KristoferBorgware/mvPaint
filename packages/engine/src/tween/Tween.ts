// Tween - carrying attributes from where they are to where they should be, over time.
//
//   new Tween({ node: box, duration: 1, x: 400, rotation: 90, fill: 'tomato' }).play()
//
// Every key that is not one of the settings below is an ATTRIBUTE NAME, read off the target when
// the tween is built and written back through setAttr() on every frame - so a tween animates
// whatever the target exposes (see Node.attrKeys), and a shape that gains an attribute gains the
// ability to have it animated with no change here. A key the target does not declare throws, at
// construction, rather than quietly animating nothing.
//
// THE TARGET IS ANYTHING WITH THE ATTRIBUTE SEAM, not only a Node - see TweenTarget. A Node
// satisfies it; so does a Camera2D, which is not in the scene graph at all (see
// camera/cameraTween.ts). Nothing below reaches for a node's transform, parent or events, so
// there is nothing to widen: the four members of that interface are the whole of what a tween
// ever asks its target for.
//
// THE START IS READ ONCE, when the tween is constructed. That is what makes `reset()` and yoyo
// mean anything: the tween holds both ends of every attribute for its whole life, so it can be
// played, reversed, seeked and replayed without re-reading a node it has itself been changing.
// It also means a tween built now and played later starts from the values that were current
// when it was BUILT - build it when you want it to begin.
//
// ONE TWEEN OWNS AN ATTRIBUTE AT A TIME. Two tweens writing `x` on the same node every frame
// would fight, one value winning per frame with nothing to say which; so starting a tween on an
// attribute takes it away from whichever tween had it, and that tween simply stops writing it
// while carrying on with the rest. Fading a shape out while a half-finished move is still
// running leaves the move running.
//
// The frame comes from a ticker (see ticker.ts), which by default drives itself off
// requestAnimationFrame and stops as soon as nothing is animating.

import type { Node } from '../shapes/Node'
import { Easings, type EasingFunction } from './easings'
import { trackFor, type AttrTrack } from './interpolate'
import { TweenTicker, tweenTicker } from './ticker'
import { TweenTimeline, type TweenState } from './TweenTimeline'

/**
 * What a tween needs of the thing it animates: a name for its error messages, the attributes it
 * declares, and the two accessors. Node implements it, and so does Camera2D.
 *
 * The seam is named rather than assumed so that a target OUTSIDE the scene graph is a first-class
 * thing to animate. `attributeNames()` is the part that carries weight: it is what lets a
 * mistyped key be reported when the tween is built instead of writing a value nothing reads.
 */
export interface TweenTarget {
  /** What this thing is called in an error message - 'Rect', 'Camera2D'. */
  readonly nodeName: string
  attributeNames(): readonly string[]
  getAttr(key: string): unknown
  setAttr(key: string, value: unknown): unknown
}

/**
 * Everything a tween is configured with apart from the target, plus the attributes to animate:
 * any other key is an attribute name and its value is where that attribute should end up.
 */
export interface TweenSettings {
  /** Seconds. Default 0.3. */
  duration?: number
  /** Default `Easings.Linear`. See easings.ts for the rest. */
  easing?: EasingFunction
  /** Bounce between the ends rather than stopping at the finish. Default false. */
  yoyo?: boolean
  /** Which ticker steps this tween. Default the shared one - see ticker.ts. */
  ticker?: TweenTicker
  onPlay?: (this: Tween<TweenTarget>) => void
  onPause?: (this: Tween<TweenTarget>) => void
  onReverse?: (this: Tween<TweenTarget>) => void
  onSeek?: (this: Tween<TweenTarget>) => void
  onUpdate?: (this: Tween<TweenTarget>) => void
  onFinish?: (this: Tween<TweenTarget>) => void
  onReset?: (this: Tween<TweenTarget>) => void
  /** The attributes to animate: `x: 400`, `fill: 'tomato'`, `opacity: 0`. */
  [attr: string]: unknown
}

export interface TweenOptions<T extends TweenTarget = Node> extends TweenSettings {
  node: T
}

/**
 * The keys that configure the tween. Everything else in the options is an attribute name, so
 * this list is what separates the two - and why an attribute may not be called `duration`.
 */
const SETTING_KEYS: ReadonlySet<string> = new Set([
  'node',
  'duration',
  'easing',
  'yoyo',
  'ticker',
  'onPlay',
  'onPause',
  'onReverse',
  'onSeek',
  'onUpdate',
  'onFinish',
  'onReset',
])

/**
 * Which tween currently writes which attribute of which target.
 *
 * A WeakMap keyed by the target, so the entry goes when the target does - a scene that builds and
 * discards ten thousand nodes leaves nothing behind here, and a tween forgotten without being
 * destroyed holds nothing open either.
 *
 * Ownership is per TARGET OBJECT, which is what makes two ways of animating one thing worth
 * keeping apart: a camera tweened through its own x/y/zoom and the same camera tweened through a
 * view (see camera/cameraTween.ts) are two targets, and neither can see the other's writes.
 */
const attributeOwners = new WeakMap<TweenTarget, Map<string, Tween<TweenTarget>>>()

/** Seconds to milliseconds, with the two defaults the seconds are read through. */
function durationMs(duration: unknown): number {
  if (duration === undefined) return 300
  // A zero-length tween is one frame, not a division by zero: every easing divides the elapsed
  // time by the duration, so the shortest one there can be is the shortest one that computes.
  if (duration === 0) return 1
  return (duration as number) * 1000
}

export class Tween<T extends TweenTarget = Node> {
  readonly node: T
  private readonly tracks = new Map<string, AttrTrack>()
  private readonly timeline: TweenTimeline
  private readonly ticker: TweenTicker
  private destroyed = false

  onPlay?: (this: Tween<TweenTarget>) => void
  onPause?: (this: Tween<TweenTarget>) => void
  onReverse?: (this: Tween<TweenTarget>) => void
  onSeek?: (this: Tween<TweenTarget>) => void
  onUpdate?: (this: Tween<TweenTarget>) => void
  onFinish?: (this: Tween<TweenTarget>) => void
  onReset?: (this: Tween<TweenTarget>) => void

  constructor(options: TweenOptions<T>) {
    this.node = options.node
    this.ticker = options.ticker ?? tweenTicker
    this.onPlay = options.onPlay
    this.onPause = options.onPause
    this.onReverse = options.onReverse
    this.onSeek = options.onSeek
    this.onUpdate = options.onUpdate
    this.onFinish = options.onFinish
    this.onReset = options.onReset

    this.timeline = new TweenTimeline({
      duration: durationMs(options.duration),
      easing: (options.easing as EasingFunction | undefined) ?? Easings.Linear,
      yoyo: options.yoyo === true,
      onPosition: (position) => this.apply(position),
    })

    // Both ends of every attribute are read here and held for the tween's life. Nothing is
    // written: the tween sits at position 0, which is where the node already is, so the first
    // write is the one play() makes and constructing raises no attribute-change event.
    for (const key of Object.keys(options)) {
      if (!SETTING_KEYS.has(key)) this.addAttr(key, options[key])
    }

    this.timeline.onPlay = () => {
      this.syncTicker()
      this.onPlay?.call(this)
    }
    this.timeline.onReverse = () => {
      this.syncTicker()
      this.onReverse?.call(this)
    }
    this.timeline.onPause = () => {
      this.syncTicker()
      this.onPause?.call(this)
    }
    this.timeline.onSeek = () => this.onSeek?.call(this)
    this.timeline.onUpdate = () => this.onUpdate?.call(this)
    this.timeline.onFinish = () => {
      this.land('finalValue')
      this.onFinish?.call(this)
    }
    this.timeline.onReset = () => {
      this.land('initialValue')
      this.onReset?.call(this)
    }
  }

  /** Seconds from start to finish. */
  get duration(): number {
    return this.timeline.duration / 1000
  }

  /** Which way it is going, or that it is not going. */
  get state(): TweenState {
    return this.timeline.state
  }

  /** True while the ticker is stepping it. */
  get isRunning(): boolean {
    return this.timeline.isRunning
  }

  /** How far in it is, in seconds. */
  get time(): number {
    return this.timeline.time / 1000
  }

  /** The attributes this tween writes - what it started with, less anything another took. */
  get attributes(): string[] {
    return [...this.tracks.keys()]
  }

  /** Runs forward from wherever it is. Playing a finished tween needs a reset() first. */
  play(): this {
    this.timeline.play(this.ticker.time)
    return this
  }

  /** Runs backward from wherever it is, to the start. */
  reverse(): this {
    this.timeline.reverse(this.ticker.time)
    return this
  }

  /** Stops where it is, leaving the node at the values it currently shows. */
  pause(): this {
    this.timeline.pause()
    return this
  }

  /** Stops and jumps to `seconds` in. */
  seek(seconds: number): this {
    this.timeline.seek(seconds * 1000)
    return this
  }

  /** Stops and puts every attribute back to the value it was read at. */
  reset(): this {
    this.timeline.reset()
    return this
  }

  /** Stops and puts every attribute at its end value. */
  finish(): this {
    this.timeline.finish()
    return this
  }

  /**
   * Finishes with the tween: it stops, stops writing anything, and gives its attributes back so
   * another tween may take them. The node keeps whatever values it is showing.
   */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.pause()
    const owners = attributeOwners.get(this.node)
    if (owners) {
      for (const key of this.tracks.keys()) {
        if (owners.get(key) === this) owners.delete(key)
      }
    }
    this.tracks.clear()
  }

  /**
   * Reads where an attribute is now, works out what carries it to `end`, and takes the
   * attribute over from any tween already writing it.
   */
  private addAttr(key: string, end: unknown): void {
    if (!this.node.attributeNames().includes(key)) {
      throw new Error(
        `Tween: a ${this.node.nodeName} has no attribute '${key}'. ` +
          `The compound accessors are not attributes either - scaleX and scaleY rather than scale.`,
      )
    }

    // Built before anything is claimed, so a value with no midpoint leaves the node's tweens
    // exactly as they were rather than taking an attribute away from one and then throwing.
    const closed = (this.node as unknown as { closed?: unknown }).closed === true
    const track = trackFor(key, this.node.getAttr(key), end, closed)

    let owners = attributeOwners.get(this.node)
    if (!owners) {
      owners = new Map()
      attributeOwners.set(this.node, owners)
    }
    // The tween that held this attribute keeps running with the rest of its own; only the one
    // key moves across.
    owners.get(key)?.tracks.delete(key)
    owners.set(key, this)
    this.tracks.set(key, track)
  }

  /** Writes every attribute at an eased position. */
  private apply(position: number): void {
    for (const [key, track] of this.tracks) this.node.setAttr(key, track.valueAt(position))
  }

  /**
   * Writes the exact values of one end rather than the ones the arithmetic arrives at.
   *
   * Two things need it. A points list animated against a list of a different length runs
   * through a resampled stand-in, and what should be left behind is the list that was written;
   * and a colour animated to or from `null` - no fill at all - travels through a transparent
   * colour, which is a different state of the shape from having none.
   */
  private land(end: 'initialValue' | 'finalValue'): void {
    for (const [key, track] of this.tracks) this.node.setAttr(key, track[end])
  }

  /** Subscribes to the ticker while there is something to step, and drops off when there is not. */
  private syncTicker(): void {
    if (this.timeline.isRunning && !this.destroyed) this.ticker.add(this.timeline)
    else this.ticker.remove(this.timeline)
  }
}

/**
 * Builds a tween, plays it, and destroys it when it finishes - the fire-and-forget form, and
 * what `Node.to()` and `Camera2D.to()` both are.
 *
 * The tween is destroyed BEFORE the caller's own onFinish runs, so a handler that starts the
 * next animation on the same attributes finds them already free. That is what lets a sequence be
 * written as each step starting the one after it.
 */
export function startTween<T extends TweenTarget>(target: T, settings: TweenSettings): Tween<T> {
  const onFinish = settings.onFinish
  const tween: Tween<T> = new Tween<T>({
    ...settings,
    node: target,
    onFinish() {
      tween.destroy()
      onFinish?.call(this)
    },
  })
  tween.play()
  return tween
}
