// Where an image's four corner texture coordinates come from.
//
// Everything an Image node can say about which part of the picture shows, and how it is laid
// across the quad, collapses into two UV corners here - so the shader samples and does
// nothing else, and none of this costs a uniform, a branch or a second draw.
//
// The pieces compose in this order:
//
//   crop   picks a rectangle of the source, in pixels. A sprite out of a sheet.
//   fit    decides how that rectangle's aspect relates to the quad's:
//            'fill'  stretches it to the quad, distorting if the aspects differ.
//            'cover' keeps the aspect and trims the overflowing axis - the sensible
//                    default for a photograph in a frame that is not its shape.
//          'contain' is deliberately absent: fitting INSIDE the quad leaves a margin with
//          no image in it, which needs either a smaller quad or a discard in the shader,
//          not a UV range. Worth adding, but as its own thing rather than pretended here.
//   tile   repeats the result across the quad. Needs a wrap of 'repeat' or 'mirror' to
//          show anything beyond the first tile - with 'clamp' the edge texel smears.
//   flip   mirrors the coordinates on either axis, last, so it flips what you actually see.
//
// Pure arithmetic, no GPU, no DOM.

/** A rectangle of the source image, in pixels, with (0,0) at its top-left. */
export interface ImageCrop {
  x: number
  y: number
  width: number
  height: number
}

/** How the source rectangle's aspect is reconciled with the quad's. See the header. */
export type ImageFit = 'fill' | 'cover'

export interface ImageUvOptions {
  /** Source pixel dimensions - what `crop` is measured against. */
  textureWidth: number
  textureHeight: number
  /** The quad's own size, which decides what 'cover' has to trim. */
  quadWidth: number
  quadHeight: number
  crop?: ImageCrop
  fit?: ImageFit
  tileX?: number
  tileY?: number
  flipX?: boolean
  flipY?: boolean
}

/** The two opposite corners of the texture-coordinate rectangle a quad samples. */
export interface ImageUvRect {
  u0: number
  v0: number
  u1: number
  v1: number
}

/**
 * The UV rectangle for one image quad. u/v run 0..1 across the whole source; a tiled result
 * runs past 1, which is what the sampler's wrap mode then resolves.
 */
export function imageUvRect(options: ImageUvOptions): ImageUvRect {
  const { textureWidth: tw, textureHeight: th, quadWidth, quadHeight } = options

  // A source with no area has no meaningful coordinates; hand back the whole unit square
  // rather than dividing by zero and producing NaNs that would poison the vertex buffer.
  if (tw <= 0 || th <= 0) return { u0: 0, v0: 0, u1: 1, v1: 1 }

  const crop = options.crop ?? { x: 0, y: 0, width: tw, height: th }
  let u0 = crop.x / tw
  let v0 = crop.y / th
  let u1 = (crop.x + crop.width) / tw
  let v1 = (crop.y + crop.height) / th

  if ((options.fit ?? 'fill') === 'cover' && crop.width > 0 && crop.height > 0 && quadWidth > 0 && quadHeight > 0) {
    // Trim whichever axis has more image than the quad's shape can use, about the centre,
    // so the visible part stays the middle of the picture rather than a corner of it.
    const sourceAspect = crop.width / crop.height
    const quadAspect = quadWidth / quadHeight
    if (sourceAspect > quadAspect) {
      const keep = quadAspect / sourceAspect
      const trim = ((u1 - u0) * (1 - keep)) / 2
      u0 += trim
      u1 -= trim
    } else if (sourceAspect < quadAspect) {
      const keep = sourceAspect / quadAspect
      const trim = ((v1 - v0) * (1 - keep)) / 2
      v0 += trim
      v1 -= trim
    }
  }

  // Tiling scales the span outward from its start, so the first tile stays put and the
  // repeats run off the far edge.
  const tileX = options.tileX ?? 1
  const tileY = options.tileY ?? 1
  if (tileX !== 1) u1 = u0 + (u1 - u0) * tileX
  if (tileY !== 1) v1 = v0 + (v1 - v0) * tileY

  // Last, so it mirrors the final result rather than some intermediate of it.
  if (options.flipX) [u0, u1] = [u1, u0]
  if (options.flipY) [v0, v1] = [v1, v0]

  return { u0, v0, u1, v1 }
}
