// Circle - a filled, optionally stroked circle (Konva-style). Centered at (x, y) in the
// Z=0 plane. Tessellated in the mesh lane: a triangle fan for the fill and a ring strip
// for the stroke. The segment count is chosen adaptively from the radius so it stays
// smooth without wasting triangles on tiny circles.
//
// Note: adaptivity here is by WORLD radius (tessellate() has no camera/zoom context).
// True screen-aware density (re-tessellate when the on-screen size changes) is a
// follow-up once the batcher can pass pixels-per-unit into tessellation.

import { Shape } from '../scene/Shape'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Vector3 } from '../math/Vector3'
import type { MeshSink, RGBA } from '../render/meshFormat'

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
  fill: RGBA
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

    // Fill: a triangle fan from the center to n perimeter points.
    const center = sink.vertex(0, 0, this.fill)
    const rim: number[] = []
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      rim.push(sink.vertex(Math.cos(a) * r, Math.sin(a) * r, this.fill))
    }
    for (let i = 0; i < n; i++) {
      sink.triangle(center, rim[i], rim[(i + 1) % n])
    }

    // Stroke: a ring between inner and outer radii, centered on the edge.
    if (this.strokeWidth > 0) {
      const s = this.strokeWidth / 2
      const outerR = r + s
      const innerR = Math.max(0, r - s)
      const outer: number[] = []
      const inner: number[] = []
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2
        const cos = Math.cos(a)
        const sin = Math.sin(a)
        outer.push(sink.vertex(cos * outerR, sin * outerR, this.stroke))
        inner.push(sink.vertex(cos * innerR, sin * innerR, this.stroke))
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        sink.triangle(outer[i], outer[j], inner[j])
        sink.triangle(outer[i], inner[j], inner[i])
      }
    }
  }
}
