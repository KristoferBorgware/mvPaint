// Path - a filled and/or stroked shape from arbitrary contours (typically flattened SVG
// path data). Fill is triangulated with holes (earcut) and stroke is drawn by the shared
// contour stroker; both reuse the mesh lane and the inherited MeshShape fill/gradient
// API, so a Path fills with a solid color or a gradient exactly like Rect/Circle.

import { MeshShape, type MeshShapeOptions } from '../scene/MeshShape'
import type { MeshSink, RGBA } from '../render/meshFormat'
import { strokeContours, type Contour, type LineCap, type LineJoin } from '../render/stroke'
import { flattenPathData } from '../svg/flattenPath'
import { classifyContours, type ContourGroup } from '../svg/contours'
import { triangulateGroup } from '../svg/triangulate'

export interface PathOptions extends MeshShapeOptions {
  /** SVG path data. Provide this OR `contours`. */
  d?: string
  /** Pre-flattened contours (e.g. from the SVG loader). Provide this OR `d`. */
  contours?: Contour[]
  /** Curve flatness tolerance when `d` is given (path units). */
  tolerance?: number
  /** When false, the fill triangles are not emitted (e.g. SVG fill="none"). Default true. */
  filled?: boolean
  stroke?: RGBA
  /** Stroke width in world units; 0 = no stroke. */
  strokeWidth?: number
  lineJoin?: LineJoin
  lineCap?: LineCap
  miterLimit?: number
}

export class Path extends MeshShape {
  readonly contours: Contour[]
  private readonly groups: ContourGroup[]
  /** When false, fill triangles are skipped (e.g. SVG fill="none"). */
  filled: boolean
  stroke: RGBA
  strokeWidth: number
  lineJoin: LineJoin
  lineCap: LineCap
  miterLimit: number

  constructor(options: PathOptions = {}) {
    super(options)
    this.contours =
      options.contours ??
      (options.d ? flattenPathData(options.d, { tolerance: options.tolerance }) : [])
    // Fill regions are triangulated once at construction (geometry is static; the shape
    // is moved/animated via its transform, not by re-tessellating).
    this.groups = classifyContours(this.contours)
    this.filled = options.filled ?? true
    this.stroke = options.stroke ?? [0, 0, 0, 1]
    this.strokeWidth = options.strokeWidth ?? 0
    this.lineJoin = options.lineJoin ?? 'miter'
    this.lineCap = options.lineCap ?? 'butt'
    this.miterLimit = options.miterLimit ?? 10
  }

  override tessellate(sink: MeshSink): void {
    // Fill: one triangulated solid+holes group at a time.
    if (this.filled) {
      for (const group of this.groups) {
        const { vertices, indices } = triangulateGroup(group)
        const base = vertices.map((v) => sink.vertex(v.x, v.y, this.fill, true))
        for (let i = 0; i < indices.length; i += 3) {
          sink.triangle(base[indices[i]], base[indices[i + 1]], base[indices[i + 2]])
        }
      }
    }

    // Stroke: every contour (each subpath uses its own closed flag), via the shared stroker.
    if (this.strokeWidth > 0 && this.contours.length > 0) {
      strokeContours(this.contours, sink, {
        width: this.strokeWidth,
        color: this.stroke,
        join: this.lineJoin,
        cap: this.lineCap,
        miterLimit: this.miterLimit,
      })
    }
  }
}
