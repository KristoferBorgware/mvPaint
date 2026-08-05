// SVG elliptical arcs as cubic Béziers.
//
// A path's `A` command names an arc by its ENDPOINT: two radii, an x-axis rotation, two flags
// and a destination. Drawing it needs the CENTRE, the start angle and the sweep, and the
// conversion between the two parameterizations is given in the SVG 1.1 specification, appendix
// F.6.5, with the out-of-range corrections in F.6.2 and F.6.6. This file is that appendix,
// written in TypeScript. Section numbers appear against each step so a reader can check the
// arithmetic against the source.
//
// Cubics rather than arcs, because everything downstream of here - flattening, stroking,
// transforming - handles one curve type. An affine matrix maps a cubic's control points to the
// transformed cubic, which is what lets flattenPath bake an element's CTM into a path without
// any of this arithmetic running a second time. The same matrix applied to `rx`, `ry` and the
// rotation of a live arc is a much harder problem, and converting first means never facing it.
//
// Written from the specification. `svgpath`, which this replaces, solves the same problem.

const TAU = Math.PI * 2

/** One cubic segment: two control points and an endpoint. The start is the caller's cursor. */
export type Cubic = readonly [c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number]

/**
 * The arc from (x1, y1) to (x2, y2), as cubics.
 *
 * `rotationDeg` is the x-axis-rotation in degrees, as the `A` command writes it. `largeArc` and
 * `sweep` are its two flags: which of the two arcs joining the endpoints to take, and which
 * direction to sweep.
 *
 * Empty when the endpoints coincide - F.6.2 makes that arc nothing at all. A zero radius is
 * also F.6.2: the arc becomes a straight line, returned as the cubic whose control points sit
 * on its endpoints, so a caller that only knows how to draw curves still draws the right shape.
 */
export function arcToCubics(
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): Cubic[] {
  // F.6.2: "If the endpoints are identical, this is equivalent to omitting the arc."
  if (x1 === x2 && y1 === y2) return []
  // F.6.2: "If rx = 0 or ry = 0, this is a straight line."
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]]

  const phi = ((rotationDeg % 360) * Math.PI) / 180
  const cosPhi = Math.cos(phi)
  const sinPhi = Math.sin(phi)

  // F.6.5.1: the midpoint-relative endpoint, rotated into the ellipse's own frame.
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cosPhi * dx + sinPhi * dy
  const y1p = -sinPhi * dx + cosPhi * dy

  // F.6.6.2: radii too small to span the chord are scaled up until they exactly span it.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    const s = Math.sqrt(lambda)
    rx *= s
    ry *= s
  }

  // F.6.5.2: the centre, still in the ellipse's frame. The radicand is clamped at zero because
  // a lambda of exactly 1 can land a few ulps below it.
  const rx2 = rx * rx
  const ry2 = ry * ry
  const x1p2 = x1p * x1p
  const y1p2 = y1p * y1p
  const numerator = Math.max(0, rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2)
  const denominator = rx2 * y1p2 + ry2 * x1p2
  const coefficient = (largeArc === sweep ? -1 : 1) * Math.sqrt(numerator / denominator)
  const cxp = (coefficient * (rx * y1p)) / ry
  const cyp = (coefficient * -(ry * x1p)) / rx

  // F.6.5.3: rotate the centre back out into path space.
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2

  // F.6.5.5 and F.6.5.6: the start angle, and how far to sweep. The flags decide which way
  // round: a sweep is signed, and the two corrections below pick the arc the flags asked for
  // out of the two the angles alone describe.
  const ux = (x1p - cxp) / rx
  const uy = (y1p - cyp) / ry
  const vx = (-x1p - cxp) / rx
  const vy = (-y1p - cyp) / ry
  const theta1 = Math.atan2(uy, ux)
  let sweepAngle = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  if (!sweep && sweepAngle > 0) sweepAngle -= TAU
  if (sweep && sweepAngle < 0) sweepAngle += TAU

  // A cubic approximates a circular arc well up to about a quarter turn, so the sweep is cut
  // into equal pieces of at most that. `alpha` is the control-point distance that makes the
  // cubic meet the ellipse at both ends with the right tangent there.
  const count = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2) - 1e-12))
  const delta = sweepAngle / count
  const alpha = (4 / 3) * Math.tan(delta / 4)

  // A point on the ellipse at angle t, and the derivative that gives the tangent there.
  const pointAt = (t: number): [number, number] => [
    cx + rx * Math.cos(t) * cosPhi - ry * Math.sin(t) * sinPhi,
    cy + rx * Math.cos(t) * sinPhi + ry * Math.sin(t) * cosPhi,
  ]
  const tangentAt = (t: number): [number, number] => [
    -rx * Math.sin(t) * cosPhi - ry * Math.cos(t) * sinPhi,
    -rx * Math.sin(t) * sinPhi + ry * Math.cos(t) * cosPhi,
  ]

  const out: Cubic[] = []
  for (let i = 0; i < count; i++) {
    const from = theta1 + i * delta
    const to = from + delta
    const [fx, fy] = pointAt(from)
    const [ftx, fty] = tangentAt(from)
    const [tx, ty] = pointAt(to)
    const [ttx, tty] = tangentAt(to)
    out.push([fx + alpha * ftx, fy + alpha * fty, tx - alpha * ttx, ty - alpha * tty, tx, ty])
  }
  // The last endpoint is the arc's destination by construction; assign it exactly, so a caller
  // comparing cursors against the `d` string's own numbers sees them agree.
  const last = out[out.length - 1]
  out[out.length - 1] = [last[0], last[1], last[2], last[3], x2, y2]
  return out
}
