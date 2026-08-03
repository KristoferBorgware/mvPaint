// Normalize an SVG path 'd' string into flat polygon contours. svgpath handles the
// grammar (absolute coords, smooth->explicit, arc->cubic, and optional matrix baking);
// we adaptively flatten the resulting cubic/quadratic segments into line points, split
// into one contour per subpath (closed when the subpath ends with Z).

import type { Vector2Like } from '../math/Vector2'
import svgpath from 'svgpath'
import type { Contour } from '../render/stroke'

export interface FlattenOptions {
  /** Max chord deviation (path units) allowed when flattening curves. Default 0.25. */
  tolerance?: number
  /** 2x3 transform matrix [a,b,c,d,e,f] baked into the points (e.g. an SVG element CTM). */
  matrix?: [number, number, number, number, number, number]
}

// Perpendicular distance from (px,py) to the line through (ax,ay)-(bx,by).
function pointLineDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  if (len < 1e-12) return Math.hypot(px - ax, py - ay)
  return Math.abs((px - ax) * dy - (py - ay) * dx) / len
}

/**
 * Adaptive de Casteljau subdivision: emit the cubic's interior/end points into `out`,
 * stopping when both control points sit within `tol` of the chord. The start point is
 * NOT emitted (the caller already has it as the current point), so consecutive segments
 * chain without duplicating their shared endpoint.
 *
 * Exported because glyph outlines need exactly this and nothing else about SVG path data
 * (see text/glyphOutline.ts): a font's contours arrive as the same move/line/curve/close
 * stream, just from a binary table instead of a `d` string.
 */
export function flattenCubic(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  tol: number, out: Vector2Like[], depth = 0,
): void {
  const d1 = pointLineDistance(x1, y1, x0, y0, x3, y3)
  const d2 = pointLineDistance(x2, y2, x0, y0, x3, y3)
  if (depth >= 18 || d1 + d2 <= tol) {
    out.push({ x: x3, y: y3 })
    return
  }
  const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2
  const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2
  const x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2
  const x012 = (x01 + x12) / 2, y012 = (y01 + y12) / 2
  const x123 = (x12 + x23) / 2, y123 = (y12 + y23) / 2
  const xm = (x012 + x123) / 2, ym = (y012 + y123) / 2
  flattenCubic(x0, y0, x01, y01, x012, y012, xm, ym, tol, out, depth + 1)
  flattenCubic(xm, ym, x123, y123, x23, y23, x3, y3, tol, out, depth + 1)
}

/** As flattenCubic, for a quadratic - the segment type TrueType outlines are built from. */
export function flattenQuadratic(
  x0: number, y0: number,
  cx: number, cy: number,
  x1: number, y1: number,
  tol: number, out: Vector2Like[],
): void {
  // Degree-elevate the quadratic to a cubic and reuse the cubic flattener.
  const c1x = x0 + (2 / 3) * (cx - x0), c1y = y0 + (2 / 3) * (cy - y0)
  const c2x = x1 + (2 / 3) * (cx - x1), c2y = y1 + (2 / 3) * (cy - y1)
  flattenCubic(x0, y0, c1x, c1y, c2x, c2y, x1, y1, tol, out)
}

/** Flatten an SVG path 'd' string into contours (points + closed flag). */
export function flattenPathData(d: string, options: FlattenOptions = {}): Contour[] {
  const tol = options.tolerance ?? 0.25

  let sp = svgpath(d).abs().unshort().unarc()
  if (options.matrix) sp = sp.matrix(options.matrix).abs()

  const contours: Contour[] = []
  let current: Vector2Like[] | null = null

  const finish = (closed: boolean) => {
    if (current && current.length >= 2) contours.push({ points: current, closed })
    current = null
  }
  // Start a contour from the current point if a draw command arrives with none open
  // (e.g. a subpath continuing after Z without an explicit M).
  const ensure = (x: number, y: number) => {
    if (!current) current = [{ x, y }]
  }

  sp.iterate((segment, _index, x, y) => {
    switch (segment[0]) {
      case 'M':
        finish(false)
        current = [{ x: segment[1], y: segment[2] }]
        break
      case 'L':
        ensure(x, y)
        current!.push({ x: segment[1], y: segment[2] })
        break
      case 'H':
        ensure(x, y)
        current!.push({ x: segment[1], y })
        break
      case 'V':
        ensure(x, y)
        current!.push({ x, y: segment[1] })
        break
      case 'C':
        ensure(x, y)
        flattenCubic(x, y, segment[1], segment[2], segment[3], segment[4], segment[5], segment[6], tol, current!)
        break
      case 'Q':
        ensure(x, y)
        flattenQuadratic(x, y, segment[1], segment[2], segment[3], segment[4], tol, current!)
        break
      case 'Z':
      case 'z':
        finish(true)
        break
    }
  })
  finish(false)

  return contours
}
