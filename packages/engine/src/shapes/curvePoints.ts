// Turning a Polyline's point list into the curve it stands for.
//
// A raw list is a sequence of corners. Two readings give it curves instead: `tension` smooths a
// path THROUGH its points (a Catmull-Rom spline, each span converted to a cubic), and `bezier`
// reads the list as control points to be FOLLOWED (a start point then groups of three). Both end
// in a flat point list, because the stroker and the triangulator work on line segments and
// nothing downstream of a shape knows what a curve is.

import type { Vector2Like } from '../math/Vector2'
import { flattenCubic } from '../svg/flattenPath'

/** Max chord deviation allowed when a curve becomes segments, in the shape's local units. */
export const CURVE_TOLERANCE = 0.25

// Index into a list that either wraps (a closed loop has a point before its first) or clamps
// (an open path does not, so the end point stands in for its own neighbour).
function at(points: readonly Vector2Like[], i: number, closed: boolean): Vector2Like {
  const n = points.length
  if (closed) return points[((i % n) + n) % n]
  return points[Math.min(Math.max(i, 0), n - 1)]
}

/**
 * A Catmull-Rom spline through every point, flattened.
 *
 * Each span p1->p2 becomes the cubic whose control points lean along the neighbours' chords,
 * c1 = p1 + (p2 - p0)·t/6 and c2 = p2 - (p3 - p1)·t/6, which is the standard Catmull-Rom to
 * Bezier conversion: at t = 1 the curve is the uniform spline, at 0 it is the straight list
 * back again, and above 1 it overshoots. The sixth is what makes the two agree at t = 1.
 *
 * The list comes back unchanged below three points, where there are no neighbours to lean on.
 */
export function smoothPoints(
  points: readonly Vector2Like[],
  tension: number,
  closed: boolean,
  tolerance = CURVE_TOLERANCE,
): readonly Vector2Like[] {
  if (tension <= 0 || points.length < 3) return points

  const out: Vector2Like[] = [{ x: points[0].x, y: points[0].y }]
  const spans = closed ? points.length : points.length - 1
  for (let i = 0; i < spans; i++) {
    const p0 = at(points, i - 1, closed)
    const p1 = at(points, i, closed)
    const p2 = at(points, i + 1, closed)
    const p3 = at(points, i + 2, closed)
    const k = tension / 6
    flattenCubic(
      p1.x, p1.y,
      p1.x + (p2.x - p0.x) * k, p1.y + (p2.y - p0.y) * k,
      p2.x - (p3.x - p1.x) * k, p2.y - (p3.y - p1.y) * k,
      p2.x, p2.y,
      tolerance, out,
    )
  }
  // A closed run ends back on the first point, and the contour's own closing segment is what
  // draws that span - so the repeat would be a zero-length edge at the seam.
  if (closed) out.pop()
  return out
}

/**
 * The list read as cubic control points - a start point followed by groups of three (two
 * controls and an end point) - flattened into segments.
 *
 * A trailing group of one or two points is not a curve, so it is taken as straight segments
 * rather than dropped: a list being edited a point at a time passes through those lengths.
 */
export function bezierPoints(
  points: readonly Vector2Like[],
  tolerance = CURVE_TOLERANCE,
): readonly Vector2Like[] {
  if (points.length < 4) return points

  const out: Vector2Like[] = [{ x: points[0].x, y: points[0].y }]
  let i = 1
  for (; i + 2 < points.length; i += 3) {
    const from = out[out.length - 1]
    flattenCubic(
      from.x, from.y,
      points[i].x, points[i].y,
      points[i + 1].x, points[i + 1].y,
      points[i + 2].x, points[i + 2].y,
      tolerance, out,
    )
  }
  for (; i < points.length; i++) out.push({ x: points[i].x, y: points[i].y })
  return out
}
