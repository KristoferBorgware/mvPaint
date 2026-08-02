// Path - a filled and/or stroked shape from arbitrary contours (typically flattened SVG
// path data). Fill is triangulated with holes (earcut) and stroke is drawn by the shared
// contour stroker; both reuse the mesh lane and the inherited Shape fill/gradient/stroke
// API, so a Path fills with a solid color or a gradient exactly like Rect/Circle.

import { Shape, type ShapeOptions } from './Shape'
import type { MeshSink } from '../render/meshFormat'
import { strokeContours, type Contour } from '../render/stroke'
import { flattenPathData } from '../svg/flattenPath'
import { classifyContours, type ContourGroup } from '../svg/contours'
import { triangulateGroup } from '../svg/triangulate'

export interface PathOptions extends ShapeOptions {
  /** SVG path data. Provide this OR `contours`. */
  d?: string
  /** Pre-flattened contours (e.g. from the SVG loader). Provide this OR `d`. */
  contours?: Contour[]
  /** Curve flatness tolerance when `d` is given (path units). */
  tolerance?: number
  /** When false, the fill triangles are not emitted (e.g. SVG fill="none"). Default true. */
  filled?: boolean
}

export class Path extends Shape {
  override readonly nodeName: string = 'Path'

  readonly contours: Contour[]
  private readonly groups: ContourGroup[]
  /** When false, fill triangles are skipped (e.g. SVG fill="none"). */
  filled: boolean

  constructor(options: PathOptions = {}) {
    super(options)
    this.contours =
      options.contours ??
      (options.d ? flattenPathData(options.d, { tolerance: options.tolerance }) : [])
    // Grouping outer contours with their holes happens once here; the actual earcut
    // triangulation happens in buildGeometry(), which Shape's tessellate() only calls on
    // a cache miss - so it still runs once per shape, just lazily rather than eagerly.
    this.groups = classifyContours(this.contours)
    this.filled = options.filled ?? true
  }

  protected override attrKeys(): readonly string[] {
    return [...super.attrKeys(), 'contours', 'filled']
  }

  protected override buildGeometry(sink: MeshSink): void {
    // Fill: one triangulated solid+holes group at a time.
    if (this.filled) {
      for (const group of this.groups) {
        const { vertices, indices } = triangulateGroup(group)
        const base = vertices.map((v) => sink.vertex(v.x, v.y, true))
        for (let i = 0; i < indices.length; i += 3) {
          sink.triangle(base[indices[i]], base[indices[i + 1]], base[indices[i + 2]])
        }
      }
    }

    // Stroke: every contour (each subpath uses its own closed flag), via the shared stroker.
    if (this.strokeWidth > 0 && this.contours.length > 0) {
      strokeContours(this.contours, sink, {
        width: this.strokeWidth,
        join: this.lineJoin,
        cap: this.lineCap,
        miterLimit: this.miterLimit,
        gauge: this.strokeGauge(),
      })
    }
  }
}
