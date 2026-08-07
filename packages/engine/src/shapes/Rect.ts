// Rect - a filled, optionally stroked rectangle, with square or rounded corners. Its
// TOP-LEFT corner sits at (x, y) in the Z=0 plane (before any offset), and it extends
// right and down from there: the scene is y-down, so the rectangle spans x in [0, width]
// and y in [0, height] in its own local space. Sized width×height, transformed by the
// common Shape parameters (position, scale, rotation, offset). See Shape's header for
// which shapes are cornered and which centred.
//
// Rotation and scale are about the local origin, so a rectangle turns about its top-left
// corner unless given an offset - `offsetX: width / 2, offsetY: height / 2` puts the
// pivot back in the middle. It owns no GPU resources: it tessellates its fill
// in the mesh lane (fill color or gradient, via the inherited Shape fill API) and
// strokes its own outline through the shared general-purpose stroker, using the
// inherited stroke/lineJoin/miterLimit (the outline is always closed, so lineCap is
// irrelevant).
//
// CORNERS. cornerRadius rounds them: one value for all four, or [topLeft, topRight,
// bottomRight, bottomLeft] to round them independently. A radius bigger than the
// rectangle can hold is scaled down rather than clipped - all four shrink by one common
// factor, so the corners stay in proportion to each other instead of the largest one
// alone absorbing the whole correction. At radius 0 the geometry is exactly the four
// vertices it always was: rounding is opt-in and costs the common case nothing.
//
// A square corner is 90 degrees, so 'miter' - Shape's default join - lands exactly on the
// diagonal bisector, and Rect keeps that default. On a rounded corner the arc is a
// polyline, and miter reproduces its exact outward offset: faithful to the flattening,
// which means it inherits the flattening's faceting. Pass lineJoin: 'round' to round the
// joins instead, as Circle does by default for the same reason - the difference is on the
// order of the chord tolerance the arc was flattened at.

import type { Vector2Like } from '../math/Vector2'
import { circleSegments } from './Circle'
import { Shape, type ShapeOptions } from './Shape'
import type { MeshSink } from '../render/meshFormat'
import {strokePolyline} from '../render/stroke'

/** One radius for every corner, or [topLeft, topRight, bottomRight, bottomLeft]. */
export type CornerRadius = number | readonly [number, number, number, number]

export interface RectOptions extends ShapeOptions {
  cornerRadius?: CornerRadius
  /** Override the adaptive segment count per corner arc (mainly for testing). */
  cornerSegments?: number
}

/** [topLeft, topRight, bottomRight, bottomLeft], as buildGeometry() consumes them. */
type Radii = [number, number, number, number]

/**
 * The requested radii, made to fit: negatives dropped, then every radius scaled by one
 * common factor if any edge is too short for the two radii meeting on it. This is the
 * CSS rule, and the reason it uses a single factor is that per-corner clamping would let
 * one oversized corner change the shape of its neighbours.
 */
function fitRadii(radius: CornerRadius, width: number, height: number): Radii {
  const raw: Radii =
    typeof radius === 'number' ? [radius, radius, radius, radius] : [radius[0], radius[1], radius[2], radius[3]]
  const r: Radii = [
    Math.max(0, raw[0]) || 0,
    Math.max(0, raw[1]) || 0,
    Math.max(0, raw[2]) || 0,
    Math.max(0, raw[3]) || 0,
  ]
  const w = Math.max(0, width)
  const h = Math.max(0, height)
  // Each edge is shared by two corners: top by tl+tr, right by tr+br, and so on.
  let scale = 1
  for (const [sum, span] of [
    [r[0] + r[1], w],
    [r[2] + r[3], w],
    [r[1] + r[2], h],
    [r[3] + r[0], h],
  ]) {
    if (sum > 0) scale = Math.min(scale, span / sum)
  }
  if (scale >= 1) return r
  return [r[0] * scale, r[1] * scale, r[2] * scale, r[3] * scale]
}

/** Segments for one 90-degree arc, at the same chord tolerance a circle's rim uses. */
function cornerSegmentsFor(radius: number): number {
  return Math.max(1, Math.ceil(circleSegments(radius) / 4))
}

/**
 * The outline, from the bottom-right corner round, with each non-zero radius replaced by an
 * arc. The straight edges between the arcs are implicit - a corner's first and last arc
 * points ARE the tangent points, so consecutive corners connect directly.
 */
function roundedContour(width: number, height: number, r: Radii, segments?: number): Vector2Like[] {
  const w = width
  const b = height
  const [tl, tr, br, bl] = r
  // Centre and start angle of each corner's arc, in outline order, beginning at the
  // bottom-right. Every arc sweeps a quarter turn; y is measured downward, so the sine term
  // is subtracted rather than added and each arc bulges away from the rectangle's middle.
  const corners: { cx: number; cy: number; r: number; from: number }[] = [
    { cx: w - br, cy: b - br, r: br, from: -Math.PI / 2 },
    { cx: w - tr, cy: tr, r: tr, from: 0 },
    { cx: tl, cy: tl, r: tl, from: Math.PI / 2 },
    { cx: bl, cy: b - bl, r: bl, from: Math.PI },
  ]
  const points: Vector2Like[] = []
  for (const c of corners) {
    if (c.r <= 0) {
      // A square corner is the single point the two edges meet at: the arc's centre is
      // that point once the radius is gone.
      points.push({ x: c.cx, y: c.cy })
      continue
    }
    const n = segments ?? cornerSegmentsFor(c.r)
    for (let i = 0; i <= n; i++) {
      const a = c.from + (i / n) * (Math.PI / 2)
      points.push({ x: c.cx + Math.cos(a) * c.r, y: c.cy - Math.sin(a) * c.r })
    }
  }
  return points
}

export class Rect extends Shape {
  override readonly nodeName: string = 'Rect'

  /**
   * Corner rounding, 0 (the default) for square corners. A geometry property: call
   * markGeometryDirty() after changing it, as with Circle.radius.
   */
  cornerRadius: CornerRadius
  cornerSegments?: number

  constructor(options: RectOptions = {}) {
    super({ ...options, width: options.width ?? 0, height: options.height ?? 0 })
    this.cornerRadius = options.cornerRadius ?? 0
    this.cornerSegments = options.cornerSegments
  }

  protected override attrKeys(): readonly string[] {
    return [...super.attrKeys(), 'cornerRadius', 'cornerSegments']
  }

  protected override buildGeometry(sink: MeshSink): void {
    const w = this.width
    // The scene is y-down and the origin is the top-left corner, so the rectangle hangs below
    // it: its bottom edge is at +height.
    const b = this.height
    const radii = fitRadii(this.cornerRadius, w, this.height)
    const rounded = radii.some((r) => r > 0)

    // Color is not part of the geometry in either branch - the fragment shader reads the
    // object's fillColor (solid) or gradient parameters.
    let outline: Vector2Like[]
    if (rounded) {
      // Fill: a fan from the first outline point. The outline is convex, so a fan from any
      // one of its vertices covers it exactly, with no interior vertex to add.
      outline = roundedContour(w, this.height, radii, this.cornerSegments)
      const idx = outline.map((p) => sink.vertex(p.x, p.y, true))
      for (let i = 1; i + 1 < idx.length; i++) {
        sink.triangle(idx[0], idx[i], idx[i + 1])
      }
    } else {
      // Fill: two triangles, from the bottom-left corner round.
      outline = [
        { x: 0, y: b },
        { x: w, y: b },
        { x: w, y: 0 },
        { x: 0, y: 0 },
      ]
      const f0 = sink.vertex(0, b, true)
      const f1 = sink.vertex(w, b, true)
      const f2 = sink.vertex(w, 0, true)
      const f3 = sink.vertex(0, 0, true)
      sink.triangle(f0, f1, f2)
      sink.triangle(f0, f2, f3)
    }

    if (this.hasStroke()) {
      strokePolyline(outline, sink, {
        width: this.strokeWidth,
        closed: true,
        align: this.strokeAlign,
        join: this.lineJoin,
        miterLimit: this.miterLimit,
        roundSegments: 4,
        gauge: this.strokeGauge(),
      })
    }
  }
}
