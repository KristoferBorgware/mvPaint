// Text on a path: a curve that drives where each glyph sits and which way it faces.
//
// The shaper lays a block out on a straight baseline first, exactly as it always does, and
// this bends the result afterwards. Each glyph keeps its own metrics, kerning and styling;
// what changes is that the point of the baseline under it is moved onto the curve and the
// glyph is turned to match the curve's direction there. A glyph's height above the baseline
// becomes its distance out along the curve's normal, so ascenders lean outward on a circle
// and text set inside one hangs the other way.
//
// Working on the shaped result rather than inside the shaper is what keeps this one piece of
// code rather than two: horizontal and vertical layout, wrapping, alignment, decorations,
// shadows and glows all produce quads, and quads are all this needs. It also means the curve
// costs nothing at all until something asks for one.
//
// The curve itself is a polyline with an arc-length table, so distance along it is exact for
// the geometry given and every lookup is a binary search. Curves arrive already flattened -
// svg/flattenPath turns path data into contours, and arcPath/circlePath below build the two
// cases that come up most - which is why nothing here evaluates a bezier.

import type { Contour } from '../render/stroke'
import type { Point2 } from '../render/meshFormat'
import type { ShapedText } from './layout'
import { quadCorner, type TextQuad } from './textQuad'

/** A point on the curve and the direction the curve runs there. */
export interface PathSample {
  x: number
  y: number
  /** Tangent direction in radians, counter-clockwise from +x. */
  angle: number
}

/** Default flattening error for the generated arcs, in world units - matches svg/flattenPath. */
const ARC_TOLERANCE = 0.25

// How finely a decoration or highlight is chopped up to follow a curve. A rule is a single
// long rectangle on a straight baseline and cannot bend, so it becomes a row of short ones;
// this is the longest any of them may be, in world units. Small enough that the joints do not
// show at ordinary text sizes, large enough that a highlighted paragraph does not explode
// into thousands of quads.
const DECORATION_STEP = 4
const MAX_DECORATION_SEGMENTS = 512

/** Beyond this turn between segments, a join is a corner of the path, not flattening. */
const CORNER_TURN = Math.PI / 6

/** The equivalent angle in (-pi, pi], so differences are the short way round. */
function wrapAngle(a: number): number {
  return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))
}

// A gentle join is met at the bisector from both sides, so the direction is continuous
// across it. A corner is not blended at all: each segment keeps its own direction right up
// to the corner, and the text pivots there rather than leaning into the turn on approach.

/** The direction just after a join, entering segment `own` from `prev`. */
function joinStart(prev: number, own: number): number {
  const turn = wrapAngle(own - prev)
  return Math.abs(turn) > CORNER_TURN ? own : own - turn / 2
}

/** The direction just before a join, leaving segment `own` towards `next`. */
function joinEnd(own: number, next: number): number {
  const turn = wrapAngle(next - own)
  return Math.abs(turn) > CORNER_TURN ? own : own + turn / 2
}

/**
 * A polyline with an arc-length table: converts a distance along the curve into a point and
 * a direction. Immutable, and reusable across as many text nodes as want the same curve.
 */
export class TextPathGeometry {
  readonly closed: boolean
  /** Total arc length in world units. */
  readonly length: number

  private readonly xs: Float64Array
  private readonly ys: Float64Array
  /** Cumulative distance at each point; cum[0] is 0 and cum[n-1] is `length`. */
  private readonly cum: Float64Array
  /** Direction at each end of segment i, blended with its neighbours across a smooth join. */
  private readonly startAngles: Float64Array
  private readonly endAngles: Float64Array

  private constructor(xs: Float64Array, ys: Float64Array, cum: Float64Array, angles: Float64Array, closed: boolean) {
    this.xs = xs
    this.ys = ys
    this.cum = cum
    this.closed = closed
    this.length = cum[cum.length - 1]

    // A flattened curve is a run of straight segments, so its direction changes in steps: on
    // a circle of radius 115 flattened to a quarter unit, the step is about 7.6 degrees, and
    // consecutive glyphs would visibly stair-step rather than turn evenly. Blending the
    // direction across each join spreads that step out over the segment.
    //
    // Only gentle joins are blended. A turn sharper than CORNER_TURN is taken to be a real
    // corner of the path rather than an artefact of flattening, and text going round it
    // should pivot there, not lean into the turn on the approach.
    const n = angles.length
    this.startAngles = new Float64Array(n)
    this.endAngles = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? i - 1 : closed ? n - 1 : -1
      const next = i < n - 1 ? i + 1 : closed ? 0 : -1
      this.startAngles[i] = prev >= 0 ? joinStart(angles[prev], angles[i]) : angles[i]
      this.endAngles[i] = next >= 0 ? joinEnd(angles[i], angles[next]) : angles[i]
    }
  }

  /**
   * Builds a curve from a run of points. Repeated points are dropped - a zero-length segment
   * has no direction to give a glyph - and a closed curve is completed back to its start.
   */
  static fromPoints(points: readonly Point2[], closed = false): TextPathGeometry {
    const xs: number[] = []
    const ys: number[] = []
    for (const p of points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
      const n = xs.length
      if (n > 0 && xs[n - 1] === p.x && ys[n - 1] === p.y) continue
      xs.push(p.x)
      ys.push(p.y)
    }
    if (closed && xs.length > 1 && (xs[0] !== xs[xs.length - 1] || ys[0] !== ys[ys.length - 1])) {
      xs.push(xs[0])
      ys.push(ys[0])
    }
    if (xs.length < 2) {
      throw new Error('TextPathGeometry: a path needs at least two distinct points to have a direction')
    }

    const cum = new Float64Array(xs.length)
    const angles = new Float64Array(xs.length - 1)
    for (let i = 1; i < xs.length; i++) {
      const dx = xs[i] - xs[i - 1]
      const dy = ys[i] - ys[i - 1]
      cum[i] = cum[i - 1] + Math.hypot(dx, dy)
      angles[i - 1] = Math.atan2(dy, dx)
    }
    return new TextPathGeometry(Float64Array.from(xs), Float64Array.from(ys), cum, angles, closed)
  }

  /**
   * Builds a curve from flattened path data - the output of svg/flattenPath, so any path an
   * SVG can describe can carry text. Only the first subpath is used: text runs along one
   * curve, and jumping to the next subpath would put a straight leap in the middle of it.
   */
  static fromContours(contours: readonly Contour[]): TextPathGeometry {
    const first = contours.find((c) => c.points.length >= 2)
    if (!first) throw new Error('TextPathGeometry: no subpath with at least two points')
    return TextPathGeometry.fromPoints(first.points, first.closed ?? false)
  }

  /** The same curve walked the other way. Distance 0 becomes what was the far end. */
  reversed(): TextPathGeometry {
    const points: Point2[] = []
    for (let i = this.xs.length - 1; i >= 0; i--) points.push({ x: this.xs[i], y: this.ys[i] })
    return TextPathGeometry.fromPoints(points, this.closed)
  }

  /**
   * The point and direction at a distance along the curve. A closed curve wraps, so any
   * distance lands somewhere; an open one returns null outside its ends, which is what drops
   * a glyph that has run off the end rather than piling it up at the last point.
   */
  sampleAt(distance: number): PathSample | null {
    let d = distance
    if (this.closed) {
      d = ((d % this.length) + this.length) % this.length
    } else if (d < 0 || d > this.length) {
      return null
    }

    // The last point of a segment table has no segment of its own; clamp into the last one.
    let lo = 0
    let hi = this.cum.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (this.cum[mid] <= d) lo = mid
      else hi = mid
    }

    const span = this.cum[lo + 1] - this.cum[lo]
    const t = span > 0 ? (d - this.cum[lo]) / span : 0
    const from = this.startAngles[lo]
    return {
      x: this.xs[lo] + (this.xs[lo + 1] - this.xs[lo]) * t,
      y: this.ys[lo] + (this.ys[lo + 1] - this.ys[lo]) * t,
      angle: from + wrapAngle(this.endAngles[lo] - from) * t,
    }
  }
}

export interface ArcPathOptions {
  /** Centre of the arc; default the origin. */
  center?: Point2
  /** Flattening error in world units; smaller means more segments. Default 0.25. */
  tolerance?: number
  /** Fixed segment count, overriding what `tolerance` would choose. */
  segments?: number
}

/**
 * An arc of `sweep` radians starting at `startAngle`, measured counter-clockwise from +x.
 * A negative sweep runs clockwise.
 *
 * Which way it runs decides which side of the curve the text ends up on, because a glyph's
 * up direction is the curve's left normal: text on a clockwise arc stands on the outside,
 * text on a counter-clockwise one hangs from the inside.
 */
export function arcPath(radius: number, startAngle: number, sweep: number, options: ArcPathOptions = {}): TextPathGeometry {
  return TextPathGeometry.fromPoints(arcPoints(radius, startAngle, sweep, options, true), false)
}

export interface CirclePathOptions extends ArcPathOptions {
  /** Where distance 0 sits, counter-clockwise from +x. Default Math.PI/2 - the top. */
  startAngle?: number
  /** Default true, which stands the text upright on the outside of the circle. */
  clockwise?: boolean
}

/**
 * A full circle, closed, starting at the top and running clockwise by default - the
 * arrangement that reads left to right across the top of the circle with the letters
 * standing up off it. Centre the text on it (align 'center', startOffset 0) and it sits
 * symmetrically about the top; set `clockwise` false for text that reads along the bottom.
 */
export function circlePath(radius: number, options: CirclePathOptions = {}): TextPathGeometry {
  const startAngle = options.startAngle ?? Math.PI / 2
  const sweep = (options.clockwise ?? true) ? -Math.PI * 2 : Math.PI * 2
  // The closing point is left off and the curve closed instead: coming back round to the
  // start angle does not reproduce the first point exactly, and the difference would show up
  // as a stray hair of a segment at the seam.
  return TextPathGeometry.fromPoints(arcPoints(radius, startAngle, sweep, options, false), true)
}

/**
 * The corners of an arc, flattened to the requested tolerance. `includeEnd` is false for a
 * closed curve, whose final point is its first.
 */
function arcPoints(radius: number, startAngle: number, sweep: number, options: ArcPathOptions, includeEnd: boolean): Point2[] {
  if (!(radius > 0) || !Number.isFinite(radius)) throw new Error(`arcPath: radius must be positive, got ${radius}`)
  const cx = options.center?.x ?? 0
  const cy = options.center?.y ?? 0

  // Chord error for a step of dtheta is r(1 - cos(dtheta/2)); solve it for the tolerance.
  const tolerance = Math.min(options.tolerance ?? ARC_TOLERANCE, radius)
  const maxStep = 2 * Math.acos(Math.max(-1, 1 - tolerance / radius))
  const segments = options.segments ?? Math.max(2, Math.ceil(Math.abs(sweep) / maxStep))

  const points: Point2[] = []
  const last = includeEnd ? segments : segments - 1
  for (let i = 0; i <= last; i++) {
    const a = startAngle + (sweep * i) / segments
    points.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius })
  }
  return points
}

/** Where the text sits relative to `startOffset`. */
export type TextPathAlign = 'start' | 'center' | 'end'

/**
 * Which side of the curve the text stands on. 'right' walks the curve backwards, which both
 * flips the text over and reverses its direction - the way to set the lower half of a circle
 * so it reads the right way up.
 */
export type TextPathSide = 'left' | 'right'

export interface TextPathOptions {
  path: TextPathGeometry
  /** Distance along the curve the text is positioned from. Default 0. */
  startOffset?: number
  /** Whether `startOffset` is the text's start, middle or end. Default 'start'. */
  align?: TextPathAlign
  side?: TextPathSide
  /**
   * Shifts every glyph along the curve's normal, away from the left side for positive values.
   * Lifts text clear of the curve, or drops it under.
   */
  offset?: number
}

/**
 * Maps an already-shaped block onto a curve.
 *
 * `referenceBaseline` is the y of the block's first baseline: it is the line that lands ON
 * the curve, and every other line keeps its distance from it, measured along the normal. So
 * a two-line block on a circle becomes two concentric rings with their usual leading between
 * them, rather than both collapsing onto the same one.
 *
 * Glyphs are placed by the middle of their box, which is what decides whether a glyph is
 * still on an open curve. One that is not is dropped, so text longer than its curve is cut
 * off at the end rather than bunching up there.
 */
export function bendOntoPath(shaped: ShapedText, options: TextPathOptions, referenceBaseline: number): ShapedText {
  const path = options.side === 'right' ? options.path.reversed() : options.path
  const normalOffset = options.offset ?? 0

  const align = options.align ?? 'start'
  const anchorShift = align === 'center' ? -shaped.width / 2 : align === 'end' ? -shaped.width : 0
  const base = (options.startOffset ?? 0) + anchorShift

  const out: TextQuad[] = []
  for (const quad of shaped.quads) {
    if (quad.isGlyph) {
      const bent = bendQuad(quad, path, base, referenceBaseline, normalOffset, quad.x0, quad.x1)
      if (bent) out.push(bent)
      continue
    }
    // A rule or highlight spans a whole run, so it is cut into pieces short enough that each
    // can be turned to follow the curve on its own.
    const width = quad.x1 - quad.x0
    const count = Math.min(MAX_DECORATION_SEGMENTS, Math.max(1, Math.ceil(width / DECORATION_STEP)))
    for (let i = 0; i < count; i++) {
      const x0 = quad.x0 + (width * i) / count
      const x1 = quad.x0 + (width * (i + 1)) / count
      const piece = bendQuad({ ...quad, x0, x1 }, path, base, referenceBaseline, normalOffset, x0, x1)
      if (piece) out.push(piece)
    }
  }

  return { ...shaped, quads: out, ...extentOf(out) }
}

/**
 * Moves one quad onto the curve: the baseline point under its middle goes to the matching
 * point on the curve, and the quad turns to the curve's direction about that point.
 */
function bendQuad(
  quad: TextQuad,
  path: TextPathGeometry,
  base: number,
  referenceBaseline: number,
  normalOffset: number,
  anchorX0: number,
  anchorX1: number,
): TextQuad | null {
  const anchorX = (anchorX0 + anchorX1) / 2
  const sample = path.sampleAt(base + anchorX)
  if (!sample) return null

  // How far this quad's own baseline sits from the block's first one, carried out along the
  // curve's left normal so lines stay spaced and a glyph's ascent points off the curve.
  const perpendicular = quad.originY - referenceBaseline + normalOffset
  const nx = -Math.sin(sample.angle)
  const ny = Math.cos(sample.angle)
  const targetX = sample.x + nx * perpendicular
  const targetY = sample.y + ny * perpendicular

  const dx = targetX - anchorX
  const dy = targetY - quad.originY

  return {
    ...quad,
    x0: quad.x0 + dx,
    x1: quad.x1 + dx,
    y0: quad.y0 + dy,
    y1: quad.y1 + dy,
    originX: quad.originX + dx,
    originY: quad.originY + dy,
    skewPivotY: quad.skewPivotY + dy,
    rotation: sample.angle,
    rotationPivotX: targetX,
    rotationPivotY: targetY,
  }
}

/** The block extent of a bent result, measured from the quads' actual turned corners. */
function extentOf(quads: readonly TextQuad[]): { width: number; height: number } {
  if (quads.length === 0) return { width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const q of quads) {
    for (const [x, y] of [
      [q.x0, q.y0],
      [q.x1, q.y0],
      [q.x1, q.y1],
      [q.x0, q.y1],
    ]) {
      const p = quadCorner(q, x, y)
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
  }
  return { width: maxX - minX, height: maxY - minY }
}
