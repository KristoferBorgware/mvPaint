// Shape - the base for every drawable scene-graph node (Rect, Circle, Polyline, Path,
// MSDFText, VectorText). Carries what is specific to PAINTING and is common to every drawable:
// the overlay pass, the complete fill/stroke styling API (flat colour or gradient fill; stroke
// colour, width, dash, join, cap, miter limit and alignment) and the shadow settings - all in
// one place rather than split by how a shape happens to be drawn. Concrete shapes only add
// what's genuinely specific to them (Rect: corner rounding; Circle: radius; Polyline: points;
// Path: contours; MSDFText/VectorText: runs and block layout).
//
// What every node carries is NOT here: the transform, plus width/height, visible, opacity,
// zIndex, listening, preventDefault and the three drag fields all live on Node (see that
// file's header). Placing and hiding yourself, fading, and being dragged are not drawing
// concerns - a Group does all of them while drawing nothing - so a shape and a group have to
// behave identically there or the same gesture would treat them differently.
//
// Two of those Shape does have an opinion about. It takes its zIndex from the running counter
// (zOrder.ts) rather than leaving it at 0, since only a Shape occupies a slot in the render
// order; and its width/height are read by the shapes that draw from a size.
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
// buildGeometry() defaults to emitting nothing - that's what makes it safe for MSDFText
// (which renders through the separate MSDF text lane, not the mesh lane) to inherit it
// unchanged. VectorText, the other text implementation, overrides it like any mesh shape:
// it tessellates real glyph outlines, and is therefore picked, bounded and shadowed by
// everything below without a single special case.
//
// hitTestLocal()/localBounds() (used by scene/picking.ts) read two further caches derived from
// that same output and invalidated with it: a flat xs/ys/tris/bounds layout for repeated point
// tests, and the drawn extent as a box. Neither is a second tessellation, so repeated picks
// against an unchanged shape (every mousemove while hovering) redo no array-building work. The
// one exception is a shape with its own hitStrokeWidth, whose hit ribbon really is different
// triangles and so really is a second pass - see ensurePickCache.
//
// WHAT INVALIDATES WHAT. A transform change (x/y/rotation/scale/offset/zIndex) invalidates
// nothing: it is applied per frame from the object's world matrix and never baked into the
// cached local-space geometry. A fill or stroke COLOUR is the same - solid colours, like
// gradient parameters, are read from the per-object buffer every frame, which is also why
// fillEnabled is free while strokeEnabled is not.
//
// Everything buildGeometry() reads announces itself. Every geometry input on this class and its
// subclasses is an accessor that calls markGeometryDirty() when the value actually changes:
// strokeWidth, strokeEnabled, strokeAlign, dash, dashOffset, dashEnabled, lineJoin, lineCap,
// miterLimit and strokeScaleEnabled here, and Circle.radius, Rect.cornerRadius,
// Polyline.points, Path.contours, Path.filled and CustomShape.tolerance on the shapes that have
// them. `stroke` is the one that does both - a colour swap is a record rewrite, while gaining
// or losing a colour changes whether a ribbon exists at all.
//
// Two things still need the call by hand, because neither is an assignment this class can see:
// mutating an array in place (points.push(), or editing a contour) rather than assigning a new
// one, and a CustomShape property that its own describe() reads.
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
//   - Everything else - Rect, Image, MSDFText, VectorText - hangs from its TOP-LEFT corner,
//     extending right and downward. The scene is y-down, so such a shape spans x in
//     [0, width] and y in [0, height] in its own local space.
//   - Polyline and Path have no implied origin at all: their points and contours are
//     already local coordinates, placed wherever they were authored.
//
// The practical consequence is the pivot. Rotation and scale are about the local origin,
// so a Circle turns about its middle while a Rect turns about its corner. To spin a Rect
// about its own centre, give it `offsetX: width / 2, offsetY: height / 2`.
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
// MSDFText ignores these fields: it carries its own per-run shadow styling instead (an offset
// duplicate of the glyphs, see text/layout.ts), since it has no mesh geometry to
// rasterize a silhouette from. VectorText, which does, honours them like any other mesh
// shape - a blurred shadow cast from the letterforms themselves.

import type { Vector2Like } from '../math/Vector2'
import { AABB } from '../math/AABB'
import { bumpMeshGeometryEpoch, bumpObjectRecordEpoch } from './contentEpoch'
import { Vector3 } from '../math/Vector3'
import { parseColor, parseStops } from '../render/color'
import type {ColorInput, ColorStopsInput, FillPriority, GradientStop, MeshMaterial, MeshSink, RGBA} from '../render/meshFormat'
import { sameGauge, type LineCap, type LineJoin, type StrokeAlign, type StrokeGauge } from '../render/stroke'
import { NODE_ATTR_DEFAULTS, Node, type ClientRectOptions, type NodeOptions } from './Node'
import { nextZIndex } from './zOrder'

/**
 * The one empty pattern every solid shape shares, so that a scene of ten thousand undashed
 * shapes allocates no array for the dash it does not have - and so that the constructor's
 * `dash ?? EMPTY_DASH` matches the default by identity and announces nothing.
 */
const EMPTY_DASH: readonly number[] = Object.freeze([])

export interface ShapeOptions extends NodeOptions {
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
  /** Flat fill colour. Omitted (or null) is no fill - the shape draws nothing but still picks. */
  fill?: ColorInput | null
  /** Master switch over the fill, keeping its colour. Default true. See Shape.fillEnabled. */
  fillEnabled?: boolean
  /** Master switch over the stroke, keeping its colour and width. Default true. */
  strokeEnabled?: boolean
  /** Outline colour. Omitted (or null) is no outline, whatever strokeWidth says. */
  stroke?: ColorInput | null
  /** Stroke width in world units; 0 = no stroke. Default 2. */
  strokeWidth?: number
  /** Stroke width used for hit-testing alone. Default 'auto' - the drawn width. */
  hitStrokeWidth?: number | 'auto'
  /** Alternating on/off lengths in local units. Default solid. See Shape.dash. */
  dash?: readonly number[]
  /** How far into the dash pattern the outline starts. Default 0. */
  dashOffset?: number
  /** Master switch over the dash, keeping the pattern. Default true. */
  dashEnabled?: boolean
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

  /**
   * When true the shape is drawn in the overlay pass, after everything else and without
   * writing depth - for editor furniture (selection frames, handles, rubber bands) that
   * must sit on top of the scene without occluding it. A translucent overlay that DID
   * write depth would punch a hole through whatever draws later, notably the text lane.
   */
  private _overlay = false
  get overlay(): boolean {
    return this._overlay
  }
  set overlay(value: boolean) {
    if (value === this._overlay) return
    const previous = this._overlay
    this._overlay = value
    this.announce('overlay', previous, value)
  }

  // --- shadow (the canvas 2D model; see the file header) ------------------------------
  private shadowColorValue: RGBA = [0, 0, 0, 1]
  private shadowColorWritten: ColorInput = [0, 0, 0, 1]
  /** Shadow tint; its alpha is multiplied by shadowOpacity. Accepts a string - see fill. */
  get shadowColor(): RGBA {
    return this.shadowColorValue
  }
  set shadowColor(value: ColorInput) {
    if (value === this.shadowColorWritten) return
    const previous = this.shadowColorValue
    this.shadowColorValue = parseColor(value)
    this.shadowColorWritten = value
    this.announce('shadowColor', previous, this.shadowColorValue)
  }
  /** What shadowColor was last assigned, in the form it was written. See fillInput. */
  get shadowColorInput(): ColorInput {
    return this.shadowColorWritten
  }
  /**
   * Canvas-style blur radius in LOCAL units: the silhouette is blurred by a Gaussian of
   * sigma = shadowBlur/2. Changing it re-bakes the shape's atlas texture, so it is the one
   * shadow field that isn't free to animate; the rest are per-frame quad parameters.
   */
  private _shadowBlur = 0
  get shadowBlur(): number {
    return this._shadowBlur
  }
  set shadowBlur(value: number) {
    if (value === this._shadowBlur) return
    const previous = this._shadowBlur
    this._shadowBlur = value
    this.announce('shadowBlur', previous, value)
  }
  /**
   * Grows the silhouette outward by this many local units before blurring it - or erodes it
   * inward when negative. Not part of the canvas 2D shadow model; this is CSS box-shadow's
   * spread, kept as a documented extension because it is genuinely useful and costs nothing
   * at draw time (it is baked into the atlas texture alongside the blur).
   *
   * The grow/shrink uses a square structuring element, so a large spread squares off corners
   * a touch - see webgpu/shaders/shadowBake.wgsl.ts. Like shadowBlur, changing it re-bakes.
   */
  private _shadowSpread = 0
  get shadowSpread(): number {
    return this._shadowSpread
  }
  set shadowSpread(value: number) {
    if (value === this._shadowSpread) return
    const previous = this._shadowSpread
    this._shadowSpread = value
    this.announce('shadowSpread', previous, value)
  }
  /**
   * Offset in local units, downward-positive. Scales with the shape's absolute scale but
   * is not turned by its rotation - see render/shadowMath.ts's shadowWorldOffset.
   */
  private _shadowOffsetX = 0
  get shadowOffsetX(): number {
    return this._shadowOffsetX
  }
  set shadowOffsetX(value: number) {
    if (value === this._shadowOffsetX) return
    const previous = this._shadowOffsetX
    this._shadowOffsetX = value
    this.announce('shadowOffsetX', previous, value)
  }
  private _shadowOffsetY = 0
  get shadowOffsetY(): number {
    return this._shadowOffsetY
  }
  set shadowOffsetY(value: number) {
    if (value === this._shadowOffsetY) return
    const previous = this._shadowOffsetY
    this._shadowOffsetY = value
    this.announce('shadowOffsetY', previous, value)
  }
  /** Multiplies shadowColor's alpha; 0 hides the shadow. */
  private _shadowOpacity = 1
  get shadowOpacity(): number {
    return this._shadowOpacity
  }
  set shadowOpacity(value: number) {
    if (value === this._shadowOpacity) return
    const previous = this._shadowOpacity
    this._shadowOpacity = value
    this.announce('shadowOpacity', previous, value)
  }
  /** Master switch - false suppresses the shadow however the other fields are set. */
  private _shadowEnabled = true
  get shadowEnabled(): boolean {
    return this._shadowEnabled
  }
  set shadowEnabled(value: boolean) {
    if (value === this._shadowEnabled) return
    const previous = this._shadowEnabled
    this._shadowEnabled = value
    this.announce('shadowEnabled', previous, value)
  }
  /**
   * Whether the stroke ring is part of the silhouette the shadow is cast from. False casts
   * from the fill alone, so a thick decorative outline doesn't fatten the shadow with it.
   * Re-bakes the atlas texture when changed.
   */
  private _shadowForStrokeEnabled = true
  get shadowForStrokeEnabled(): boolean {
    return this._shadowForStrokeEnabled
  }
  set shadowForStrokeEnabled(value: boolean) {
    if (value === this._shadowForStrokeEnabled) return
    const previous = this._shadowForStrokeEnabled
    this._shadowForStrokeEnabled = value
    this.announce('shadowForStrokeEnabled', previous, value)
  }

  private fillValue: RGBA | null = null
  /**
   * Flat fill colour, used when fillPriority is 'color'. `null` - the default - is a shape
   * with no fill at all, which draws nothing but stays hit-testable over its whole face.
   *
   * Assign either form: the `[r, g, b, a]` tuple in 0..1, or a colour string - '#f80',
   * 'rgb(255 136 0)', 'hsl(32 100% 50%)', 'tomato', 'transparent' (see render/color.ts for the
   * full list). A string is converted here, once, and READING this always gives the tuple: the
   * batchers pull these per object per frame and have no business parsing anything.
   *
   * An unreadable string throws rather than falling back, since a colour that silently comes out
   * black looks like a design decision rather than a typo.
   */
  get fill(): RGBA | null {
    return this.fillValue
  }
  set fill(value: ColorInput | null) {
    // Compared on the form it was WRITTEN in, which is what a caller can reasonably expect to
    // hold still: 'tomato' twice is one colour, while a freshly built tuple is a new value even
    // if its four numbers match - the same identity rule the gradient points follow.
    if (value === this.fillWritten) return
    const previous = this.fillValue
    this.fillValue = value === null ? null : parseColor(value)
    this.fillWritten = value
    bumpObjectRecordEpoch()
    this.announce('fill', previous, this.fillValue)
  }
  private fillWritten: ColorInput | null = null
  /**
   * What `fill` was last assigned, in the form it was written - 'tomato' comes back as
   * 'tomato', not as the tuple it renders through.
   *
   * The parsed tuple is what the shape IS, and every colour comparison the engine makes uses
   * it. This is for the code on the other side: a swatch that has to show which preset is
   * selected, a serializer writing a document back out in the vocabulary its author used.
   * Those need the word, and cannot recover it from four numbers.
   */
  get fillInput(): ColorInput | null {
    return this.fillWritten
  }

  /**
   * A master switch over the fill, leaving the colour and the gradient where they are.
   *
   * Free, and free to animate: the fill mechanism is a per-object record the batchers rewrite
   * every frame, so switching this reads as 'none' from the next frame without repacking a
   * buffer. That is the difference from strokeEnabled - see there.
   */
  private _fillEnabled = true
  get fillEnabled(): boolean {
    return this._fillEnabled
  }
  set fillEnabled(value: boolean) {
    if (value === this._fillEnabled) return
    const previous = this._fillEnabled
    this._fillEnabled = value
    bumpObjectRecordEpoch()
    this.announce('fillEnabled', previous, value)
  }

  /**
   * A master switch over the stroke, leaving strokeWidth and the colour where they are.
   *
   * It RE-TESSELLATES, where fillEnabled does not, and the asymmetry is in how the two are
   * drawn rather than in the flags. A fill's triangles exist whatever the fill says and the
   * paint is chosen per frame; a stroke's ribbon is geometry the stroker either emitted or did
   * not, so switching this is the same kind of change as changing the width.
   *
   * Because it moves geometry it moves the measurements too - localBounds() is the extent of
   * the triangles actually emitted, so a shape with its stroke switched off measures its fill
   * alone. See strokeAlign for the same effect from the other direction.
   */
  private _strokeEnabled = true
  get strokeEnabled(): boolean {
    return this._strokeEnabled
  }
  set strokeEnabled(value: boolean) {
    if (value === this._strokeEnabled) return
    const previous = this._strokeEnabled
    this._strokeEnabled = value
    this.markGeometryDirty()
    this.announce('strokeEnabled', previous, value)
  }

  /**
   * Whether this shape's fill paints anything: switched on, and a colour or a gradient with
   * stops in it.
   *
   * Not the same as having fill TRIANGLES, which every closed shape has regardless - see
   * FillPriority's 'none' for why they are kept.
   */
  hasFill(): boolean {
    return this.fillPriority !== 'none'
  }

  /** Whether this shape's stroke paints anything: switched on, a colour, AND a width. */
  hasStroke(): boolean {
    return this._strokeEnabled && this.strokeValue !== null && this.strokeWidth > 0
  }

  /**
   * Which fill mechanism this shape's fill triangles use.
   *
   * Reads as 'none' whenever the chosen mechanism has nothing to draw with - no fill colour,
   * or a gradient with no stops - so everything downstream asks one field rather than each
   * re-deriving the same emptiness test. Writing it records the CHOICE; the choice is what
   * comes back once there is something to paint.
   */
  private _fillPriority: FillPriority = 'color'
  get fillPriority(): FillPriority {
    if (!this._fillEnabled) return 'none'
    if (this._fillPriority === 'color') return this.fillValue === null ? 'none' : 'color'
    if (this._fillPriority === 'linear-gradient') return this.linearStops.length > 0 ? 'linear-gradient' : 'none'
    if (this._fillPriority === 'radial-gradient') return this.radialStops.length > 0 ? 'radial-gradient' : 'none'
    return 'none'
  }
  set fillPriority(value: FillPriority) {
    if (value === this._fillPriority) return
    const previous = this._fillPriority
    this._fillPriority = value
    bumpObjectRecordEpoch()
    this.announce('fillPriority', previous, value)
  }

  // Gradient geometry. Assigning a point announces itself; reaching through one to write .x
  // does not - see contentEpoch.ts, and assign a new object instead.
  private _fillLinearGradientStartPoint: Vector2Like = { x: 0, y: 0 }
  get fillLinearGradientStartPoint(): Vector2Like {
    return this._fillLinearGradientStartPoint
  }
  set fillLinearGradientStartPoint(value: Vector2Like) {
    if (value === this._fillLinearGradientStartPoint) return
    const previous = this._fillLinearGradientStartPoint
    this._fillLinearGradientStartPoint = value
    bumpObjectRecordEpoch()
    this.announce('fillLinearGradientStartPoint', previous, value)
  }
  private _fillLinearGradientEndPoint: Vector2Like = { x: 0, y: 0 }
  get fillLinearGradientEndPoint(): Vector2Like {
    return this._fillLinearGradientEndPoint
  }
  set fillLinearGradientEndPoint(value: Vector2Like) {
    if (value === this._fillLinearGradientEndPoint) return
    const previous = this._fillLinearGradientEndPoint
    this._fillLinearGradientEndPoint = value
    bumpObjectRecordEpoch()
    this.announce('fillLinearGradientEndPoint', previous, value)
  }
  private linearStops: GradientStop[] = []
  private linearStopsWritten: ColorStopsInput = []
  /**
   * Linear gradient stops, as `{offset, color}` however they were written. Assign either the
   * object list or one flat array alternating the two - `[0, 'red', 1, 'blue']` - and either
   * form of colour within it.
   */
  get fillLinearGradientColorStops(): GradientStop[] {
    return this.linearStops
  }
  set fillLinearGradientColorStops(value: ColorStopsInput) {
    if (value === this.linearStopsWritten) return
    const previous = this.linearStops
    this.linearStops = parseStops(value)
    this.linearStopsWritten = value
    bumpObjectRecordEpoch()
    this.announce('fillLinearGradientColorStops', previous, this.linearStops)
  }
  /** The stop list as it was written, flat form included. See fillInput. */
  get fillLinearGradientColorStopsInput(): ColorStopsInput {
    return this.linearStopsWritten
  }

  private _fillRadialGradientStartPoint: Vector2Like = { x: 0, y: 0 }
  get fillRadialGradientStartPoint(): Vector2Like {
    return this._fillRadialGradientStartPoint
  }
  set fillRadialGradientStartPoint(value: Vector2Like) {
    if (value === this._fillRadialGradientStartPoint) return
    const previous = this._fillRadialGradientStartPoint
    this._fillRadialGradientStartPoint = value
    bumpObjectRecordEpoch()
    this.announce('fillRadialGradientStartPoint', previous, value)
  }
  private _fillRadialGradientStartRadius = 0
  get fillRadialGradientStartRadius(): number {
    return this._fillRadialGradientStartRadius
  }
  set fillRadialGradientStartRadius(value: number) {
    if (value === this._fillRadialGradientStartRadius) return
    const previous = this._fillRadialGradientStartRadius
    this._fillRadialGradientStartRadius = value
    bumpObjectRecordEpoch()
    this.announce('fillRadialGradientStartRadius', previous, value)
  }
  private _fillRadialGradientEndPoint: Vector2Like = { x: 0, y: 0 }
  get fillRadialGradientEndPoint(): Vector2Like {
    return this._fillRadialGradientEndPoint
  }
  set fillRadialGradientEndPoint(value: Vector2Like) {
    if (value === this._fillRadialGradientEndPoint) return
    const previous = this._fillRadialGradientEndPoint
    this._fillRadialGradientEndPoint = value
    bumpObjectRecordEpoch()
    this.announce('fillRadialGradientEndPoint', previous, value)
  }
  private _fillRadialGradientEndRadius = 0
  get fillRadialGradientEndRadius(): number {
    return this._fillRadialGradientEndRadius
  }
  set fillRadialGradientEndRadius(value: number) {
    if (value === this._fillRadialGradientEndRadius) return
    const previous = this._fillRadialGradientEndRadius
    this._fillRadialGradientEndRadius = value
    bumpObjectRecordEpoch()
    this.announce('fillRadialGradientEndRadius', previous, value)
  }
  private radialStops: GradientStop[] = []
  private radialStopsWritten: ColorStopsInput = []
  /** Radial gradient stops. Takes both written forms - see fillLinearGradientColorStops. */
  get fillRadialGradientColorStops(): GradientStop[] {
    return this.radialStops
  }
  set fillRadialGradientColorStops(value: ColorStopsInput) {
    if (value === this.radialStopsWritten) return
    const previous = this.radialStops
    this.radialStops = parseStops(value)
    this.radialStopsWritten = value
    bumpObjectRecordEpoch()
    this.announce('fillRadialGradientColorStops', previous, this.radialStops)
  }
  /** The stop list as it was written, flat form included. See fillInput. */
  get fillRadialGradientColorStopsInput(): ColorStopsInput {
    return this.radialStopsWritten
  }

  private strokeValue: RGBA | null = null
  private strokeWritten: ColorInput | null = null
  /**
   * Stroke colour. Accepts a string as well as the tuple - see fill. `null` - the default -
   * is a shape with no outline, whatever its strokeWidth says.
   */
  get stroke(): RGBA | null {
    return this.strokeValue
  }
  set stroke(value: ColorInput | null) {
    if (value === this.strokeWritten) return
    const previous = this.strokeValue
    const next = value === null ? null : parseColor(value)
    // One colour for another is a record rewrite and nothing else. Gaining or losing a colour
    // is a geometry change: hasStroke() is what decides whether the stroker emits a ribbon at
    // all, so the triangles differ either side of null.
    const drewBefore = previous !== null
    this.strokeValue = next
    this.strokeWritten = value
    bumpObjectRecordEpoch()
    if (drewBefore !== (next !== null)) this.markGeometryDirty()
    this.announce('stroke', previous, next)
  }
  /** What stroke was last assigned, in the form it was written. See fillInput. */
  get strokeInput(): ColorInput | null {
    return this.strokeWritten
  }
  /**
   * How wide the outline is drawn, in world units. 0 draws none whatever `stroke` says.
   *
   * The stroker bakes this into real triangles, so assigning it re-tessellates the shape.
   * Guarded on the value differing, so writing the same width back costs nothing.
   */
  private _strokeWidth = 0
  get strokeWidth(): number {
    return this._strokeWidth
  }
  set strokeWidth(value: number) {
    if (value === this._strokeWidth) return
    const previous = this._strokeWidth
    this._strokeWidth = value
    this.markGeometryDirty()
    this.announce('strokeWidth', previous, value)
  }
  /**
   * Alternating on/off lengths in local units - `[10, 5]` is ten drawn, five blank, repeating.
   * Empty (the default) draws a solid line. An odd-length list is doubled, so `[6]` is six on
   * and six off.
   *
   * Measured along the OUTLINE rather than per edge, so a dash keeps its length around a corner
   * and a dash spanning one still gets a proper join. Each drawn piece is an open path and is
   * therefore capped per `lineCap` - which is what makes `lineCap: 'round'` turn `[0, 12]` into
   * a dotted line.
   *
   * It is real geometry, not a shader trick: each piece is a ribbon of its own, so assigning
   * this re-tessellates, and a very fine pattern over a long path is a lot of triangles. It
   * follows the shape's scale like the rest of the geometry, and under strokeScaleEnabled =
   * false it is measured after the transform along with the width.
   *
   * Assigning a new list announces itself; editing the one already there does not - see
   * Polyline.points for the same rule.
   */
  private _dash: readonly number[] = []
  get dash(): readonly number[] {
    return this._dash
  }
  set dash(value: readonly number[]) {
    if (value === this._dash) return
    const previous = this._dash
    this._dash = value
    this.markGeometryDirty()
    this.announce('dash', previous, value)
  }

  /**
   * How far into the dash pattern the outline starts, in local units. Animating it is what
   * makes a marching-ants selection border - at the price of a re-tessellation per frame,
   * since a dash is geometry.
   */
  private _dashOffset = 0
  get dashOffset(): number {
    return this._dashOffset
  }
  set dashOffset(value: number) {
    if (value === this._dashOffset) return
    const previous = this._dashOffset
    this._dashOffset = value
    this.markGeometryDirty()
    this.announce('dashOffset', previous, value)
  }

  /** Master switch over the dash, keeping the pattern. False draws the outline solid. */
  private _dashEnabled = true
  get dashEnabled(): boolean {
    return this._dashEnabled
  }
  set dashEnabled(value: boolean) {
    if (value === this._dashEnabled) return
    const previous = this._dashEnabled
    this._dashEnabled = value
    this.markGeometryDirty()
    this.announce('dashEnabled', previous, value)
  }

  /**
   * The pattern the stroker is to use, or undefined for a solid line - what a shape passes as
   * `dash`, rather than reading the field, so that dashEnabled is honoured in one place.
   */
  protected dashForBuild(): readonly number[] | undefined {
    return this._dashEnabled && this._dash.length > 0 ? this._dash : undefined
  }

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
   * Like strokeWidth, it is baked into geometry, so assigning it re-tessellates the shape.
   */
  private _strokeAlign: StrokeAlign = 'center'
  get strokeAlign(): StrokeAlign {
    return this._strokeAlign
  }
  set strokeAlign(value: StrokeAlign) {
    if (value === this._strokeAlign) return
    const previous = this._strokeAlign
    this._strokeAlign = value
    this.markGeometryDirty()
    this.announce('strokeAlign', previous, value)
  }

  // The remaining four stroke shapes. Each is read by the stroker while it builds the ribbon,
  // so each re-tessellates on assignment, guarded on the value differing.
  private _lineJoin: LineJoin = 'miter'
  get lineJoin(): LineJoin {
    return this._lineJoin
  }
  set lineJoin(value: LineJoin) {
    if (value === this._lineJoin) return
    const previous = this._lineJoin
    this._lineJoin = value
    this.markGeometryDirty()
    this.announce('lineJoin', previous, value)
  }

  private _lineCap: LineCap = 'butt'
  get lineCap(): LineCap {
    return this._lineCap
  }
  set lineCap(value: LineCap) {
    if (value === this._lineCap) return
    const previous = this._lineCap
    this._lineCap = value
    this.markGeometryDirty()
    this.announce('lineCap', previous, value)
  }

  private _miterLimit = 10
  get miterLimit(): number {
    return this._miterLimit
  }
  set miterLimit(value: number) {
    if (value === this._miterLimit) return
    const previous = this._miterLimit
    this._miterLimit = value
    this.markGeometryDirty()
    this.announce('miterLimit', previous, value)
  }
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
   *
   * Switching it re-tessellates once, here. Keeping a fixed-width stroke correct AFTERWARDS is
   * the per-frame sweep's job (refreshStrokeGauge), because a world scale is not something a
   * setter can see coming.
   */
  private _strokeScaleEnabled = true
  get strokeScaleEnabled(): boolean {
    return this._strokeScaleEnabled
  }
  set strokeScaleEnabled(value: boolean) {
    if (value === this._strokeScaleEnabled) return
    const previous = this._strokeScaleEnabled
    this._strokeScaleEnabled = value
    this.markGeometryDirty()
    this.announce('strokeScaleEnabled', previous, value)
  }

  // A Shape is its own (single) material - see materials(). Held as a fixed one-element
  // array so the common case costs no per-frame allocation in the batcher's hot loop.
  private readonly selfMaterials: readonly MeshMaterial[] = [this]

  /**
   * The width the outline is stroked at FOR HIT-TESTING, in place of the width it is drawn at.
   * 'auto' - the default - hit-tests against the drawn width, so what can be hit is exactly what
   * is drawn.
   *
   * A hairline is the case this exists for. A 1-unit line is a correct picture and an almost
   * unhittable target: the pointer has to land inside a ribbon one unit across. Setting this to
   * 24 makes the same line easy to grab without thickening it by one pixel on screen.
   *
   *   hit region  =  the shape stroked at this width instead
   *
   * IN THE SHAPE'S OWN UNITS, like strokeWidth and every other length on a Shape, so it scales
   * with the node and with its groups. A hit ribbon and the line it belongs to keep their ratio
   * at every size, which is what a caller who reaches for this actually wants: the two are set
   * together and read as one thing - a 1-unit line with a 24-unit target - and a band that
   * stayed put while the line grew would break that pairing at the first scale.
   *
   * It substitutes rather than adds, so a value BELOW the drawn width makes the shape harder to
   * hit than it looks. That is the caller's to avoid, and the pairing above is why: whatever
   * moves strokeWidth moves this.
   *
   * It costs a SECOND tessellation, kept apart from the drawn one, because an outline stroked
   * at another width is different triangles. Nothing else is affected: the shape draws,
   * measures, bounds and casts its shadow from the geometry it is drawn with, so the hit ribbon
   * never reaches a group's extent or a transformer's frame.
   */
  private _hitStrokeWidth: number | 'auto' = 'auto'
  get hitStrokeWidth(): number | 'auto' {
    return this._hitStrokeWidth
  }
  set hitStrokeWidth(value: number | 'auto') {
    if (value === this._hitStrokeWidth) return
    const previous = this._hitStrokeWidth
    this._hitStrokeWidth = value
    // The DRAWN geometry is untouched, so this deliberately does not go through
    // markGeometryDirty(): no lane repacks, and the shadow atlas does not re-bake.
    this.pickCache = null
    this.announce('hitStrokeWidth', previous, value)
  }

  // Non-null only while ensurePickCache() is running its own tessellation pass, which is the
  // whole of its lifetime - see strokeWidthForBuild().
  private pickStrokeWidth: number | null = null

  /**
   * The width the stroker is to build with right now: `strokeWidth` for the geometry that is
   * drawn, and `hitStrokeWidth` for the separate pass that builds the pick cache.
   *
   * Subclasses pass THIS to the stroker rather than reading strokeWidth directly, which is what
   * lets one buildGeometry() serve both passes. The public `strokeWidth` always reports the
   * drawn width, whichever pass is running.
   */
  protected strokeWidthForBuild(): number {
    return this.pickStrokeWidth ?? this._strokeWidth
  }

  private geometryCache: CachedGeometry | null = null
  // Derived from geometryCache (same lifetime, invalidated together) - a flat, picking-
  // friendly layout (no MeshSink round-trip) built lazily on the first hitTestLocal() call,
  // not on every tessellate(). Its triangles are the DRAWN ones unless the shape set its own
  // hitStrokeWidth, in which case they come from a pass of their own.
  private pickCache: PickGeometry | null = null
  // The drawn extent, kept apart from the pick cache's box so that a widened hit ribbon cannot
  // reach anything that MEASURES this shape. Invalidated with the geometry it is derived from.
  private boundsCache: AABB | null = null
  // The same, from the fill vertices alone - see localFillBounds.
  private fillBoundsCache: AABB | null = null
  private geometryVersionCounter = 0

  constructor(options: ShapeOptions = {}) {
    super(options)
    // No explicit value means "on top of what exists", which is what a caller who has not
    // thought about stacking almost always wants. An explicit one is taken as given and does
    // NOT advance the counter - see ShapeOptions.zIndex for what that costs.
    this.zIndex = options.zIndex ?? nextZIndex()
    this.overlay = options.overlay ?? false
    this.shadowColor = options.shadowColor ?? [0, 0, 0, 1]
    this.shadowBlur = options.shadowBlur ?? 0
    this.shadowSpread = options.shadowSpread ?? 0
    this.shadowOffsetX = options.shadowOffsetX ?? 0
    this.shadowOffsetY = options.shadowOffsetY ?? 0
    this.shadowOpacity = options.shadowOpacity ?? 1
    this.shadowEnabled = options.shadowEnabled ?? true
    this.shadowForStrokeEnabled = options.shadowForStrokeEnabled ?? true
    this.fill = options.fill ?? null
    this.fillEnabled = options.fillEnabled ?? true
    this.stroke = options.stroke ?? null
    this.strokeEnabled = options.strokeEnabled ?? true
    this.strokeWidth = options.strokeWidth ?? 2
    this.hitStrokeWidth = options.hitStrokeWidth ?? 'auto'
    this.dash = options.dash ?? EMPTY_DASH
    this.dashOffset = options.dashOffset ?? 0
    this.dashEnabled = options.dashEnabled ?? true
    this.strokeAlign = options.strokeAlign ?? 'center'
    this.lineJoin = options.lineJoin ?? 'miter'
    this.lineCap = options.lineCap ?? 'butt'
    this.miterLimit = options.miterLimit ?? 10
    this.strokeScaleEnabled = options.strokeScaleEnabled ?? true
  }

  protected override attrKeys(): readonly string[] {
    return [
      ...super.attrKeys(),
      'overlay',
      'shadowColor',
      'shadowBlur',
      'shadowSpread',
      'shadowOffsetX',
      'shadowOffsetY',
      'shadowOpacity',
      'shadowEnabled',
      'shadowForStrokeEnabled',
      'fill',
      'fillEnabled',
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
      'strokeEnabled',
      'strokeWidth',
      'hitStrokeWidth',
      'dash',
      'dashOffset',
      'dashEnabled',
      'strokeAlign',
      'lineJoin',
      'lineCap',
      'miterLimit',
      'strokeScaleEnabled',
    ]
  }

  protected override attrDefaults(): Readonly<Record<string, unknown>> {
    return shapeAttrDefaults()
  }

  /**
   * Whether this shape casts a shadow at all: enabled, not fully transparent, and at
   * least one shadow field actually set (a shadow with no blur and no offset would sit
   * exactly behind the shape and never be seen).
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
    this.boundsCache = null
    this.fillBoundsCache = null
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

  /**
   * The box this shape can be HIT within, in its own local space - the extent of exactly the
   * triangles hitTestLocal() tests against, which is the hit ribbon on a shape that has one.
   *
   * The counterpart to localBounds(), and the two differ only under hitStrokeWidth. Anything
   * rejecting a point cheaply before running the exact test has to use THIS one: a hairline's
   * DRAWN box is a hairline wide, so a rejection against that would throw away every point the
   * hit ribbon was widened to catch, and the widening would do nothing whatsoever. See
   * scene/picking.ts's hitTestShape, which is where a point actually arrives.
   */
  hitBounds(): AABB {
    return this.ensurePickCache().bounds
  }

  /**
   * This shape's fill+stroke triangles as an axis-aligned box, in its own local space.
   *
   * The DRAWN triangles, always. A shape with its own hitStrokeWidth has a second, differently
   * sized set for hit-testing, and this is deliberately not measured from those: a group's
   * extent, a transformer's frame, a marquee test and the shadow silhouette all read this, and
   * every one of them is about the picture rather than about what is easy to click. Use
   * hitBounds() for the other question - could the pointer be on this.
   */
  localBounds(): AABB {
    if (!this.boundsCache) {
      const box = new AABB()
      for (const v of this.ensureGeometryCache().vertices) box.encapsulate(new Vector3(v.x, v.y, 0))
      this.boundsCache = box
    }
    return this.boundsCache
  }

  /**
   * The extent of the FILL triangles alone, with the outline ignored - what getClientRect
   * reports under `skipStroke`.
   *
   * Free to derive, because the tessellation already says which vertices are which: the sink
   * takes an `isFill` flag per vertex so the batchers can tell a fill from a stroke, and that
   * flag is kept in the cache. No second tessellation is involved.
   */
  localFillBounds(): AABB {
    if (!this.fillBoundsCache) {
      const box = new AABB()
      for (const v of this.ensureGeometryCache().vertices) {
        if (v.isFill) box.encapsulate(new Vector3(v.x, v.y, 0))
      }
      this.fillBoundsCache = box
    }
    return this.fillBoundsCache
  }

  /**
   * How far this shape's own extent reaches once the shadow is counted, in local space - the
   * box unioned with a copy of itself moved by the offset and grown by the blur and spread.
   *
   * The blur is a Gaussian rather than a hard edge, so there is no exact outer limit; one blur
   * radius out is where the canvas model puts the visible end of it, and is what this uses.
   */
  private shadowedBounds(box: AABB): AABB {
    if (!this.hasShadow() || !box.valid()) return box
    const grow = this.shadowBlur + this.shadowSpread
    const union = box.clone()
    union.encapsulate(new Vector3(box.min.x - grow + this.shadowOffsetX, box.min.y - grow + this.shadowOffsetY, 0))
    union.encapsulate(new Vector3(box.max.x + grow + this.shadowOffsetX, box.max.y + grow + this.shadowOffsetY, 0))
    return union
  }

  protected override selfBounds(options: ClientRectOptions): AABB | null {
    const box = options.skipStroke ? this.localFillBounds() : this.localBounds()
    if (!box.valid()) return null
    // shadowForStrokeEnabled decides what the shadow is cast FROM, which is a different question
    // from how far it then reaches - the offset and the blur apply either way.
    return options.skipShadow ? box : this.shadowedBounds(box)
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
    this.boundsCache = null
    this.fillBoundsCache = null
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

  /**
   * The flat xs/ys/tris/bounds layout hit-testing works from.
   *
   * Ordinarily it is the DRAWN tessellation rearranged - the same triangles, laid out for
   * repeated point tests instead of for a MeshSink. A shape given a hitStrokeWidth is the
   * exception: its outline is stroked at that width instead, so buildGeometry() runs a second
   * time with the stroker told the hit width (see strokeWidthForBuild).
   *
   * Its bounds come from that same pass and are used ONLY as the cheap rejection test guarding
   * the exact one - a widened ribbon has to widen the box or the box would clear the very points
   * the widening was for. What the shape MEASURES is localBounds(), which is the drawn geometry
   * and is kept apart from this for exactly that reason.
   */
  private ensurePickCache(): PickGeometry {
    const cached = this.pickCache
    // Same staleness rule as the drawn pass: local-space triangles stay good until an input
    // changes, and only a stroke held at a fixed width is built against the world scale.
    // Checked here rather than in the per-frame sweep that does the same job for the drawn
    // geometry, since a hit test happens on a pointer event rather than on a frame.
    if (cached && (cached.gauge === undefined || sameGauge(cached.gauge, this.worldGauge()))) return cached

    // 'auto', and a width of nothing, is the drawn geometry itself - no second pass.
    const hit = this._hitStrokeWidth
    const padded = hit !== 'auto' && hit > 0
    const geometry = padded ? this.buildPickGeometry(hit) : this.ensureGeometryCache()

    const xs = geometry.vertices.map((v) => v.x)
    const ys = geometry.vertices.map((v) => v.y)
    const tris: number[] = []
    const bounds = new AABB()
    for (const v of geometry.vertices) bounds.encapsulate(new Vector3(v.x, v.y, 0))
    for (const [a, b, c] of geometry.triangles) tris.push(a, b, c)
    this.pickCache = { xs, ys, tris, bounds, gauge: padded ? this.strokeGauge() : undefined }
    return this.pickCache
  }

  /** One tessellation pass with the stroker asked for `width` in place of the drawn one. */
  private buildPickGeometry(width: number): CachedGeometry {
    const vertices: CachedVertex[] = []
    const triangles: CachedTriangle[] = []
    this.pickStrokeWidth = width
    try {
      this.buildGeometry({
        vertex: (x, y, isFill, material = 0) => vertices.push({ x, y, isFill, material }) - 1,
        triangle: (a, b, c) => {
          triangles.push([a, b, c])
        },
      })
    } finally {
      // Restored even if a subclass's buildGeometry() throws, since leaving it set would make
      // every later DRAWN tessellation come out at the hit width.
      this.pickStrokeWidth = null
    }
    return { vertices, triangles, gauge: this.strokeGauge() }
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
    return this.worldGauge()
  }

  /** The linear part of the world matrix, as the stroker's gauge. */
  private worldGauge(): StrokeGauge {
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
   * (see tessellate()). The default emits nothing: MSDFText (rendered through the separate
   * text lane) relies on exactly that; every mesh-drawn shape overrides this instead.
   */
  protected buildGeometry(_sink: MeshSink): void {}
}


/**
 * What each of Shape's own attributes goes back to on reset - Node's, plus the paint. Frozen
 * all the way down, since a default is handed straight to a setter that stores what it is
 * given (see Node.attrDefaults).
 */
let cachedShapeAttrDefaults: Readonly<Record<string, unknown>> | undefined

/**
 * Built on FIRST USE rather than at module load. It spreads a table from another module, and a
 * module-level spread is evaluated in whatever order the bundler happened to link the two - so
 * an import cycle, or a dev server reloading one module without the other, reads the imported
 * name before it exists. Deferring it to the first call puts the read long after every module
 * has finished evaluating.
 */
export function shapeAttrDefaults(): Readonly<Record<string, unknown>> {
  return (cachedShapeAttrDefaults ??= Object.freeze({
    ...NODE_ATTR_DEFAULTS,
    overlay: false,
    shadowColor: Object.freeze([0, 0, 0, 1]),
    shadowBlur: 0,
    shadowSpread: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowOpacity: 1,
    shadowEnabled: true,
    shadowForStrokeEnabled: true,
    fill: null,
    fillEnabled: true,
    fillPriority: 'color',
    fillLinearGradientStartPoint: Object.freeze({ x: 0, y: 0 }),
    fillLinearGradientEndPoint: Object.freeze({ x: 0, y: 0 }),
    fillLinearGradientColorStops: Object.freeze([]),
    fillRadialGradientStartPoint: Object.freeze({ x: 0, y: 0 }),
    fillRadialGradientStartRadius: 0,
    fillRadialGradientEndPoint: Object.freeze({ x: 0, y: 0 }),
    fillRadialGradientEndRadius: 0,
    fillRadialGradientColorStops: Object.freeze([]),
    stroke: null,
    strokeEnabled: true,
    strokeWidth: 2,
    hitStrokeWidth: 'auto',
    dash: EMPTY_DASH,
    dashOffset: 0,
    dashEnabled: true,
    strokeAlign: 'center',
    lineJoin: 'miter',
    lineCap: 'butt',
    miterLimit: 10,
    strokeScaleEnabled: true,
  }))
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
  /**
   * The world scale the HIT ribbon was built against, and undefined when there is no hit ribbon
   * - when the pick layout is the drawn tessellation rearranged, which markGeometryDirty()
   * already invalidates.
   *
   * A hit ribbon is measured after the transform, so unlike everything else derived from
   * buildGeometry() it goes stale when the node is merely SCALED. Keeping the scale here is
   * what lets ensurePickCache() notice.
   */
  gauge: StrokeGauge | undefined
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
