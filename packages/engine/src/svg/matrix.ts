// 2x3 affine matrices in SVG convention: [a, b, c, d, e, f] maps a point (x, y) to
// (a*x + c*y + e, b*x + d*y + f). Used to accumulate an element's CTM down the SVG tree
// and to bake it into flattened contour points and gradient coordinates.

import type { Vector2Like } from '../math/Vector2'
import type { Contour } from '../render/stroke'

export type Mat2x3 = [number, number, number, number, number, number]

export const IDENTITY: Mat2x3 = [1, 0, 0, 1, 0, 0]

/** Compose so the result maps p -> m1(m2(p)) (m1 is applied after m2). */
export function multiply(m1: Mat2x3, m2: Mat2x3): Mat2x3 {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

export function applyPoint(m: Mat2x3, x: number, y: number): Vector2Like {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

/** Uniform scale factor of the matrix (sqrt of |determinant|); scales stroke widths. */
export function scaleFactor(m: Mat2x3): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
}

export function transformContours(contours: readonly Contour[], m: Mat2x3): Contour[] {
  return contours.map((c) => ({
    points: c.points.map((p) => applyPoint(m, p.x, p.y)),
    closed: c.closed,
  }))
}

const DEG2RAD = Math.PI / 180

// Matrix for a single SVG transform function.
function transformFunction(name: string, args: number[]): Mat2x3 {
  switch (name) {
    case 'translate':
      return [1, 0, 0, 1, args[0] || 0, args[1] || 0]
    case 'scale': {
      const sx = args[0] ?? 1
      return [sx, 0, 0, args[1] ?? sx, 0, 0]
    }
    case 'rotate': {
      const a = (args[0] || 0) * DEG2RAD
      const cos = Math.cos(a)
      const sin = Math.sin(a)
      const rot: Mat2x3 = [cos, sin, -sin, cos, 0, 0]
      if (args.length >= 3) {
        const cx = args[1]
        const cy = args[2]
        return multiply([1, 0, 0, 1, cx, cy], multiply(rot, [1, 0, 0, 1, -cx, -cy]))
      }
      return rot
    }
    case 'skewX':
      return [1, 0, Math.tan((args[0] || 0) * DEG2RAD), 1, 0, 0]
    case 'skewY':
      return [1, Math.tan((args[0] || 0) * DEG2RAD), 0, 1, 0, 0]
    case 'matrix':
      return [args[0], args[1], args[2], args[3], args[4], args[5]]
    default:
      return IDENTITY
  }
}

/** Parse an SVG `transform` attribute string into a single composed matrix. */
export function parseTransform(str: string | null | undefined): Mat2x3 {
  if (!str) return IDENTITY
  let m = IDENTITY
  const re = /(\w+)\s*\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(str)) !== null) {
    const name = match[1]
    const args = match[2]
      .split(/[\s,]+/)
      .filter((s) => s.length > 0)
      .map(Number)
    m = multiply(m, transformFunction(name, args))
  }
  return m
}
