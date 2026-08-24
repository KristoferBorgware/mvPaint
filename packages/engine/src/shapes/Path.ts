// Path - a filled and/or stroked shape from arbitrary contours, usually SVG path data. Fill is
// triangulated with holes (earcut) and stroke is drawn by the shared contour stroker; both reuse
// the mesh lane and the inherited Shape fill/gradient/stroke API, so a Path fills with a solid
// color or a gradient exactly like Rect/Circle.
//
// TWO WAYS TO SAY THE SAME SHAPE. `d` is path data, re-flattened whenever it is assigned;
// `contours` is the flat point lists a flattener already produced, which is what the SVG loader
// hands over rather than re-parsing a string it has just read. Whichever one was written last is
// the one the shape describes itself by - see attrKeys() - so a Path built from data saves and
// reloads as that data, not as ten thousand points.

import { shapeAttrDefaults, Shape, type ShapeOptions } from './Shape'
import type { Vector2Like } from '../math/Vector2'
import type { MeshSink } from '../render/meshFormat'
import { contoursLength, pointAtLength } from '../render/arcLength'
import { strokeContours, type Contour } from '../render/stroke'
import { flattenPathData } from '../svg/flattenPath'
import type { ContourGroup, FillRule } from '../render/contours'
import { evenOddGroups, nonzeroGroups } from '../render/nonzero'
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
  /** Which rule decides what the outline fills. Default 'nonzero', as in SVG. See FillRule. */
  fillRule?: FillRule
}


/** See Node.attrDefaults. An empty outline draws nothing. */
let cachedPathAttrDefaults: Readonly<Record<string, unknown>> | undefined
let cachedDataPathAttrDefaults: Readonly<Record<string, unknown>> | undefined

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
    fillRule: 'nonzero',
  }))
}

/** The same table for a Path that carries its data string - see attrKeys(). */
function dataPathAttrDefaults(): Readonly<Record<string, unknown>> {
  return (cachedDataPathAttrDefaults ??= Object.freeze({
    ...shapeAttrDefaults(),
    d: undefined,
    tolerance: undefined,
    filled: true,
    fillRule: 'nonzero',
  }))
}

export class Path extends Shape {
  override readonly nodeName: string = 'Path'

  /**
   * The outline, one entry per subpath. Assigning a list regroups it and re-tessellates, and
   * drops any `d` this path was carrying - the string no longer describes these points.
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
    this._d = undefined
    this.applyContours(value)
  }

  private applyContours(value: Contour[]): void {
    if (value === this._contours) return
    const previous = this._contours
    this._contours = value
    this.regroup()
    this.extentCache = undefined
    this.markGeometryDirty()
    this.announce('contours', previous, value)
  }

  /** The outline read as regions, by whichever rule this path fills with. */
  private regroup(): void {
    this._groups =
      this._fillRule === 'evenodd' ? evenOddGroups(this._contours) : nonzeroGroups(this._contours)
  }

  /**
   * Which rule decides what the outline fills - 'nonzero' (the default, and SVG's) or 'evenodd'.
   * See FillRule for what the two do differently. Assigning it regroups and re-tessellates.
   */
  private _fillRule: FillRule = 'nonzero'
  get fillRule(): FillRule {
    return this._fillRule
  }
  set fillRule(value: FillRule) {
    if (value === this._fillRule) return
    const previous = this._fillRule
    this._fillRule = value
    this.regroup()
    this.markGeometryDirty()
    this.announce('fillRule', previous, value)
  }

  /**
   * The path data this outline came from, or undefined for one given its contours directly.
   * Assigning a string re-flattens it at the current tolerance, so an application animating a
   * shape can write data and nothing else.
   */
  private _d?: string
  get d(): string | undefined {
    return this._d
  }
  set d(value: string | undefined) {
    if (value === this._d) return
    const previous = this._d
    this._d = value
    // applyContours rather than the contours setter, which is the one that drops `d`.
    this.applyContours(value ? flattenPathData(value, { tolerance: this._tolerance }) : [])
    this.announce('d', previous, value)
  }

  /** Curve flatness when `d` is flattened, in path units. Assigning it re-flattens. */
  private _tolerance?: number
  get tolerance(): number | undefined {
    return this._tolerance
  }
  set tolerance(value: number | undefined) {
    if (value === this._tolerance) return
    const previous = this._tolerance
    this._tolerance = value
    if (this._d) this.applyContours(flattenPathData(this._d, { tolerance: value }))
    this.announce('tolerance', previous, value)
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
    // Through the setters, so the grouping is derived in the one place that derives it. The
    // earcut triangulation itself happens in buildGeometry(), which Shape's tessellate() only
    // calls on a cache miss - so it runs once per shape, lazily rather than eagerly.
    this._tolerance = options.tolerance
    // The field rather than the accessor, so the outline below is grouped once, by the rule this
    // path is being built with rather than by the default and then again.
    this._fillRule = options.fillRule ?? 'nonzero'
    if (options.contours) this.contours = options.contours
    else this.d = options.d
    this.filled = options.filled ?? true
    this.settleSize(options)
  }

  /**
   * Whichever of the two descriptions this path holds, and never both: `contours` alongside the
   * `d` they were flattened from would write the same outline twice into every document, and
   * reading them back would then depend on which of the two was applied last.
   */
  protected override attrKeys(): readonly string[] {
    return this._d !== undefined
      ? [...super.attrKeys(), 'd', 'tolerance', 'filled', 'fillRule']
      : [...super.attrKeys(), 'contours', 'filled', 'fillRule']
  }

  protected override attrDefaults(): Readonly<Record<string, unknown>> {
    return this._d !== undefined ? dataPathAttrDefaults() : pathAttrDefaults()
  }

  // --- size -------------------------------------------------------------------------------
  //
  // A path is not SIZED, it is MEASURED: width and height report the extent of its contour
  // points rather than a stored pair. Assigning either one records a size for callers that ask
  // and moves no point - the contours are the geometry, whatever the size says.

  private extentCache?: { width: number; height: number }
  private widthPinned = false
  private heightPinned = false

  private extent(): { width: number; height: number } {
    if (!this.extentCache) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const contour of this._contours) {
        for (const p of contour.points) {
          if (p.x < minX) minX = p.x
          if (p.x > maxX) maxX = p.x
          if (p.y < minY) minY = p.y
          if (p.y > maxY) maxY = p.y
        }
      }
      this.extentCache = Number.isFinite(minX)
        ? { width: maxX - minX, height: maxY - minY }
        : { width: 0, height: 0 }
    }
    return this.extentCache
  }

  /**
   * Node's constructor writes width and height through the setters, so every Path would arrive
   * with both pinned. Only a size NAMED in the options is an override - and a size that merely
   * restates the measurement is what a serialised copy carries, so that one is not an override
   * either, and a reloaded path goes on tracking its outline as the original did.
   */
  private settleSize(options: PathOptions): void {
    const measured = this.extent()
    this.widthPinned = options.width !== undefined && options.width !== measured.width
    this.heightPinned = options.height !== undefined && options.height !== measured.height
  }

  override get width(): number {
    return this.widthPinned ? super.width : this.extent().width
  }
  override set width(value: number) {
    this.widthPinned = true
    super.width = value
  }
  override get height(): number {
    return this.heightPinned ? super.height : this.extent().height
  }
  override set height(value: number) {
    this.heightPinned = true
    super.height = value
  }

  // --- distance along the outline ---------------------------------------------------------

  /** How long the whole outline is - every subpath, each closing segment included. */
  getLength(): number {
    return contoursLength(this._contours)
  }

  /**
   * The point that far along the outline, in local space, or null for an empty one. The subpaths
   * are walked in order as one continuous ruler, and a distance past the end clamps to it - see
   * render/arcLength.
   */
  getPointAtLength(distance: number): Vector2Like | null {
    return pointAtLength(this._contours, distance)
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
