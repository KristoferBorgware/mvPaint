// Path - a filled and/or stroked shape from arbitrary contours (typically flattened SVG
// path data). Fill is triangulated with holes (earcut) and stroke is drawn by the shared
// contour stroker; both reuse the mesh lane and the inherited Shape fill/gradient/stroke
// API, so a Path fills with a solid color or a gradient exactly like Rect/Circle.

import { shapeAttrDefaults, Shape, type ShapeOptions } from './Shape'
import type { MeshSink } from '../render/meshFormat'
import { strokeContours, type Contour } from '../render/stroke'
import { flattenPathData } from '../svg/flattenPath'
import { classifyContours, type ContourGroup } from '../render/contours'
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


/** See Node.attrDefaults. An empty outline draws nothing. */
let cachedPathAttrDefaults: Readonly<Record<string, unknown>> | undefined

/**
 * Built on FIRST USE rather than at module load. It spreads a table from another module, and a
 * module-level spread is evaluated in whatever order the bundler happened to link the two - so
 * an import cycle, or a dev server reloading one module without the other, reads the imported
 * name before it exists. Deferring it to the first call puts the read long after every module
 * has finished evaluating.
 */
function pathAttrDefaults(): Readonly<Record<string, unknown>> {
  return (cachedPathAttrDefaults ??= Object.freeze({
    ...shapeAttrDefaults(),
    contours: Object.freeze([]),
    filled: true,
  }))
}

export class Path extends Shape {
  override readonly nodeName: string = 'Path'

  /**
   * The outline, one entry per subpath. Assigning a list regroups it and re-tessellates.
   *
   * The fill is triangulated from a GROUPING of these - each outer ring with the holes that
   * fall inside it - which is derived here rather than at tessellation time, because a
   * classification is the one part that does not vary with anything else the shape draws with.
   * Deriving it in the setter is what keeps the two from disagreeing: a fill triangulated from
   * one outline and a stroke drawn along another is not a shape anybody asked for.
   *
   * EDITING ONE IN PLACE DOES NOT REGROUP. `path.contours[0].points.push(p)` is invisible from
   * here - there is no assignment to intercept - so either follow it with markGeometryDirty(),
   * or assign a new list.
   */
  private _contours: Contour[] = []
  private _groups: ContourGroup[] = []
  get contours(): Contour[] {
    return this._contours
  }
  set contours(value: Contour[]) {
    if (value === this._contours) return
    const previous = this._contours
    this._contours = value
    this._groups = classifyContours(value)
    this.markGeometryDirty()
    this.announce('contours', previous, value)
  }

  /**
   * When false, fill triangles are skipped (e.g. SVG fill="none"). Assigning it re-tessellates.
   */
  private _filled = true
  get filled(): boolean {
    return this._filled
  }
  set filled(value: boolean) {
    if (value === this._filled) return
    const previous = this._filled
    this._filled = value
    this.markGeometryDirty()
    this.announce('filled', previous, value)
  }

  constructor(options: PathOptions = {}) {
    super(options)
    // Through the setter, so the grouping is derived in the one place that derives it. The
    // earcut triangulation itself happens in buildGeometry(), which Shape's tessellate() only
    // calls on a cache miss - so it runs once per shape, lazily rather than eagerly.
    this.contours =
      options.contours ??
      (options.d ? flattenPathData(options.d, { tolerance: options.tolerance }) : [])
    this.filled = options.filled ?? true
  }

  protected override attrKeys(): readonly string[] {
    return [...super.attrKeys(), 'contours', 'filled']
  }

  protected override attrDefaults(): Readonly<Record<string, unknown>> {
    return pathAttrDefaults()
  }

  protected override buildGeometry(sink: MeshSink): void {
    // Fill: one triangulated solid+holes group at a time.
    if (this.filled) {
      for (const group of this._groups) {
        const { vertices, indices } = triangulateGroup(group)
        const base = vertices.map((v) => sink.vertex(v.x, v.y, true))
        for (let i = 0; i < indices.length; i += 3) {
          sink.triangle(base[indices[i]], base[indices[i + 1]], base[indices[i + 2]])
        }
      }
    }

    // Stroke: every contour (each subpath uses its own closed flag), via the shared stroker.
    if (this.hasStroke() && this.contours.length > 0) {
      strokeContours(this.contours, sink, {
        width: this.strokeWidthForBuild(),
        dash: this.dashForBuild(),
        dashOffset: this.dashOffset,
        align: this.strokeAlign,
        join: this.lineJoin,
        cap: this.lineCap,
        miterLimit: this.miterLimit,
        gauge: this.strokeGauge(),
      })
    }
  }
}
