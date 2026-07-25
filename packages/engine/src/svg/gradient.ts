// Convert a parsed SVG gradient into our Shape fill parameters, in the element's LOCAL
// coordinate space (the loader bakes the element CTM into the resulting points/radii
// afterward, exactly as it does the geometry, so the gradient stays aligned).
//
// SVG's two-circle radial gradient (focal point + outer circle) maps directly onto our
// shader's two-circle radial (start center/radius = focal/0, end center/radius = cx,cy/r).
// Non-uniform scale on a radial gradient is approximated (our shader draws circles, not
// ellipses); linear gradients are exact under any affine transform.

import type { GradientStop, Point2, RGBA } from '../render/meshFormat'
import { applyPoint, scaleFactor, type Mat2x3 } from './matrix'

export type GradientUnits = 'userSpaceOnUse' | 'objectBoundingBox'

export interface SvgGradientStop {
  offset: number
  color: RGBA
}

export interface SvgLinearGradient {
  type: 'linear'
  units: GradientUnits
  transform: Mat2x3
  stops: SvgGradientStop[]
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface SvgRadialGradient {
  type: 'radial'
  units: GradientUnits
  transform: Mat2x3
  stops: SvgGradientStop[]
  cx: number
  cy: number
  r: number
  fx: number
  fy: number
}

export type SvgGradient = SvgLinearGradient | SvgRadialGradient

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface LinearGradientFill {
  fillPriority: 'linear-gradient'
  start: Point2
  end: Point2
  stops: GradientStop[]
}
export interface RadialGradientFill {
  fillPriority: 'radial-gradient'
  start: Point2
  startRadius: number
  end: Point2
  endRadius: number
  stops: GradientStop[]
}
export type GradientFill = LinearGradientFill | RadialGradientFill

// Map an authored gradient coordinate into local space. For objectBoundingBox, the
// coordinate is a fraction of the bounding box (gradientTransform applies in that
// fractional space); for userSpaceOnUse it is a local length (gradientTransform applies
// directly).
function toLocal(gx: number, gy: number, g: SvgGradient, bbox: Bounds): Point2 {
  if (g.units === 'objectBoundingBox') {
    const t = applyPoint(g.transform, gx, gy)
    return { x: bbox.x + t.x * bbox.width, y: bbox.y + t.y * bbox.height }
  }
  return applyPoint(g.transform, gx, gy)
}

function localRadius(r: number, g: SvgGradient, bbox: Bounds): number {
  const base =
    g.units === 'objectBoundingBox' ? r * (Math.hypot(bbox.width, bbox.height) / Math.SQRT2) : r
  return base * scaleFactor(g.transform)
}

const toStops = (stops: SvgGradientStop[]): GradientStop[] =>
  stops.map((s) => ({ offset: s.offset, color: s.color }))

export function gradientToFill(g: SvgGradient, bbox: Bounds): GradientFill {
  if (g.type === 'linear') {
    return {
      fillPriority: 'linear-gradient',
      start: toLocal(g.x1, g.y1, g, bbox),
      end: toLocal(g.x2, g.y2, g, bbox),
      stops: toStops(g.stops),
    }
  }
  return {
    fillPriority: 'radial-gradient',
    start: toLocal(g.fx, g.fy, g, bbox),
    startRadius: 0,
    end: toLocal(g.cx, g.cy, g, bbox),
    endRadius: localRadius(g.r, g, bbox),
    stops: toStops(g.stops),
  }
}
