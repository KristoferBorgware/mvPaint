// Pure sizing math for the shadow atlas (see ShadowAtlas.ts), split out so it can be
// self-tested without a GPU.
//
// The whole point of these numbers is that they depend ONLY on things a transform cannot
// change: the shape's own local-space bounds, its shadowBlur and its shadowSpread. A
// shadow's offset, the shape's position/rotation/scale, and the camera zoom are all
// applied later, to the textured quad that samples the atlas - so moving, spinning,
// scaling or zooming a shadowed shape never invalidates its cached texture.
//
// Blur follows the canvas 2D shadow model: shadowBlur maps to a Gaussian standard
// deviation of blur/2, and a Gaussian is numerically dead beyond ~3 sigma, so the
// silhouette is padded by 3 sigma on every side to leave room for the blur to spread into.
// A positive shadowSpread grows the silhouette before that blur, so it needs its own room
// on top; a negative one only ever shrinks it, so it needs none.

/** Canvas 2D's shadowBlur -> Gaussian sigma: "half the value of shadowBlur". */
export function shadowSigma(blur: number): number {
  return Math.max(0, blur) / 2
}

/**
 * How far the blur visibly reaches past the silhouette, in the same units as `blur`.
 * Three sigma covers 99.7% of a Gaussian; past that the contribution is below one 8-bit
 * level and padding further would just waste atlas space.
 */
export function blurMarginUnits(blur: number): number {
  return 3 * shadowSigma(blur)
}

/**
 * Total room to leave around the silhouette: the blur's reach plus however far a positive
 * spread pushes the edge outward first. A negative spread erodes the silhouette inward and
 * so never needs extra room - clamping it at 0 here is what keeps the slot from growing for
 * an inset shadow.
 */
export function shadowMarginUnits(blur: number, spread: number): number {
  return blurMarginUnits(blur) + Math.max(0, spread)
}

/** A shadow's slot in the atlas, in texels, plus the local-space mapping to reach it. */
export interface ShadowRegion {
  /** Atlas texels per unit of the shape's LOCAL space (<= 1; shrinks for large shapes). */
  texelsPerUnit: number
  /** Margin on every side (blur reach plus any outward spread), in texels. */
  padTexels: number
  width: number
  height: number
}

/**
 * Sizes the atlas slot for a silhouette of `boundsW` x `boundsH` local units grown by
 * `spread` and blurred by `blur`, capped at `maxRegion` texels on a side.
 *
 * Resolution is 1 texel per local unit until the padded silhouette would exceed the cap,
 * at which point it scales down to fit - so a small shape keeps full detail and a huge one
 * degrades gracefully into a soft blob rather than blowing out the atlas. Solving
 * `tpu * (inner + 2*margin) <= maxRegion` for tpu is what makes the padding fit inside the
 * cap too, instead of being added on top of an already-maxed-out silhouette.
 */
export function shadowRegion(
  boundsW: number,
  boundsH: number,
  blur: number,
  spread: number,
  maxRegion: number,
): ShadowRegion {
  const w = Math.max(0, boundsW)
  const h = Math.max(0, boundsH)
  const inner = Math.max(w, h)
  const margin = shadowMarginUnits(blur, spread)
  const total = inner + 2 * margin

  let texelsPerUnit = total > 0 ? Math.min(1, maxRegion / total) : 1
  const measure = (tpu: number) => {
    const padTexels = Math.ceil(margin * tpu)
    return {
      texelsPerUnit: tpu,
      padTexels,
      width: Math.max(1, Math.ceil(w * tpu) + 2 * padTexels),
      height: Math.max(1, Math.ceil(h * tpu) + 2 * padTexels),
    }
  }

  // Rounding the silhouette and the margin up separately can push the slot a texel or two
  // past the cap. Simply clipping there would crop the far edge of the blur - and, in the
  // worst case, the silhouette itself - so the resolution is nudged down until it genuinely
  // fits instead, which keeps the margin symmetric and the shape whole. Shrinking strictly
  // reduces both dimensions, so this converges immediately in practice.
  let region = measure(texelsPerUnit)
  for (let i = 0; i < 8 && (region.width > maxRegion || region.height > maxRegion); i++) {
    const overshoot = Math.max(region.width / maxRegion, region.height / maxRegion)
    texelsPerUnit = texelsPerUnit / overshoot - 1e-6
    region = measure(texelsPerUnit)
  }
  return region
}

/**
 * Atlas allocations are rounded up to this many texels on each side. Slot sizes wobble by a
 * texel or two near the cap - `shadowRegion` rounds the silhouette and the margin up
 * separately and then shrinks the whole thing to fit, so a SMALLER blur can occasionally ask
 * for a slightly WIDER region. Reserving on a coarse grid absorbs that, which is what makes
 * slot reuse predictable: see slotBucket.
 */
export const SLOT_GRANULARITY = 32

/**
 * The rectangle actually reserved for a region `size` texels wide (or tall): rounded up to
 * SLOT_GRANULARITY, and never past `maxRegion`, which every region is already capped to.
 *
 * Reserving coarsely and then re-baking into a sub-rectangle of the reservation is what
 * gives the atlas a property worth relying on: a shape's allocation only ever grows, so a
 * parameter swept back and forth settles after a handful of reallocations instead of
 * abandoning a rectangle on every step. The uv rect is still sized from the exact region,
 * so the slack is simply never sampled.
 */
export function slotBucket(size: number, maxRegion: number): number {
  const bucket = Math.ceil(Math.max(1, size) / SLOT_GRANULARITY) * SLOT_GRANULARITY
  return Math.min(maxRegion, Math.max(bucket, size))
}

/**
 * The local-space rectangle the atlas slot covers: the shape's bounds grown by the blur
 * margin. This is the quad the shadow is drawn on, so it must match the region exactly or
 * the texture would be stretched.
 */
export function shadowQuadBounds(
  minX: number,
  minY: number,
  region: ShadowRegion,
): { x0: number; y0: number; x1: number; y1: number } {
  const pad = region.padTexels / region.texelsPerUnit
  return {
    x0: minX - pad,
    y0: minY - pad,
    x1: minX - pad + region.width / region.texelsPerUnit,
    y1: minY - pad + region.height / region.texelsPerUnit,
  }
}

/**
 * The canvas 2D shadow offset semantics: the offset scales with the node's absolute scale
 * but is NOT turned by its rotation (a canvas shadow's offset is applied in device space,
 * outside the current transform). `offsetY` is downward-positive, so it flips against this
 * scene's y-up axis.
 *
 * `scaleX`/`scaleY` are the world matrix's axis lengths - see worldAxisScale.
 */
export function shadowWorldOffset(
  offsetX: number,
  offsetY: number,
  scaleX: number,
  scaleY: number,
): { x: number; y: number } {
  return { x: offsetX * scaleX, y: -offsetY * scaleY }
}

/**
 * The absolute scale a world matrix applies, as the lengths of its two axis columns. This
 * is the factor the shadow offset is multiplied by. `m` is column-major (the layout
 * Matrix4x4.toGPU produces).
 *
 * Blur needs no such factor here. Blurring in device space would mean scaling the blur
 * radius the same way, but baking the blur into a LOCAL-space texture gets the same result
 * for free - the quad carries the world transform, so the baked blur is magnified by
 * exactly the shape's own scale.
 */
export function worldAxisScale(m: ArrayLike<number>): { x: number; y: number } {
  return {
    x: Math.hypot(m[0], m[1]),
    y: Math.hypot(m[4], m[5]),
  }
}
