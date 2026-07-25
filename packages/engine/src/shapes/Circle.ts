// Circle - a filled, optionally stroked circle. Centered at (x, y) in the Z=0 plane
// (before any offset), transformed by the common Shape parameters (position, scale,
// rotation, offset) - a non-uniform scaleX/scaleY turns it into an ellipse. Tessellated
// in the mesh lane: a triangle fan for the fill (fill color or gradient, via the
// inherited Shape fill API); the stroke is the same n-point rim contour run through the
// shared general-purpose stroker (round join - the exact offset for a smooth curve,
// with no faceting overshoot even at low segment counts, unlike miter). The segment
// count is chosen adaptively from the radius so it stays smooth without wasting
// triangles on tiny circles.
//
// width/height are derived from radius (width = height = radius*2) rather than stored
// independently - overriding the inherited Shape accessors so `circle.width = 100` and
// `circle.radius` stay consistent with each other.
//
// Note: segment-count adaptivity here is by WORLD radius (tessellate() has no camera/
// zoom context). True screen-aware density (re-tessellate when the on-screen size
// changes) is a follow-up once the batcher can pass pixels-per-unit into tessellation.

import { Shape, type ShapeOptions } from '../scene/Shape'
import type { MeshSink, RGBA } from '../render/meshFormat'
import { strokePolyline, type Point2 } from '../render/stroke'

/**
 * Segments needed so the chord deviation (sagitta) stays within `tolerance` world units:
 * angle per segment = 2·acos(1 − tol/r); segments = 2π / angle. Clamped to [min, max].
 */
export function circleSegments(radius: number, tolerance = 0.02, min = 12, max = 256): number {
  if (radius <= tolerance) return min
  const arg = Math.min(1, Math.max(-1, 1 - tolerance / radius))
  const perSegment = 2 * Math.acos(arg)
  const n = Math.ceil((2 * Math.PI) / perSegment)
  return Math.min(max, Math.max(min, n))
}

export interface CircleOptions extends ShapeOptions {
  radius?: number
  stroke?: RGBA
  /** Stroke width in world units; 0 = no stroke. Centered on the edge. */
  strokeWidth?: number
  /** Override the adaptive segment count (mainly for testing). */
  segments?: number
}

export class Circle extends Shape {
  radius: number
  stroke: RGBA
  strokeWidth: number
  segments?: number

  constructor(options: CircleOptions = {}) {
    super(options)
    // radius is authoritative over width/height when more than one is given.
    if (options.radius !== undefined) {
      this.radius = options.radius
    } else if (options.width !== undefined) {
      this.radius = options.width / 2
    } else if (options.height !== undefined) {
      this.radius = options.height / 2
    } else {
      this.radius = 1
    }
    this.stroke = options.stroke ?? [0, 0, 0, 1]
    this.strokeWidth = options.strokeWidth ?? 0
    this.segments = options.segments
  }

  override get width(): number {
    return this.radius * 2
  }
  override set width(value: number) {
    this.radius = value / 2
  }
  override get height(): number {
    return this.radius * 2
  }
  override set height(value: number) {
    this.radius = value / 2
  }

  override tessellate(sink: MeshSink): void {
    const n = this.segments ?? circleSegments(this.radius)
    const r = this.radius

    // Fill: a triangle fan from the center to n perimeter points. The vertex color is a
    // placeholder when fillPriority selects a gradient - the fragment shader computes
    // the displayed color from the object's gradient parameters instead.
    const rim: Point2[] = []
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      rim.push({ x: Math.cos(a) * r, y: Math.sin(a) * r })
    }
    const center = sink.vertex(0, 0, this.fill, true)
    const rimIdx = rim.map((p) => sink.vertex(p.x, p.y, this.fill, true))
    for (let i = 0; i < n; i++) {
      sink.triangle(center, rimIdx[i], rimIdx[(i + 1) % n])
    }

    // Stroke: the rim contour through the shared stroker, round-joined.
    if (this.strokeWidth > 0) {
      strokePolyline(rim, sink, {
        width: this.strokeWidth,
        color: this.stroke,
        closed: true,
        join: 'round',
        roundSegments: 4,
      })
    }
  }
}
