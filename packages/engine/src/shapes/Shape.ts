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
// strokeScaleEnabled = false is the one exception to the first sentence, and the only place
// in the engine where a transform reaches geometry: a stroke held at a fixed width has to be
// built against the world scale, so a scale change genuinely invalidates it. Nobody has to
// call anything - refreshStrokeGauge() below is asked once per frame by the gather - but the
// rebuild is real, which is why the flag is opt-in per shape rather than a scene-wide mode.
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

import type { Vector2Like } from '../math/Vector2'
import { AABB } from '../math/AABB'
import { bumpMeshGeometryEpoch, bumpObjectRecordEpoch } from './contentEpoch'
import { Vector3 } from '../math/Vector3'
import { parseColor, parseStops } from '../render/color'
import type {ColorInput, ColorStopInput, FillPriority, GradientStop, MeshMaterial, MeshSink, RGBA} from '../render/meshFormat'
import { sameGauge, type LineCap, type LineJoin, type StrokeAlign, type StrokeGauge } from '../render/stroke'
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
   * How transparent the whole object is, 0 (invisible) to 1 (solid). Default 1.
   *
   * Separate from the alpha in `fill`/`stroke`, and multiplied with them - which is the
   * point. A colour's alpha is part of how the shape is PAINTED and belongs to the design;
   * this is a property of the object, the thing an editor's opacity slider drives and an
   * animation fades. Baking one into the other means a fade has to know and restore every
   * colour it touched.
   */
  opacity?: number
  /**
   * Draw in the always-on-top overlay pass (see webgpu/SceneRenderer). Default false.
   */
  overlay?: boolean
  /** Can a pointer drag reposition this node? See Shape.draggable. Default true. */
  draggable?: boolean
  /** Shadow tint. Default opaque black. */
  shadowColor?: ColorInput
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
  fill?: ColorInput
  stroke?: ColorInput
  /** Stroke width in world units; 0 = no stroke. */
  strokeWidth?: number
  /**
   * Which side of the outline the stroke expands onto: 'center' (default), 'inside' or
   * 'outside'. It changes the shape's measured size - see Shape.strokeAlign.
   */
  strokeAlign?: StrokeAlign
  lineJoin?: LineJoin
  /** Only applies to open contours (e.g. Polyline with `closed: false`). */
  lineCap?: LineCap
  miterLimit?: number
  /**
   * Whether the shape's scale applies to its stroke as well. Default true.
   *
   * False keeps the stroke `strokeWidth` wide however the node (or any ancestor) is scaled -
   * an outline that stays one pixel while the thing it outlines is resized. See
   * Shape.strokeScaleEnabled for what it costs, which is not nothing.
   */
  strokeScaleEnabled?: boolean
}

export abstract class Shape extends Node {
  override readonly nodeType: string = 'Shape'

  /** Skipped by the renderer when false. */
  visible = true
  /**
   * The object's own transparency, 0 to 1, multiplied into every fragment it paints - fill,
   * stroke, gradient, glyph, texture and its shadow alike.
   *
   * It does NOT cascade. A group's opacity is a different feature and a much harder one:
   * doing it correctly means drawing the group to an offscreen target and compositing that
   * once, because multiplying the value down onto each child instead makes the children show
   * through EACH OTHER wherever they overlap. Rather than ship the cheap version under the
   * right name, this stays what it says it is: one object's transparency.
   *
   * A shape whose parts are styled independently (VectorText's runs) has the same caveat in
   * miniature - each run is its own object record, so overlapping runs at opacity 0.5 blend
   * against one another. Runs rarely overlap, which is why this is a note and not a blocker.
   */
  private _opacity = 1
  get opacity(): number {
    return this._opacity
  }
  set opacity(value: number) {
    if (value === this._opacity) return
    this._opacity = value
    bumpObjectRecordEpoch()
  }

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
  private _zIndex = 0
  get zIndex(): number {
    return this._zIndex
  }
  set zIndex(value: number) {
    if (value === this._zIndex) return
    this._zIndex = value
    bumpObjectRecordEpoch()
  }
  /**
   * When true the shape is drawn in the overlay pass, after everything else and without
   * writing depth - for editor furniture (selection frames, handles, rubber bands) that
   * must sit on top of the scene without occluding it. A translucent overlay that DID
   * write depth would punch a hole through whatever draws later, notably the text lane.
   */
  overlay = false

  // --- shadow (the canvas 2D model; see the file header) ------------------------------
  private shadowColorValue: RGBA = [0, 0, 0, 1]
  /** Shadow tint; its alpha is multiplied by shadowOpacity. Accepts a string - see fill. */
  get shadowColor(): RGBA {
    return this.shadowColorValue
  }
  set shadowColor(value: ColorInput) {
    this.shadowColorValue = parseColor(value)
  }
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

  private fillValue: RGBA = [0, 0, 0, 1]
  /**
   * Flat fill colour, used when fillPriority is 'color'.
   *
   * Assign either form: the `[r, g, b, a]` tuple in 0..1, or a colour string - '#f80',
   * 'rgb(255 136 0)', 'hsl(32 100% 50%)', 'tomato', 'transparent' (see render/color.ts for the
   * full list). A string is converted here, once, and READING this always gives the tuple: the
   * batchers pull these per object per frame and have no business parsing anything.
   *
   * An unreadable string throws rather than falling back, since a colour that silently comes out
   * black looks like a design decision rather than a typo.
   */
  get fill(): RGBA {
    return this.fillValue
  }
  set fill(value: ColorInput) {
    this.fillValue = parseColor(value)
    bumpObjectRecordEpoch()
  }

  /** Which fill mechanism this shape's fill triangles use. */
  private _fillPriority: FillPriority = 'color'
  get fillPriority(): FillPriority {
    return this._fillPriority
  }
  set fillPriority(value: FillPriority) {
    if (value === this._fillPriority) return
    this._fillPriority = value
    bumpObjectRecordEpoch()
  }

  // Gradient geometry. Assigning a point announces itself; reaching through one to write .x
  // does not - see contentEpoch.ts, and assign a new object instead.
  private _fillLinearGradientStartPoint: Vector2Like = { x: 0, y: 0 }
  get fillLinearGradientStartPoint(): Vector2Like {
    return this._fillLinearGradientStartPoint
  }
  set fillLinearGradientStartPoint(value: Vector2Like) {
    this._fillLinearGradientStartPoint = value
    bumpObjectRecordEpoch()
  }
  private _fillLinearGradientEndPoint: Vector2Like = { x: 0, y: 0 }
  get fillLinearGradientEndPoint(): Vector2Like {
    return this._fillLinearGradientEndPoint
  }
  set fillLinearGradientEndPoint(value: Vector2Like) {
    this._fillLinearGradientEndPoint = value
    bumpObjectRecordEpoch()
  }
  private linearStops: GradientStop[] = []
  /** Linear gradient stops. Each stop's `color` accepts a string as well as the tuple. */
  get fillLinearGradientColorStops(): GradientStop[] {
    return this.linearStops
  }
  set fillLinearGradientColorStops(value: readonly ColorStopInput[]) {
    this.linearStops = parseStops(value)
    bumpObjectRecordEpoch()
  }

  private _fillRadialGradientStartPoint: Vector2Like = { x: 0, y: 0 }
  get fillRadialGradientStartPoint(): Vector2Like {
    return this._fillRadialGradientStartPoint
  }
  set fillRadialGradientStartPoint(value: Vector2Like) {
    this._fillRadialGradientStartPoint = value
    bumpObjectRecordEpoch()
  }
  private _fillRadialGradientStartRadius = 0
  get fillRadialGradientStartRadius(): number {
    return this._fillRadialGradientStartRadius
  }
  set fillRadialGradientStartRadius(value: number) {
    if (value === this._fillRadialGradientStartRadius) return
    this._fillRadialGradientStartRadius = value
    bumpObjectRecordEpoch()
  }
  private _fillRadialGradientEndPoint: Vector2Like = { x: 0, y: 0 }
  get fillRadialGradientEndPoint(): Vector2Like {
    return this._fillRadialGradientEndPoint
  }
  set fillRadialGradientEndPoint(value: Vector2Like) {
    this._fillRadialGradientEndPoint = value
    bumpObjectRecordEpoch()
  }
  private _fillRadialGradientEndRadius = 0
  get fillRadialGradientEndRadius(): number {
    return this._fillRadialGradientEndRadius
  }
  set fillRadialGradientEndRadius(value: number) {
    if (value === this._fillRadialGradientEndRadius) return
    this._fillRadialGradientEndRadius = value
    bumpObjectRecordEpoch()
  }
  private radialStops: GradientStop[] = []
  /** Radial gradient stops. Each stop's `color` accepts a string as well as the tuple. */
  get fillRadialGradientColorStops(): GradientStop[] {
    return this.radialStops
  }
  set fillRadialGradientColorStops(value: readonly ColorStopInput[]) {
    this.radialStops = parseStops(value)
    bumpObjectRecordEpoch()
  }

  private strokeValue: RGBA = [0, 0, 0, 1]
  /** Stroke colour. Accepts a string as well as the tuple - see fill. */
  get stroke(): RGBA {
    return this.strokeValue
  }
  set stroke(value: ColorInput) {
    this.strokeValue = parseColor(value)
    bumpObjectRecordEpoch()
  }
  strokeWidth = 0
  /**
   * Which way the stroke expands from the outline it follows.
   *
   * 'center' is the classic behaviour and the default: the ribbon straddles the outline, half
   * the width to each side, which is all Canvas2D and SVG offer. 'inside' puts the whole width
   * on the fill's side, so the shape's silhouette is exactly its outline and a stroke can be
   * thickened without the node growing; 'outside' puts it all on the other side, leaving the
   * fill untouched and growing the node by the full width.
   *
   * BECAUSE IT MOVES GEOMETRY, IT MOVES THE MEASUREMENTS. localBounds() is the extent of the
   * triangles this shape actually emits, so a 100x60 rect with a 20-wide stroke measures
   * 120x80 centred, 140x100 outside, and exactly 100x60 inside - and everything that reads
   * bounds follows: the transformer's frame, marquee selection, the shadow silhouette, and
   * culling. That is what makes an inside stroke the one to reach for when a border must not
   * change what a box takes up on screen.
   *
   * An OPEN path has no inside, so it is stroked about its centre whatever this says - the
   * question has no answer for a line. On a shape with holes, this is read as a statement
   * about the shape rather than about each ring: an inside stroke eats into the material on
   * the hole's rim as well as on the outer edge (see strokeContours).
   *
   * Like strokeWidth, it is baked into geometry: assigning it needs markGeometryDirty().
   */
  strokeAlign: StrokeAlign = 'center'
  lineJoin: LineJoin = 'miter'
  lineCap: LineCap = 'butt'
  miterLimit = 10
  /**
   * Whether the shape's scale applies to its stroke as well. Default true.
   *
   * True is the ordinary reading: a stroke width is a local-space measurement like every
   * other coordinate, so a node at scale 3 draws a ribbon three times as thick, and the whole
   * shape zooms as one picture.
   *
   * False is the other thing people mean by a stroke - a keyline, a selection outline, a
   * hairline on a technical drawing - which is a fixed width that the object's size has
   * nothing to do with. The ribbon is then built to arrive at exactly `strokeWidth` AFTER the
   * world transform, and it stays that width under non-uniform scale and skew too, not just
   * under a uniform one (see StrokeGauge).
   *
   * WHAT IT COSTS, and why it is not the default. A stroke lives in the tessellated geometry,
   * and the whole design elsewhere is that a transform never touches geometry: it is applied
   * per frame from the world matrix, so moving, turning and scaling are free. A stroke that
   * has to come out the same width under any scale cannot be free that way - the triangles
   * genuinely differ - so the shape re-tessellates whenever its world scale changes, and that
   * costs its lane a repack. Standing still it costs nothing at all; dragged through a live
   * resize it is a rebuild per frame. Set it on the handful of nodes that want a keyline, not
   * across a scene.
   *
   * Rotation and translation change nothing, since neither can alter a ribbon's width.
   */
  strokeScaleEnabled = true

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
    this.opacity = options.opacity ?? 1
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
    this.strokeAlign = options.strokeAlign ?? 'center'
    this.lineJoin = options.lineJoin ?? 'miter'
    this.lineCap = options.lineCap ?? 'butt'
    this.miterLimit = options.miterLimit ?? 10
    this.strokeScaleEnabled = options.strokeScaleEnabled ?? true
  }

  protected override attrKeys(): readonly string[] {
    return [
      ...super.attrKeys(),
      'visible',
      'pickable',
      'draggable',
      'zIndex',
      'opacity',
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
      'strokeAlign',
      'lineJoin',
      'lineCap',
      'miterLimit',
      'strokeScaleEnabled',
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
      this.geometryCache = { vertices, triangles, gauge: this.strokeGauge() }
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
   * The transform this shape's stroke is to be measured after, or undefined when the stroke
   * follows the scale like everything else (the default, and every shape until it says
   * otherwise). Shapes pass it straight to the stroker as `gauge` - see StrokeGauge.
   *
   * The linear part of the WORLD matrix, not the local one: a shape inside a group scaled by
   * 4 is drawn four times as large whether it was scaled itself or not, so a keyline that
   * only compensated for its own scaleX would be wrong by exactly the group's.
   */
  protected strokeGauge(): StrokeGauge | undefined {
    if (this.strokeScaleEnabled) return undefined
    const m = this.worldMatrix().m
    // Column-major: column 0 is the x axis, column 1 the y axis (see Node.applyLocalMatrix).
    return { a: m[0], b: m[1], c: m[4], d: m[5] }
  }

  /**
   * Drops the cached geometry if the scale it was built against has moved. Returns whether it
   * did. Called once per shape per frame by the gather (render/gather.ts).
   *
   * This is the price of strokeScaleEnabled = false, and the reason it is opt-in: nothing else
   * in the engine has to be told that a transform changed, because nothing else bakes one into
   * geometry. A stroke of fixed width does, so something has to notice, and the shape cannot
   * notice on its own - its world scale depends on every ancestor, and no setter anywhere is
   * in a position to say that a whole subtree's strokes are now stale.
   *
   * For a shape that has not opted out - which is almost all of them - this is one boolean
   * read and a return, which is what keeps it affordable in a per-frame loop over the visible
   * set.
   */
  refreshStrokeGauge(): boolean {
    if (this.strokeScaleEnabled) return false
    const cache = this.geometryCache
    // Nothing built yet is not stale; the first tessellation will read the current scale.
    if (!cache) return false
    if (sameGauge(cache.gauge, this.strokeGauge())) return false
    this.markGeometryDirty()
    return true
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
  /** The world scale this was built against, when the stroke was told not to follow it. */
  gauge: StrokeGauge | undefined
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
