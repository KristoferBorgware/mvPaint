// Circle - a filled, optionally stroked circle. Centered at (x, y) in the Z=0 plane.
// Tessellated in the mesh lane: a triangle fan for the fill (fill color or gradient,
// via the inherited Shape fill API); the stroke is the same n-point rim contour run
// through the shared general-purpose stroker (round join - the exact offset for a
// smooth curve, with no faceting overshoot even at low segment counts, unlike miter).
// The segment count is chosen adaptively from the radius so it stays smooth without
// wasting triangles on tiny circles.
//
// Note: adaptivity here is by WORLD radius (tessellate() has no camera/zoom context).
// True screen-aware density (re-tessellate when the on-screen size changes) is a
// follow-up once the batcher can pass pixels-per-unit into tessellation.

import { Shape } from '../scene/Shape'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Vector3 } from '../math/Vector3'
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

export interface CircleOptions {
  name?: string
  x?: number
  y?: number
  radius?: number
  fill?: RGBA
  stroke?: RGBA
  /** Stroke width in world units; 0 = no stroke. Centered on the edge. */
  strokeWidth?: number
  /** Override the adaptive segment count (mainly for testing). */
  segments?: number
}

export class Circle extends Shape {
  x: number
  y: number
  radius: number
  stroke: RGBA
  strokeWidth: number
  segments?: number

  constructor(options: CircleOptions = {}) {
    super(options.name)
    this.x = options.x ?? 0
    this.y = options.y ?? 0
    this.radius = options.radius ?? 1
    this.fill = options.fill ?? [0, 0, 0, 1]
    this.stroke = options.stroke ?? [0, 0, 0, 1]
    this.strokeWidth = options.strokeWidth ?? 0
    this.segments = options.segments
  }

  // Position only; a circle is rotation-symmetric and its size lives in the geometry.
  override localMatrix(): Matrix4x4 {
    return Matrix4x4.translation(new Vector3(this.x, this.y, 0))
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
