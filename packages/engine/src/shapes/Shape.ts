// Shape - the base for every drawable scene-graph node (Rect, Circle, Polyline, Path,
// Text). Carries the full common vocabulary every drawable shares: transform (position,
// scale, rotation, pivot offset), visibility/pickability, stacking order (zIndex), a
// settable size (width/height), and the complete fill/stroke styling API (flat color or
// gradient fill; stroke color/width/join/cap/miter limit) - mirroring how a well-known
// 2D canvas library's Shape class puts all of this in one place rather than splitting it
// by "how the shape happens to be drawn". Concrete shapes only add what's genuinely
// specific to them (Rect: nothing beyond a default size; Circle: radius; Polyline:
// points; Path: contours; Text: runs and block layout).
//
// tessellate() caches its output (a list of local-space vertices + triangles) and
// replays it into whatever sink is asking - the mesh batcher's rebuild - rather than
// re-running geometry generation every call. That matters most for the expensive cases:
// a Path's earcut fill triangulation and contour stroking, or a Polyline's stroke with
// many points, previously reran on EVERY rebuild - including one triggered by an
// unrelated shape elsewhere in the scene - because the mesh batcher rebuilds its whole
// shared buffer from every shape whenever anything changes. The cache only goes stale
// when markGeometryDirty() is called; subclasses implement buildGeometry() instead of
// tessellate() directly, since that's the method that only runs on a cache miss.
// buildGeometry() defaults to emitting nothing - that's what makes it safe for Text
// (which renders through the separate MSDF text lane, not the mesh lane) to inherit it
// unchanged.
//
// hitTestLocal()/localBounds() (used by scene/picking.ts) build a SEPARATE flat
// xs/ys/tris/bounds structure derived from the same buildGeometry() output, cached and
// invalidated alongside geometryCache - not a second tessellation, just a picking-
// friendly layout of the one cached result, so repeated picks against an unchanged
// shape (e.g. every mousemove while hovering) don't redo any array-building work either.
//
// Nothing here needs markGeometryDirty() after a transform change (x/y/rotation/scale/
// offset/zIndex): those are applied per-frame via the object's world matrix, never baked
// into the cached local-space geometry. Fill/stroke color changes also don't need it -
// solid colors, like gradient parameters, are read from the per-object GPU buffer every
// frame, never baked into geometry. It IS needed after changing anything that actually
// affects buildGeometry()'s output - Circle.radius, Polyline.points, stroke/strokeWidth/
// lineJoin/lineCap/miterLimit on any stroked shape, or Path.filled.
//
// localMatrix() composes translate(x, y) * rotate(rotation) * scale(scaleX, scaleY) *
// translate(-offsetX, -offsetY): offset shifts the shape's own pivot (applied first, to
// the shape's local geometry) before scale and rotation are applied about that pivot,
// then the result is placed at (x, y). Skew (shear) is not currently supported.

import { AABB } from '../math/AABB'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Vector3 } from '../math/Vector3'
import type { FillPriority, GradientStop, MeshSink, Point2, RGBA } from '../render/meshFormat'
import type { LineCap, LineJoin } from '../render/stroke'
import { Node } from './Node'

/** A complete snapshot of everything localMatrix() depends on. See Shape.captureTransform. */
export interface ShapeTransform {
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
  skewX: number
  skewY: number
  offsetX: number
  offsetY: number
}

export interface ShapeOptions {
  name?: string
  x?: number
  y?: number
  width?: number
  height?: number
  scaleX?: number
  scaleY?: number
  /** Radians, about +Z. */
  rotation?: number
  offsetX?: number
  offsetY?: number
  /** Shear: x shifts by skewX per unit y. See Shape.skewX. */
  skewX?: number
  /** Shear: y shifts by skewY per unit x. See Shape.skewY. */
  skewY?: number
  /**
   * Stacking-order hint: shapes with a higher zIndex render in front, resolved by the
   * renderer's depth buffer (so mesh shapes and text can freely interleave). Integer-
   * valued by convention; ties fall back to scene-graph order. Default 0.
   */
  zIndex?: number
  /**
   * Draw in the always-on-top overlay pass (see webgpu/SceneRenderer). Default false.
   */
  overlay?: boolean
  /** Can a pointer drag reposition this node? See Shape.draggable. Default true. */
  draggable?: boolean
  fill?: RGBA
  stroke?: RGBA
  /** Stroke width in world units; 0 = no stroke. */
  strokeWidth?: number
  lineJoin?: LineJoin
  /** Only applies to open contours (e.g. Polyline with `closed: false`). */
  lineCap?: LineCap
  miterLimit?: number
}

export abstract class Shape extends Node {
  /** Skipped by the renderer when false. */
  visible = true
  /** Excluded from pickNode() hit-testing when false (e.g. a selection-highlight overlay). */
  pickable = true
  /**
   * Whether a pointer drag over this node repositions it (see input/SceneInputController).
   * A drag only ever reaches a node that pickNode() returns, so `pickable = false` already
   * rules one out; this turns dragging off for a node that should still be selectable.
   */
  draggable = true

  x = 0
  y = 0
  scaleX = 1
  scaleY = 1
  /** Radians, about +Z. */
  rotation = 0
  offsetX = 0
  offsetY = 0
  /**
   * Shear, matching Canvas/Konva semantics: skewX slides x by `skewX` per unit of y, and
   * skewY slides y by `skewY` per unit of x - so the matrix contributed is
   * [[1, skewX], [skewY, 1]]. Applied between rotation and scale (see localMatrix), which
   * is what lets an arbitrary affine transform be represented exactly: rotate+skew+scale
   * spans every invertible 2x2, so a transformer can non-uniformly scale a ROTATED shape
   * without the result having to be approximated.
   */
  skewX = 0
  skewY = 0
  zIndex = 0
  /**
   * When true the shape is drawn in the overlay pass, after everything else and without
   * writing depth - for editor furniture (selection frames, handles, rubber bands) that
   * must sit on top of the scene without occluding it. A translucent overlay that DID
   * write depth would punch a hole through whatever draws later, notably the text lane.
   */
  overlay = false

  protected _width = 0
  protected _height = 0

  get width(): number {
    return this._width
  }
  set width(value: number) {
    this._width = value
  }
  get height(): number {
    return this._height
  }
  set height(value: number) {
    this._height = value
  }

  /** Flat fill color, used when fillPriority is 'color'. */
  fill: RGBA = [0, 0, 0, 1]

  /** Which fill mechanism this shape's fill triangles use. */
  fillPriority: FillPriority = 'color'

  fillLinearGradientStartPoint: Point2 = { x: 0, y: 0 }
  fillLinearGradientEndPoint: Point2 = { x: 0, y: 0 }
  fillLinearGradientColorStops: GradientStop[] = []

  fillRadialGradientStartPoint: Point2 = { x: 0, y: 0 }
  fillRadialGradientStartRadius = 0
  fillRadialGradientEndPoint: Point2 = { x: 0, y: 0 }
  fillRadialGradientEndRadius = 0
  fillRadialGradientColorStops: GradientStop[] = []

  stroke: RGBA = [0, 0, 0, 1]
  strokeWidth = 0
  lineJoin: LineJoin = 'miter'
  lineCap: LineCap = 'butt'
  miterLimit = 10

  private geometryCache: CachedGeometry | null = null
  // Derived from geometryCache (same lifetime, invalidated together) - a flat, picking-
  // friendly layout (no MeshSink round-trip) built lazily on first hitTestLocal()/
  // localBounds() call, not on every tessellate().
  private pickCache: PickGeometry | null = null

  constructor(options: ShapeOptions = {}) {
    super(options.name)
    this.x = options.x ?? 0
    this.y = options.y ?? 0
    this.width = options.width ?? 0
    this.height = options.height ?? 0
    this.scaleX = options.scaleX ?? 1
    this.scaleY = options.scaleY ?? 1
    this.rotation = options.rotation ?? 0
    this.offsetX = options.offsetX ?? 0
    this.offsetY = options.offsetY ?? 0
    this.skewX = options.skewX ?? 0
    this.skewY = options.skewY ?? 0
    this.zIndex = options.zIndex ?? 0
    this.overlay = options.overlay ?? false
    this.draggable = options.draggable ?? true
    this.fill = options.fill ?? [0, 0, 0, 1]
    this.stroke = options.stroke ?? [0, 0, 0, 1]
    this.strokeWidth = options.strokeWidth ?? 0
    this.lineJoin = options.lineJoin ?? 'miter'
    this.lineCap = options.lineCap ?? 'butt'
    this.miterLimit = options.miterLimit ?? 10
  }

  override localMatrix(): Matrix4x4 {
    let m = Matrix4x4.translation(new Vector3(this.x, this.y, 0))
    if (this.rotation !== 0) {
      m = m.mul(Matrix4x4.rotationQuaternion(Quaternion.fromAxisAngle(Vector3.unitZ(), this.rotation)))
    }
    if (this.skewX !== 0 || this.skewY !== 0) {
      m = m.mul(skewMatrix(this.skewX, this.skewY))
    }
    if (this.scaleX !== 1 || this.scaleY !== 1) {
      m = m.mul(Matrix4x4.scaling(new Vector3(this.scaleX, this.scaleY, 1)))
    }
    if (this.offsetX !== 0 || this.offsetY !== 0) {
      m = m.mul(Matrix4x4.translation(new Vector3(-this.offsetX, -this.offsetY, 0)))
    }
    return m
  }

  /**
   * Every field localMatrix() reads, captured together so a gesture can restore the node
   * exactly as it was. Enumerating them by hand at each call site is what makes adding a
   * new transform field (skew, most recently) silently break gestures: a partial restore
   * leaves the previous move's value behind, and the next delta compounds onto it instead
   * of replacing it. Keeping the list in one place is the point.
   */
  captureTransform(): ShapeTransform {
    return {
      x: this.x,
      y: this.y,
      rotation: this.rotation,
      scaleX: this.scaleX,
      scaleY: this.scaleY,
      skewX: this.skewX,
      skewY: this.skewY,
      offsetX: this.offsetX,
      offsetY: this.offsetY,
    }
  }

  /** Puts the node back exactly as captureTransform() found it. */
  restoreTransform(t: ShapeTransform): void {
    this.x = t.x
    this.y = t.y
    this.rotation = t.rotation
    this.scaleX = t.scaleX
    this.scaleY = t.scaleY
    this.skewX = t.skewX
    this.skewY = t.skewY
    this.offsetX = t.offsetX
    this.offsetY = t.offsetY
  }

  /**
   * Invalidates the cached tessellation, so the next tessellate() call regenerates it via
   * buildGeometry() instead of replaying the cache. Call after changing anything that
   * affects buildGeometry()'s output (see the file header for exactly what that covers).
   * Never needed for a pure transform change (x/y/rotation/scale/skew/offset/zIndex).
   */
  markGeometryDirty(): void {
    this.geometryCache = null
    this.pickCache = null
  }

  /**
   * Emit this shape's geometry (in local space) into the sink: vertices and triangles
   * referencing them (no color - that's read from the object's fillColor/strokeColor/
   * gradient at fragment time). The renderer applies the per-object world matrix in the
   * vertex shader, so positions here are pre-transform. Regenerates via buildGeometry()
   * only on a cache miss (first call, or after markGeometryDirty()) - otherwise replays
   * the cached vertices/triangles, which is just array pushes, not geometry math.
   * Subclasses override buildGeometry(), not this.
   */
  tessellate(sink: MeshSink): void {
    const geometry = this.ensureGeometryCache()
    const remapped = geometry.vertices.map((v) => sink.vertex(v.x, v.y, v.isFill))
    for (const [a, b, c] of geometry.triangles) {
      sink.triangle(remapped[a], remapped[b], remapped[c])
    }
  }

  /**
   * True if a LOCAL-space point (pre-transform, same space buildGeometry() emits into)
   * falls inside any of this shape's fill/stroke triangles. Picking (scene/picking.ts)
   * builds on this rather than replaying tessellate() into its own recording sink - the
   * flat xs/ys/tris arrays + bounding box built here are exactly what a MeshSink replay
   * would produce, just cached instead of rebuilt on every hit-test call.
   */
  hitTestLocal(x: number, y: number): boolean {
    const pick = this.ensurePickCache()
    if (!pick.bounds.contains(new Vector3(x, y, 0))) return false
    for (let i = 0; i < pick.tris.length; i += 3) {
      const a = pick.tris[i]
      const b = pick.tris[i + 1]
      const c = pick.tris[i + 2]
      if (pointInTriangle(x, y, pick.xs[a], pick.ys[a], pick.xs[b], pick.ys[b], pick.xs[c], pick.ys[c])) {
        return true
      }
    }
    return false
  }

  /** This shape's fill+stroke triangles as an axis-aligned box, in its own local space. */
  localBounds(): AABB {
    return this.ensurePickCache().bounds
  }

  private ensureGeometryCache(): CachedGeometry {
    if (!this.geometryCache) {
      const vertices: CachedVertex[] = []
      const triangles: CachedTriangle[] = []
      this.buildGeometry({
        vertex: (x, y, isFill) => vertices.push({ x, y, isFill }) - 1,
        triangle: (a, b, c) => {
          triangles.push([a, b, c])
        },
      })
      this.geometryCache = { vertices, triangles }
    }
    return this.geometryCache
  }

  private ensurePickCache(): PickGeometry {
    if (!this.pickCache) {
      const geometry = this.ensureGeometryCache()
      const xs = geometry.vertices.map((v) => v.x)
      const ys = geometry.vertices.map((v) => v.y)
      const tris: number[] = []
      const bounds = new AABB()
      for (const v of geometry.vertices) bounds.encapsulate(new Vector3(v.x, v.y, 0))
      for (const [a, b, c] of geometry.triangles) tris.push(a, b, c)
      this.pickCache = { xs, ys, tris, bounds }
    }
    return this.pickCache
  }

  /**
   * Override to emit this shape's geometry (local space) - called only on a cache miss
   * (see tessellate()). The default emits nothing: Text (rendered through the separate
   * text lane) relies on exactly that; every mesh-drawn shape overrides this instead.
   */
  protected buildGeometry(_sink: MeshSink): void {}
}

/**
 * The shear [[1, skewX], [skewY, 1]]: x slides by skewX per unit y, y by skewY per unit
 * x. Column-major storage, so column 0 is (1, skewY) and column 1 is (skewX, 1).
 */
function skewMatrix(skewX: number, skewY: number): Matrix4x4 {
  const m = Matrix4x4.identity()
  m.m[1] = skewY
  m.m[4] = skewX
  return m
}

interface CachedVertex {
  x: number
  y: number
  isFill: boolean
}
type CachedTriangle = readonly [number, number, number]
interface CachedGeometry {
  vertices: CachedVertex[]
  triangles: CachedTriangle[]
}

interface PickGeometry {
  xs: number[]
  ys: number[]
  tris: number[]
  bounds: AABB
}

function edgeSign(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by)
}

// Tessellated geometry can legitimately include zero-area triangles (e.g. duplicate
// points from a stroke join) - harmless for the GPU rasterizer, which simply covers no
// pixels, but fatal for the sign-based test below: a degenerate triangle's three edge
// signs are all exactly 0, so "no negative and no positive" would call every point a
// hit. Reject anything without a real interior first.
const DEGENERATE_AREA_EPSILON = 1e-9

function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  const area2 = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
  if (Math.abs(area2) < DEGENERATE_AREA_EPSILON) return false

  const d1 = edgeSign(px, py, ax, ay, bx, by)
  const d2 = edgeSign(px, py, bx, by, cx, cy)
  const d3 = edgeSign(px, py, cx, cy, ax, ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}
