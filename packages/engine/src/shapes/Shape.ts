// Shape - the base for every drawable scene-graph node (Rect, Circle, Polyline, Path,
// Text, VectorText). Carries everything that affects RENDERING and is common to every
// drawable: a settable size (width/height), visibility/pickability, stacking order
// (zIndex), the complete fill/stroke styling API (flat color or gradient fill; stroke
// color/width/join/cap/miter limit) and the shadow settings - all in one place rather than
// split by how a shape happens to be drawn. Concrete shapes only add what's genuinely
// specific to them (Rect: corner rounding; Circle: radius; Polyline: points; Path:
// contours; Text/VectorText: runs and block layout).
//
// The TRANSFORM is not here: it lives on Node (see that file's header), because placing
// yourself in your parent is not a drawing concern and a Group does it while drawing
// nothing. x/y/rotation/scale/skew/offset are inherited and behave identically on both.
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
// unchanged. VectorText, the other text implementation, overrides it like any mesh shape:
// it tessellates real glyph outlines, and is therefore picked, bounded and shadowed by
// everything below without a single special case.
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
// affects buildGeometry()'s output - Circle.radius, Rect.cornerRadius, Polyline.points,
// stroke/strokeWidth/lineJoin/lineCap/miterLimit on any stroked shape, or Path.filled.
//
// WHERE THE ORIGIN SITS. A shape's local origin is the point that lands at (x, y), and
// which point of the shape that is depends on the shape:
//
//   - Elliptical shapes - Circle, and anything else defined by a radius - are CENTRED on
//     it. A radius is measured from the middle, so any other origin would be a second,
//     contradictory reference point.
//   - Everything else - Rect, Image, Text, VectorText - hangs from its TOP-LEFT corner,
//     extending right and downward. The scene is y-up, so such a shape spans x in
//     [0, width] and y in [-height, 0] in its own local space.
//   - Polyline and Path have no implied origin at all: their points and contours are
//     already local coordinates, placed wherever they were authored.
//
// The practical consequence is the pivot. Rotation and scale are about the local origin,
// so a Circle turns about its middle while a Rect turns about its corner. To spin a Rect
// about its own centre, give it `offsetX: width / 2, offsetY: -height / 2`.
//
// The shadow* properties mirror the canvas 2D shadow model: shadowColor, shadowBlur,
// shadowOffsetX/Y, shadowOpacity, shadowEnabled, shadowForStrokeEnabled - plus
// shadowSpread, which canvas has no equivalent for and which is borrowed from CSS
// box-shadow instead. shadowBlur is a
// canvas blur radius - a Gaussian of sigma = blur/2 - authored in the shape's own local
// units, so it scales with the shape the way the rest of its geometry does. shadowOffsetX/Y are
// downward-positive and scale with the shape's absolute scale but are NOT turned by its
// rotation, matching how a canvas shadow's offset is applied outside the current
// transform (see render/shadowMath.ts).
//
// Mesh shapes render the shadow by baking a spread-and-blurred silhouette into a shared
// atlas keyed on local-space geometry + blur + spread, then drawing one textured quad per shadow (see
// webgpu/ShadowAtlas.ts and webgpu/lanes/ShadowBatcher.ts) - so a shadow costs no per-frame GPU
// work once its texture is cached, and moving/scaling/spinning a shape never re-bakes it.
// Text ignores these fields: it carries its own per-run shadow styling instead (an offset
// duplicate of the glyphs, see text/layout.ts), since it has no mesh geometry to
// rasterize a silhouette from. VectorText, which does, honours them like any other mesh
// shape - a blurred shadow cast from the letterforms themselves.

import { AABB } from '../math/AABB'
import { bumpMeshGeometryEpoch } from './contentEpoch'
import { Vector3 } from '../math/Vector3'
import type { FillPriority, GradientStop, MeshMaterial, MeshSink, Point2, RGBA } from '../render/meshFormat'
import type { LineCap, LineJoin } from '../render/stroke'
import { Node, type NodeOptions } from './Node'
import { nextZIndex } from './zOrder'

export interface ShapeOptions extends NodeOptions {
  width?: number
  height?: number
  /**
   * Where the shape sits in the scene-wide stack: higher renders in front, resolved by the
   * renderer's depth buffer (so mesh shapes and text can freely interleave). Ties fall back
   * to scene-graph order.
   *
   * OMIT IT unless you mean to override the stacking. Left out, the shape takes the next
   * number from the running counter (see zOrder.ts) and therefore lands in front of every
   * shape made before it - which is what stacking means and what a caller who has not thought
   * about it wants.
   *
   * An explicit value is absolute, on the same scale as those counter-assigned numbers, and
   * does not advance the counter. So a small literal is not "near the bottom of this group of
   * shapes", it is near the bottom of the WHOLE SCENE - `zIndex: 1` in a scene that has
   * already made a thousand shapes puts this one behind almost all of them. To place a shape
   * relative to another, say so: `front.zIndex = back.zIndex + 1`.
   */
  zIndex?: number
  /**
   * Draw in the always-on-top overlay pass (see webgpu/SceneRenderer). Default false.
   */
  overlay?: boolean
  /** Can a pointer drag reposition this node? See Shape.draggable. Default true. */
  draggable?: boolean
  /** Shadow tint. Default opaque black. */
  shadowColor?: RGBA
  /** Canvas-style blur radius in local units (Gaussian sigma = blur/2). Default 0. */
  shadowBlur?: number
  /** CSS box-shadow-style spread in local units: grows (or, if negative, shrinks) the silhouette. Default 0. */
  shadowSpread?: number
  /** Shadow offset, downward-positive, in local units. Default 0. */
  shadowOffsetX?: number
  shadowOffsetY?: number
  /** Multiplies shadowColor's own alpha. Default 1. */
  shadowOpacity?: number
  /** Master switch; false suppresses the shadow entirely. Default true. */
  shadowEnabled?: boolean
  /** Cast the shadow from fill+stroke (true, default) or from the fill alone. */
  shadowForStrokeEnabled?: boolean
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
  override readonly nodeType: string = 'Shape'

  /** Skipped by the renderer when false. */
  visible = true
  /** Excluded from pickNode() hit-testing when false (e.g. a selection-highlight overlay). */
  pickable = true
  /**
   * Whether a pointer drag over this node repositions it (see input/SceneInputDispatcher).
   * A drag only ever reaches a node that pickNode() returns, so `pickable = false` already
   * rules one out; this turns dragging off for a node that should still be selectable.
   */
  draggable = true

  /**
   * Where this shape sits in the scene-wide stack: higher is in FRONT. Assigned from a
   * running counter at construction (see zOrder.ts), so shapes stack in the order they were
   * made and a new one lands on top - the constructor overwrites this initialiser.
   *
   * Set it directly to restack: `shape.zIndex = nextZIndex()` brings it to the front, and any
   * negative value puts it behind everything that took its number from the counter.
   */
  zIndex = 0
  /**
   * When true the shape is drawn in the overlay pass, after everything else and without
   * writing depth - for editor furniture (selection frames, handles, rubber bands) that
   * must sit on top of the scene without occluding it. A translucent overlay that DID
   * write depth would punch a hole through whatever draws later, notably the text lane.
   */
  overlay = false

  // --- shadow (the canvas 2D model; see the file header) ------------------------------
  /** Shadow tint; its alpha is multiplied by shadowOpacity. */
  shadowColor: RGBA = [0, 0, 0, 1]
  /**
   * Canvas-style blur radius in LOCAL units: the silhouette is blurred by a Gaussian of
   * sigma = shadowBlur/2. Changing it re-bakes the shape's atlas texture, so it is the one
   * shadow field that isn't free to animate; the rest are per-frame quad parameters.
   */
  shadowBlur = 0
  /**
   * Grows the silhouette outward by this many local units before blurring it - or erodes it
   * inward when negative. Not part of the canvas 2D shadow model; this is CSS box-shadow's
   * spread, kept as a documented extension because it is genuinely useful and costs nothing
   * at draw time (it is baked into the atlas texture alongside the blur).
   *
   * The grow/shrink uses a square structuring element, so a large spread squares off corners
   * a touch - see webgpu/shaders/shadowBake.wgsl.ts. Like shadowBlur, changing it re-bakes.
   */
  shadowSpread = 0
  /**
   * Offset in local units, downward-positive. Scales with the shape's absolute scale but
   * is not turned by its rotation - see render/shadowMath.ts's shadowWorldOffset.
   */
  shadowOffsetX = 0
  shadowOffsetY = 0
  /** Multiplies shadowColor's alpha; 0 hides the shadow. */
  shadowOpacity = 1
  /** Master switch - false suppresses the shadow however the other fields are set. */
  shadowEnabled = true
  /**
   * Whether the stroke ring is part of the silhouette the shadow is cast from. False casts
   * from the fill alone, so a thick decorative outline doesn't fatten the shadow with it.
   * Re-bakes the atlas texture when changed.
   */
  shadowForStrokeEnabled = true

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

  // A Shape is its own (single) material - see materials(). Held as a fixed one-element
  // array so the common case costs no per-frame allocation in the batcher's hot loop.
  private readonly selfMaterials: readonly MeshMaterial[] = [this]

  private geometryCache: CachedGeometry | null = null
  // Derived from geometryCache (same lifetime, invalidated together) - a flat, picking-
  // friendly layout (no MeshSink round-trip) built lazily on first hitTestLocal()/
  // localBounds() call, not on every tessellate().
  private pickCache: PickGeometry | null = null
  private geometryVersionCounter = 0

  constructor(options: ShapeOptions = {}) {
    super(options)
    this.width = options.width ?? 0
    this.height = options.height ?? 0
    // No explicit value means "on top of what exists", which is what a caller who has not
    // thought about stacking almost always wants. An explicit one is taken as given and does
    // NOT advance the counter - see ShapeOptions.zIndex for what that costs.
    this.zIndex = options.zIndex ?? nextZIndex()
    this.overlay = options.overlay ?? false
    this.draggable = options.draggable ?? true
    this.shadowColor = options.shadowColor ?? [0, 0, 0, 1]
    this.shadowBlur = options.shadowBlur ?? 0
    this.shadowSpread = options.shadowSpread ?? 0
    this.shadowOffsetX = options.shadowOffsetX ?? 0
    this.shadowOffsetY = options.shadowOffsetY ?? 0
    this.shadowOpacity = options.shadowOpacity ?? 1
    this.shadowEnabled = options.shadowEnabled ?? true
    this.shadowForStrokeEnabled = options.shadowForStrokeEnabled ?? true
    this.fill = options.fill ?? [0, 0, 0, 1]
    this.stroke = options.stroke ?? [0, 0, 0, 1]
    this.strokeWidth = options.strokeWidth ?? 0
    this.lineJoin = options.lineJoin ?? 'miter'
    this.lineCap = options.lineCap ?? 'butt'
    this.miterLimit = options.miterLimit ?? 10
  }

  protected override attrKeys(): readonly string[] {
    return [
      ...super.attrKeys(),
      'visible',
      'pickable',
      'draggable',
      'zIndex',
      'overlay',
      'shadowColor',
      'shadowBlur',
      'shadowSpread',
      'shadowOffsetX',
      'shadowOffsetY',
      'shadowOpacity',
      'shadowEnabled',
      'shadowForStrokeEnabled',
      'width',
      'height',
      'fill',
      'fillPriority',
      'fillLinearGradientStartPoint',
      'fillLinearGradientEndPoint',
      'fillLinearGradientColorStops',
      'fillRadialGradientStartPoint',
      'fillRadialGradientStartRadius',
      'fillRadialGradientEndPoint',
      'fillRadialGradientEndRadius',
      'fillRadialGradientColorStops',
      'stroke',
      'strokeWidth',
      'lineJoin',
      'lineCap',
      'miterLimit',
    ]
  }

  /**
   * Whether this shape casts a shadow at all - the same test the canvas library uses:
   * enabled, not fully transparent, and at least one shadow field actually set (a shadow
   * with no blur and no offset would sit exactly behind the shape and never be seen).
   */
  hasShadow(): boolean {
    return (
      this.shadowEnabled &&
      this.shadowOpacity !== 0 &&
      this.shadowColor[3] !== 0 &&
      (this.shadowBlur !== 0 || this.shadowSpread !== 0 || this.shadowOffsetX !== 0 || this.shadowOffsetY !== 0)
    )
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
    this.geometryVersionCounter++
    // The renderer packs many shapes into shared buffers and cannot see this node's flag,
    // so the change is announced lane-wide too (see contentEpoch.ts).
    bumpMeshGeometryEpoch()
  }

  /**
   * Bumped by every markGeometryDirty(). The shadow atlas keys its baked silhouette on
   * this (see webgpu/ShadowAtlas.ts), so it re-bakes exactly when the geometry it
   * rasterized actually changed - and never merely because the shape moved.
   */
  get geometryVersion(): number {
    return this.geometryVersionCounter
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
    const remapped = geometry.vertices.map((v) => sink.vertex(v.x, v.y, v.isFill, v.material))
    for (const [a, b, c] of geometry.triangles) {
      sink.triangle(remapped[a], remapped[b], remapped[c])
    }
  }

  /**
   * The materials this shape's vertices select between via MeshSink's `material` index -
   * the paint for one object, not several placed objects (they all share this shape's
   * world matrix and depth). An ordinary shape has exactly one, itself, since Shape already
   * carries the whole fill/gradient/stroke vocabulary; only a shape whose parts are styled
   * independently - VectorText, whose runs each have their own color, gradient or outline -
   * overrides this.
   *
   * The returned list must line up with the material indices buildGeometry() emitted, so a
   * change that alters its LENGTH is a geometry change and needs markGeometryDirty() (and a
   * renderer-level rebuild) like any other. Changing a material's colors in place does not:
   * those are re-read into the per-object buffer every frame.
   */
  materials(): readonly MeshMaterial[] {
    return this.selfMaterials
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

  /**
   * A shape's caches are its tessellated triangles and the flattened picking layout derived
   * from them - the two things it holds that are proportional to its complexity rather than
   * constant, and the only reason destroying a path with ten thousand points is worth more
   * than destroying a rect.
   *
   * Nothing GPU-side is freed here, because nothing GPU-side is keyed on a shape's identity
   * in a way that outlives it. The lanes rebuild from the visible set every frame and repack
   * when their membership changes, and the shadow atlas prunes its per-shape entries against
   * the shapes actually present each time it bakes - so a destroyed shape's vertex range and
   * atlas slot come back on their own, on the next frame, whether it was destroyed or merely
   * removed.
   */
  protected override releaseResources(): void {
    this.geometryCache = null
    this.pickCache = null
  }

  private ensureGeometryCache(): CachedGeometry {
    if (!this.geometryCache) {
      const vertices: CachedVertex[] = []
      const triangles: CachedTriangle[] = []
      this.buildGeometry({
        vertex: (x, y, isFill, material = 0) => vertices.push({ x, y, isFill, material }) - 1,
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


interface CachedVertex {
  x: number
  y: number
  isFill: boolean
  /** Index into materials() - 0 for every single-material shape. */
  material: number
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
