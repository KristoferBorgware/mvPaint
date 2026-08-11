// What it means to be part-way between two values of an attribute.
//
// A tween reads an attribute, is told what it should end as, and then has to produce every
// value in between. `x` is a subtraction; the other attributes a scene is animated through are
// not, and each shape of value gets its own track here:
//
//   number             x, rotation, opacity, strokeWidth, radius, dashOffset, ...
//   colour             fill, stroke, shadowColor - per channel, in the engine's 0..1 tuple
//   point              fillLinearGradientStartPoint and the rest of the gradient geometry
//   number list        dash
//   point list         points, with the two lists brought to a common length (see resample)
//   gradient stops     fillLinearGradientColorStops and its radial twin: offset plus colour
//
// A track is built once, when the tween starts, and answers `valueAt(position)` from then on.
// The position is what the easing produced, which for Back and Elastic reaches outside 0..1 -
// so every track EXTRAPOLATES. A colour is the exception: channels are pulled back into 0..1,
// since a shader samples them clamped anyway and an alpha of 1.3 would read back as a value
// the shape never had.
//
// `initialValue` and `finalValue` are the exact values to land on rather than arrive at by
// arithmetic. Two things need them. A points list tweened against a list of a different length
// runs through a resampled stand-in, and the caller asked for the list it wrote; and a colour
// tweened to or from `null` travels through a transparent version of the other end, where
// `null` (no fill at all) is what it must finish as.

import { parseColor, parseStops, type ColorInput, type ColorStopsInput, type RGBA } from '../render/color'
import type { Vector2Like } from '../math/Vector2'
import type { GradientStop } from '../render/meshFormat'

/**
 * One attribute being carried from a start value to an end value.
 *
 * `valueAt(0)` and `valueAt(1)` are the ends as the arithmetic reaches them; `initialValue`
 * and `finalValue` are the ends as the caller wrote them, which is what a reset and a finish
 * assign. They differ only where the tweened form is a stand-in - see the file header.
 */
export interface AttrTrack {
  valueAt(position: number): unknown
  readonly initialValue: unknown
  readonly finalValue: unknown
}

/**
 * The attributes whose value is a colour, named rather than sniffed.
 *
 * A colour and a list of numbers are the same thing at a glance - `[1, 0, 0, 1]` is both a red
 * and a four-segment dash pattern - so the key decides, and only a value written as a STRING is
 * taken for a colour on any other attribute.
 */
export const COLOR_ATTRS: ReadonlySet<string> = new Set(['fill', 'stroke', 'shadowColor', 'tint'])

/**
 * The attributes that hold a gradient's stop list, and the one that holds a path's points.
 *
 * Both are attributes a caller may write in either of two forms - a list of objects, or the
 * same values flattened into one array - so both are put into the form the attribute reads back
 * as before anything is interpolated. Without that, `points: [0, 0, 100, 0]` would be taken for
 * a list of four numbers, which is exactly what the shape does NOT hold.
 */
const STOP_LIST_ATTRS: ReadonlySet<string> = new Set([
  'fillLinearGradientColorStops',
  'fillRadialGradientColorStops',
])
const POINT_LIST_ATTRS: ReadonlySet<string> = new Set(['points'])

function lerp(from: number, to: number, position: number): number {
  return from + (to - from) * position
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function isPoint(value: unknown): value is Vector2Like {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Vector2Like).x === 'number' &&
    typeof (value as Vector2Like).y === 'number'
  )
}

function isStop(value: unknown): value is GradientStop {
  return typeof value === 'object' && value !== null && typeof (value as GradientStop).offset === 'number'
}

/**
 * A track for one attribute: by name where the name settles it, and otherwise from the shape of
 * the two values.
 *
 * `closed` is read from the node for one purpose - a points list that closes has a segment from
 * its last point back to its first, which the resampling projects onto like any other.
 */
export function trackFor(key: string, start: unknown, end: unknown, closed: boolean): AttrTrack {
  if (typeof start === 'number' && typeof end === 'number') {
    return { valueAt: (position) => lerp(start, end, position), initialValue: start, finalValue: end }
  }

  if (COLOR_ATTRS.has(key) || readsAsColor(start) || readsAsColor(end)) {
    return colorTrack(start, end)
  }

  if (STOP_LIST_ATTRS.has(key)) {
    return stopListTrack(parseStops(start as ColorStopsInput), parseStops(end as ColorStopsInput))
  }

  if (POINT_LIST_ATTRS.has(key)) {
    return pointListTrack(toPoints(start), toPoints(end), closed)
  }

  if (Array.isArray(start) && Array.isArray(end)) {
    const sample = start.find((v) => v !== undefined) ?? end.find((v) => v !== undefined)
    if (sample === undefined) return constantTrack(end)
    if (typeof sample === 'number') return numberListTrack(start as number[], end as number[])
    if (isStop(sample)) return stopListTrack(start as GradientStop[], end as GradientStop[])
    if (isPoint(sample)) return pointListTrack(start as Vector2Like[], end as Vector2Like[], closed)
  }

  if (isPoint(start) && isPoint(end)) {
    return {
      valueAt: (position) => ({ x: lerp(start.x, end.x, position), y: lerp(start.y, end.y, position) }),
      initialValue: start,
      finalValue: end,
    }
  }

  throw new Error(
    `Tween: '${key}' holds ${describe(start)}, which has no midpoint. Numbers, colours, points, ` +
      `number lists, point lists and gradient stops are what a tween can carry.`,
  )
}

/**
 * True for a STRING parseColor accepts - the one shape of value that is a colour whatever
 * attribute it was written to. Asked rather than assumed, so a string attribute that is not a
 * colour falls through to the error at the bottom of trackFor rather than reporting a colour it
 * could not read.
 */
function readsAsColor(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    parseColor(value)
    return true
  } catch {
    return false
  }
}

/** A points list in the form the shape reads it back as, from either of the two it takes. */
function toPoints(value: unknown): Vector2Like[] {
  if (!Array.isArray(value)) {
    throw new Error(`Tween: a points list is an array of points or of alternating x and y, not ${describe(value)}.`)
  }
  if (value.length === 0 || isPoint(value[0])) return value as Vector2Like[]
  const out: Vector2Like[] = []
  for (let i = 0; i + 1 < value.length; i += 2) out.push({ x: value[i] as number, y: value[i + 1] as number })
  return out
}

function constantTrack(value: unknown): AttrTrack {
  return { valueAt: () => value, initialValue: value, finalValue: value }
}

/**
 * Per channel, in the engine's straight-alpha 0..1 tuple - the form a colour attribute reads
 * back as, so the tween writes what the shape would have written itself.
 *
 * `null` is a shape with no fill at all rather than a colour, so it has no channels to
 * interpolate. It stands in as the OTHER end's colour at zero alpha, which fades a fill in and
 * out through its own hue; travelling through black instead would flash a colour the design
 * never contained. The `null` end is then landed on exactly, since transparent-red and no fill
 * at all are different states of the shape.
 */
function colorTrack(start: unknown, end: unknown): AttrTrack {
  const from = start == null ? null : parseColor(start as ColorInput)
  const to = end == null ? null : parseColor(end as ColorInput)
  if (from === null && to === null) return constantTrack(null)

  const transparent = (c: RGBA): RGBA => [c[0], c[1], c[2], 0]
  const a = from ?? transparent(to as RGBA)
  const b = to ?? transparent(from as RGBA)
  return {
    valueAt: (position): RGBA => [
      clamp01(lerp(a[0], b[0], position)),
      clamp01(lerp(a[1], b[1], position)),
      clamp01(lerp(a[2], b[2], position)),
      clamp01(lerp(a[3], b[3], position)),
    ],
    initialValue: from,
    finalValue: to,
  }
}

/**
 * Element by element, over the longer of the two lists, with a missing element read as 0.
 *
 * That is what a dash pattern wants: growing `[10, 5]` into `[10, 5, 2, 5]` slides the two new
 * lengths out of nothing rather than leaving the tail unanimated.
 */
function numberListTrack(start: readonly number[], end: readonly number[]): AttrTrack {
  const length = Math.max(start.length, end.length)
  return {
    valueAt: (position) => {
      const out = new Array<number>(length)
      for (let i = 0; i < length; i++) out[i] = lerp(start[i] ?? 0, end[i] ?? 0, position)
      return out
    },
    initialValue: start,
    finalValue: end,
  }
}

/**
 * Point by point. Lists of different lengths are brought to a common one first (see resample),
 * and the ends are landed on exactly so the shape finishes holding the list that was written
 * rather than its stand-in.
 */
function pointListTrack(start: readonly Vector2Like[], end: readonly Vector2Like[], closed: boolean): AttrTrack {
  let from = start
  let to = end
  if (start.length !== end.length) {
    if (end.length > start.length) from = resample(start, end, closed)
    else to = resample(end, start, closed)
  }
  const length = Math.min(from.length, to.length)
  return {
    valueAt: (position) => {
      const out = new Array<Vector2Like>(length)
      for (let i = 0; i < length; i++) {
        out[i] = { x: lerp(from[i].x, to[i].x, position), y: lerp(from[i].y, to[i].y, position) }
      }
      return out
    },
    initialValue: start,
    finalValue: end,
  }
}

/**
 * `few` as a list of `many.length` points that lies along the same polyline: each of `many`'s
 * points projected onto its nearest place on `few`.
 *
 * A five-point line growing into an eight-point one has three points that do not exist yet, and
 * anything that invents them at the origin sends them across the scene on the first frame.
 * Projection starts each one on the outline it is joining, so the extra points slide along the
 * old shape into their places and the line looks like it is growing rather than exploding.
 */
function resample(few: readonly Vector2Like[], many: readonly Vector2Like[], closed: boolean): Vector2Like[] {
  if (few.length === 0) return many.map((p) => ({ x: p.x, y: p.y }))
  return many.map((point) => projectOntoPolyline(point, few, closed))
}

/** The nearest point to `point` anywhere on the polyline, by squared distance. */
function projectOntoPolyline(point: Vector2Like, line: readonly Vector2Like[], closed: boolean): Vector2Like {
  let best: Vector2Like = { x: line[0].x, y: line[0].y }
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < line.length; i++) {
    // The closing segment exists only on a closed contour; an open line stops at its last point.
    if (!closed && i === line.length - 1) break
    const a = line[i]
    const b = line[(i + 1) % line.length]
    const projected = projectOntoSegment(a, b, point)
    if (projected.distance < bestDistance) {
      bestDistance = projected.distance
      best = { x: projected.x, y: projected.y }
    }
  }
  return best
}

/** The nearest point on segment a..b, clamped to the segment's ends, with its squared distance. */
function projectOntoSegment(
  a: Vector2Like,
  b: Vector2Like,
  point: Vector2Like,
): { x: number; y: number; distance: number } {
  const lengthSquared = (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)
  let x: number
  let y: number
  if (lengthSquared === 0) {
    x = a.x
    y = a.y
  } else {
    const u = ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / lengthSquared
    if (u < 0) {
      x = a.x
      y = a.y
    } else if (u > 1) {
      x = b.x
      y = b.y
    } else {
      x = a.x + u * (b.x - a.x)
      y = a.y + u * (b.y - a.y)
    }
  }
  return { x, y, distance: (x - point.x) * (x - point.x) + (y - point.y) * (y - point.y) }
}

/**
 * Offset and colour per stop, over the longer list, with the shorter one's last stop repeated
 * to fill - so a two-stop gradient becoming a four-stop one grows its new stops out of the
 * colour that was already at that end.
 */
function stopListTrack(start: readonly GradientStop[], end: readonly GradientStop[]): AttrTrack {
  const length = Math.max(start.length, end.length)
  const at = (list: readonly GradientStop[], i: number): GradientStop =>
    list[Math.min(i, list.length - 1)] ?? { offset: 0, color: [0, 0, 0, 0] }
  return {
    valueAt: (position) => {
      const out = new Array<GradientStop>(length)
      for (let i = 0; i < length; i++) {
        const a = at(start, i)
        const b = at(end, i)
        out[i] = {
          offset: lerp(a.offset, b.offset, position),
          color: [
            clamp01(lerp(a.color[0], b.color[0], position)),
            clamp01(lerp(a.color[1], b.color[1], position)),
            clamp01(lerp(a.color[2], b.color[2], position)),
            clamp01(lerp(a.color[3], b.color[3], position)),
          ],
        }
      }
      return out
    },
    initialValue: start,
    finalValue: end,
  }
}

/** A value named in an error, short enough to read mid-sentence. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `an array of ${value.length}`
  return `the ${typeof value} ${JSON.stringify(value)}`
}
