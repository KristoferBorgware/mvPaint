// Image - a textured quad, drawn through the image lane rather than the mesh lane.
//
// It is width x height and carries the usual Shape transform. What it adds is a texture and
// everything about which part of that texture shows: a source rectangle (crop), how that
// rectangle's aspect meets the quad's (fit), tiling, flipping, a wrap mode for what happens
// past the edges, filtering, and a tint that multiplies the sampled colour - whose alpha is
// the image's opacity.
//
// It DOES emit its quad from buildGeometry(), unlike MSDFText, and that one decision is what
// gives it three things for nothing: an exact hit test, correct local bounds for the
// transformer to frame, and a real silhouette for the shadow lane to bake. The renderer
// leaves it out of the mesh DRAW - the image lane paints those pixels - while still handing
// it to the shadow lane as a caster (see webgpu/SceneRenderer).
//
// A consequence worth knowing: the shadow is cast from the QUAD, not from the image's alpha,
// so a cut-out PNG with transparent corners still throws a rectangular shadow. Casting from
// the alpha channel is possible - the bake pass could sample it - but it is its own piece of
// work rather than a flag.
//
// Its TOP-LEFT corner sits at (x, y) and it extends right and down from there, like a Rect -
// see Shape's header for which shapes are cornered and which centred.
//
// Note the name shadows the DOM's `Image` inside any module that imports this one. Load
// through ImageTexture.load() rather than `new Image()` and it will not come up.

import { shapeAttrDefaults, Shape, type ShapeOptions } from './Shape'
import { bumpImageGeometryEpoch } from './contentEpoch'
import { parseColor } from '../render/color'
import type { ColorInput, MeshSink, RGBA } from '../render/meshFormat'
import type { ImageTexture, ImageFilter, ImageWrap } from '../image/ImageTexture'
import { imageUvRect, type ImageCrop, type ImageFit, type ImageUvRect } from '../image/imageUv'

export interface ImageOptions extends ShapeOptions {
  texture: ImageTexture
  /** Source rectangle in texture pixels. Defaults to the whole image. */
  crop?: ImageCrop
  /** How the source aspect meets the quad's. Default 'fill'. */
  fit?: ImageFit
  /** Repeats across the quad; needs a repeating wrap to show more than the first. Default 1. */
  tileX?: number
  tileY?: number
  flipX?: boolean
  flipY?: boolean
  /** What happens past the edges of the source. Default 'clamp'. */
  wrapX?: ImageWrap
  wrapY?: ImageWrap
  /** 'nearest' keeps pixel art crisp. Default 'linear'. */
  filter?: ImageFilter
  /** Multiplied into every sampled texel; its alpha is the opacity. Default opaque white. */
  tint?: ColorInput
}


/**
 * See Node.attrDefaults. `texture` is absent on purpose: an Image without one has nothing to
 * draw, and there is no blank picture to stand in for the missing one, so it cannot be reset.
 */
let cachedImageAttrDefaults: Readonly<Record<string, unknown>> | undefined

/**
 * Built on FIRST USE rather than at module load. It spreads a table from another module, and a
 * module-level spread is evaluated in whatever order the bundler happened to link the two - so
 * an import cycle, or a dev server reloading one module without the other, reads the imported
 * name before it exists. Deferring it to the first call puts the read long after every module
 * has finished evaluating.
 */
function imageAttrDefaults(): Readonly<Record<string, unknown>> {
  return (cachedImageAttrDefaults ??= Object.freeze({
    ...shapeAttrDefaults(),
    crop: undefined,
    fit: 'fill',
    tileX: 1,
    tileY: 1,
    flipX: false,
    flipY: false,
    wrapX: 'clamp',
    wrapY: 'clamp',
    filter: 'linear',
    tint: Object.freeze([1, 1, 1, 1]),
  }))
}

export class Image extends Shape {
  override readonly nodeName: string = 'Image'

  // WHAT ANNOUNCES ITSELF, and to which lane. Everything below is packed into the image lane's
  // shared buffer rather than read per frame, so each is an accessor that bumps the image
  // content epoch when the value actually changes (see contentEpoch.ts). `tint` is the
  // exception in the other direction - the batcher re-reads it every frame alongside the
  // transform and the depth - so it needs no announcement and is free to animate.
  //
  // Editing a crop rectangle in place is invisible from here, like every other object handed
  // over: assign a new one.

  private _texture: ImageTexture
  /** The picture drawn on the quad. This node does not own it - see Node.destroy. */
  get texture(): ImageTexture {
    return this._texture
  }
  set texture(value: ImageTexture) {
    if (value === this._texture) return
    const previous = this._texture
    this._texture = value
    bumpImageGeometryEpoch()
    this.announce('texture', previous, value)
  }

  private _crop?: ImageCrop
  /** Source rectangle in texture pixels; undefined is the whole image. */
  get crop(): ImageCrop | undefined {
    return this._crop
  }
  set crop(value: ImageCrop | undefined) {
    if (value === this._crop) return
    const previous = this._crop
    this._crop = value
    bumpImageGeometryEpoch()
    this.announce('crop', previous, value)
  }

  private _fit: ImageFit = 'fill'
  /** How the source aspect meets the quad's. */
  get fit(): ImageFit {
    return this._fit
  }
  set fit(value: ImageFit) {
    if (value === this._fit) return
    const previous = this._fit
    this._fit = value
    bumpImageGeometryEpoch()
    this.announce('fit', previous, value)
  }

  private _tileX = 1
  /** Repeats across the quad; needs a repeating wrap to show more than the first. */
  get tileX(): number {
    return this._tileX
  }
  set tileX(value: number) {
    if (value === this._tileX) return
    const previous = this._tileX
    this._tileX = value
    bumpImageGeometryEpoch()
    this.announce('tileX', previous, value)
  }

  private _tileY = 1
  get tileY(): number {
    return this._tileY
  }
  set tileY(value: number) {
    if (value === this._tileY) return
    const previous = this._tileY
    this._tileY = value
    bumpImageGeometryEpoch()
    this.announce('tileY', previous, value)
  }

  private _flipX = false
  get flipX(): boolean {
    return this._flipX
  }
  set flipX(value: boolean) {
    if (value === this._flipX) return
    const previous = this._flipX
    this._flipX = value
    bumpImageGeometryEpoch()
    this.announce('flipX', previous, value)
  }

  private _flipY = false
  get flipY(): boolean {
    return this._flipY
  }
  set flipY(value: boolean) {
    if (value === this._flipY) return
    const previous = this._flipY
    this._flipY = value
    bumpImageGeometryEpoch()
    this.announce('flipY', previous, value)
  }

  private _wrapX: ImageWrap = 'clamp'
  /** What happens past the edges of the source. Also decides which draw range this quad joins. */
  get wrapX(): ImageWrap {
    return this._wrapX
  }
  set wrapX(value: ImageWrap) {
    if (value === this._wrapX) return
    const previous = this._wrapX
    this._wrapX = value
    bumpImageGeometryEpoch()
    this.announce('wrapX', previous, value)
  }

  private _wrapY: ImageWrap = 'clamp'
  get wrapY(): ImageWrap {
    return this._wrapY
  }
  set wrapY(value: ImageWrap) {
    if (value === this._wrapY) return
    const previous = this._wrapY
    this._wrapY = value
    bumpImageGeometryEpoch()
    this.announce('wrapY', previous, value)
  }

  private _filter: ImageFilter = 'linear'
  /** 'nearest' keeps pixel art crisp. Also decides which draw range this quad joins. */
  get filter(): ImageFilter {
    return this._filter
  }
  set filter(value: ImageFilter) {
    if (value === this._filter) return
    const previous = this._filter
    this._filter = value
    bumpImageGeometryEpoch()
    this.announce('filter', previous, value)
  }

  private tintValue: RGBA = [1, 1, 1, 1]
  private tintWritten: ColorInput = [1, 1, 1, 1]
  /**
   * Multiplied into every sampled texel. Accepts a string as well as the tuple - see Shape.fill.
   *
   * Refreshed per frame with the transform and the depth, so it announces nothing and animating
   * it repacks no buffer.
   */
  get tint(): RGBA {
    return this.tintValue
  }
  set tint(value: ColorInput) {
    if (value === this.tintWritten) return
    const previous = this.tintValue
    this.tintValue = parseColor(value)
    this.tintWritten = value
    this.announce('tint', previous, this.tintValue)
  }
  /** What tint was last assigned, in the form it was written. See Shape.fillInput. */
  get tintInput(): ColorInput {
    return this.tintWritten
  }

  constructor(options: ImageOptions) {
    super({
      ...options,
      // An image with no size given is its texture's own size, which is nearly always what
      // was meant and saves repeating the dimensions at every call site.
      width: options.width ?? options.texture.width,
      height: options.height ?? options.texture.height,
    })
    // Assigned directly rather than through the accessors, because the field initialisers above
    // have just run: `_texture` has no default worth having, and every other accessor would
    // guard against the default it was just given and announce nothing. The explicit bump at the
    // end covers the whole set at once.
    this._texture = options.texture
    this._crop = options.crop
    this._fit = options.fit ?? 'fill'
    this._tileX = options.tileX ?? 1
    this._tileY = options.tileY ?? 1
    this._flipX = options.flipX ?? false
    this._flipY = options.flipY ?? false
    this._wrapX = options.wrapX ?? 'clamp'
    this._wrapY = options.wrapY ?? 'clamp'
    this._filter = options.filter ?? 'linear'
    this.tint = options.tint ?? [1, 1, 1, 1]
    bumpImageGeometryEpoch()
  }

  // Size is BOTH lanes. The silhouette that bounds, picking and the shadow bake read is
  // tessellated here, and the pixels are laid over exactly the same rectangle by the image
  // batcher from a buffer it packs itself - so a resize invalidates one of each.
  override get width(): number {
    return super.width
  }
  override set width(value: number) {
    if (value === super.width) return
    super.width = value
    this.markGeometryDirty()
    bumpImageGeometryEpoch()
  }
  override get height(): number {
    return super.height
  }
  override set height(value: number) {
    if (value === super.height) return
    super.height = value
    this.markGeometryDirty()
    bumpImageGeometryEpoch()
  }

  protected override attrKeys(): readonly string[] {
    return [
      ...super.attrKeys(),
      'texture',
      'crop',
      'fit',
      'tileX',
      'tileY',
      'flipX',
      'flipY',
      'wrapX',
      'wrapY',
      'filter',
      'tint',
    ]
  }

  protected override attrDefaults(): Readonly<Record<string, unknown>> {
    return imageAttrDefaults()
  }

  /** The corner texture coordinates this quad samples, from everything set above. */
  uvRect(): ImageUvRect {
    return imageUvRect({
      textureWidth: this.texture.width,
      textureHeight: this.texture.height,
      quadWidth: this.width,
      quadHeight: this.height,
      crop: this.crop,
      fit: this.fit,
      tileX: this.tileX,
      tileY: this.tileY,
      flipX: this.flipX,
      flipY: this.flipY,
    })
  }

  /**
   * The quad, in local space, matching Rect's. The mesh lane does not draw this - the image
   * lane paints the same rectangle with the texture on it - but emitting it is what gives
   * picking, bounds and the shadow silhouette something real to work from. See the header.
   */
  protected override buildGeometry(sink: MeshSink): void {
    // The origin is the picture's top-left corner and the scene is y-down, so the quad hangs
    // below it. ImageBatcher lays the drawn quad out over exactly this rectangle - the two
    // have to agree, or the pixels and the hit test would describe different places.
    const w = this.width
    const b = this.height
    const p0 = sink.vertex(0, b, true)
    const p1 = sink.vertex(w, b, true)
    const p2 = sink.vertex(w, 0, true)
    const p3 = sink.vertex(0, 0, true)
    sink.triangle(p0, p1, p2)
    sink.triangle(p0, p2, p3)
  }
}
