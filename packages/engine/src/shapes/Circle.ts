// Circle - a filled, optionally stroked circle. CENTRED at (x, y) in the Z=0 plane (before
// any offset), transformed by the common Shape parameters (position, scale, rotation,
// offset) - a non-uniform scaleX/scaleY turns it into an ellipse. Being centred rather
// than cornered is the elliptical convention: a radius is measured from the middle, so the
// middle is the only origin that does not introduce a second reference point. Rect, Image
// and text hang from their top-left corner instead - see Shape's header. Tessellated
// in the mesh lane: a triangle fan for the fill (fill color or gradient, via the
// inherited Shape fill API); the stroke is the same n-point rim contour run through the
// shared general-purpose stroker, using the inherited stroke/lineJoin/miterLimit (lineCap
// is irrelevant - the rim is always closed). The segment count is chosen adaptively from
// the radius so it stays smooth without wasting triangles on tiny circles.
//
// width/height are derived from radius (width = height = radius*2) rather than stored
// independently - overriding the inherited Shape accessors so `circle.width = 100` and
// `circle.radius` stay consistent with each other.
//
// Note: segment-count adaptivity here is by WORLD radius (tessellate() has no camera/
// zoom context). True screen-aware density (re-tessellate when the on-screen size
// changes) is a follow-up once the batcher can pass pixels-per-unit into tessellation.

import type { Vector2Like } from '../math/Vector2'
import { shapeAttrDefaults, Shape, type ShapeOptions } from './Shape'
import type { MeshSink } from '../render/meshFormat'
import {strokePolyline} from '../render/stroke'

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
  /** Override the adaptive segment count (mainly for testing). */
  segments?: number
}


/** See Node.attrDefaults. width/height come back through radius, so all three agree at 0. */
let cachedCircleAttrDefaults: Readonly<Record<string, unknown>> | undefined

/**
 * Built on FIRST USE rather than at module load. It spreads a table from another module, and a
 * module-level spread is evaluated in whatever order the bundler happened to link the two - so
 * an import cycle, or a dev server reloading one module without the other, reads the imported
 * name before it exists. Deferring it to the first call puts the read long after every module
 * has finished evaluating.
 */
function circleAttrDefaults(): Readonly<Record<string, unknown>> {
  return (cachedCircleAttrDefaults ??= Object.freeze({
    ...shapeAttrDefaults(),
    radius: 0,
    segments: undefined,
  }))
}

export class Circle extends Shape {
  override readonly nodeName: string = 'Circle'

  /** Distance from the centre to the rim. Assigning it re-tessellates. */
  private _radius = 0
  get radius(): number {
    return this._radius
  }
  set radius(value: number) {
    if (value === this._radius) return
    const previous = this._radius
    this._radius = value
    this.markGeometryDirty()
    this.announce('radius', previous, value)
  }

  /** Rim segments, or undefined to pick a count from the radius. Assigning it re-tessellates. */
  private _segments?: number
  get segments(): number | undefined {
    return this._segments
  }
  set segments(value: number | undefined) {
    if (value === this._segments) return
    const previous = this._segments
    this._segments = value
    this.markGeometryDirty()
    this.announce('segments', previous, value)
  }

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
      this.radius = 0
    }
    // A rim approximated by straight segments needs round joins to look like a smooth
    // circle (Shape's 'miter' default would facet visibly at each segment), so override
    // it unless the caller explicitly asked for something else.
    this.lineJoin = options.lineJoin ?? 'round'
    this.segments = options.segments
  }

  protected override attrKeys(): readonly string[] {
    return [...super.attrKeys(), 'radius', 'segments']
  }

  protected override attrDefaults(): Readonly<Record<string, unknown>> {
    return circleAttrDefaults()
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

  protected override buildGeometry(sink: MeshSink): void {
    const n = this.segments ?? circleSegments(this.radius)
    const r = this.radius

    // Fill: a triangle fan from the center to n perimeter points. Color is not part of
    // the geometry - the fragment shader reads the object's fillColor (solid) or
    // gradient parameters.
    const rim: Vector2Like[] = []
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      rim.push({ x: Math.cos(a) * r, y: Math.sin(a) * r })
    }
    const center = sink.vertex(0, 0, true)
    const rimIdx = rim.map((p) => sink.vertex(p.x, p.y, true))
    for (let i = 0; i < n; i++) {
      sink.triangle(center, rimIdx[i], rimIdx[(i + 1) % n])
    }

    if (this.hasStroke()) {
      strokePolyline(rim, sink, {
        width: this.strokeWidthForBuild(),
        dash: this.dashForBuild(),
        dashOffset: this.dashOffset,
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
