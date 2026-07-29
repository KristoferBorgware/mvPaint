// Image - a textured quad, drawn through the image lane rather than the mesh lane.
//
// It is width x height and centred at (x, y) like Rect, and carries the usual Shape
// transform. What it adds is a texture and everything about which part of that texture
// shows: a source rectangle (crop), how that rectangle's aspect meets the quad's (fit),
// tiling, flipping, a wrap mode for what happens past the edges, filtering, and a tint that
// multiplies the sampled colour - whose alpha is the image's opacity.
//
// It DOES emit its quad from buildGeometry(), unlike Text, and that one decision is what
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
// Note the name shadows the DOM's `Image` inside any module that imports this one. Load
// through ImageTexture.load() rather than `new Image()` and it will not come up.

import { Shape, type ShapeOptions } from './Shape'
import type { MeshSink, RGBA } from '../render/meshFormat'
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
  tint?: RGBA
}

export class Image extends Shape {
  override readonly nodeName: string = 'Image'

  texture: ImageTexture
  crop?: ImageCrop
  fit: ImageFit
  tileX: number
  tileY: number
  flipX: boolean
  flipY: boolean
  wrapX: ImageWrap
  wrapY: ImageWrap
  filter: ImageFilter
  tint: RGBA

  constructor(options: ImageOptions) {
    super({
      ...options,
      // An image with no size given is its texture's own size, which is nearly always what
      // was meant and saves repeating the dimensions at every call site.
      width: options.width ?? options.texture.width,
      height: options.height ?? options.texture.height,
    })
    this.texture = options.texture
    this.crop = options.crop
    this.fit = options.fit ?? 'fill'
    this.tileX = options.tileX ?? 1
    this.tileY = options.tileY ?? 1
    this.flipX = options.flipX ?? false
    this.flipY = options.flipY ?? false
    this.wrapX = options.wrapX ?? 'clamp'
    this.wrapY = options.wrapY ?? 'clamp'
    this.filter = options.filter ?? 'linear'
    this.tint = options.tint ?? [1, 1, 1, 1]
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
    const hw = this.width / 2
    const hh = this.height / 2
    const a = sink.vertex(-hw, -hh, true)
    const b = sink.vertex(hw, -hh, true)
    const c = sink.vertex(hw, hh, true)
    const d = sink.vertex(-hw, hh, true)
    sink.triangle(a, b, c)
    sink.triangle(a, c, d)
  }
}
