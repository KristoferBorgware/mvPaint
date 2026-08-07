// Which objects can be drawn in the opaque pass, and which have to wait for the
// translucent one (see render/drawOrder.ts and webgpu/SceneRenderer's draw()).
//
// The test is one-sided on purpose. "Opaque" here is a promise that EVERY fragment the
// object can produce comes out at alpha 1, because that is what earns it the right to
// write depth ahead of everything behind it. Anything the CPU cannot prove from the
// object's own fields is therefore translucent - a wrong "translucent" only costs a draw
// call, a wrong "opaque" punches a hole in the picture.
//
// Two whole lanes fail that test by construction and are never asked:
//
//   - TEXT. An MSDF glyph's alpha IS its coverage: the fragment shader turns the sampled
//     distance into a soft edge, so every glyph outline is a ring of partial-alpha
//     fragments however solid the run's colour is. (Mesh shapes get their edges from MSAA
//     instead, which resolves per SAMPLE - a covered sample is fully covered - so a solid
//     mesh fill really is opaque everywhere it draws.)
//   - IMAGES. What is in a texture is the application's business and is never read back,
//     so nothing here can rule out an alpha channel. A tint alpha below 1 proves an image
//     translucent; a tint alpha of 1 proves nothing. The cheap fix, if an image-heavy
//     scene ever wants the opaque pass, is for the caller to declare it when building the
//     ImageTexture - it is the one party that knows.
//
// So this covers the mesh lane, which is the one that can answer.
//
// Shape.opacity is checked for every lane that gets here, ahead of any material: it scales
// the alpha of every fragment the object produces, so it can only ever move a shape OUT of
// the opaque pass, never into it.

import type { Shape } from '../shapes/Shape'
import type { MeshMaterial } from './meshFormat'

/**
 * Whether every fragment this material paints is fully opaque: a flat fill at alpha 1, or
 * a gradient whose every stop is - plus an opaque stroke colour.
 *
 * The stroke is checked whether or not the shape actually strokes anything, since a
 * material carries no stroke WIDTH (see MeshMaterial) and the fallback has to be the safe
 * one. A shape with no stroke COLOUR emits no stroke fragments at all, so it is passed
 * over rather than counted against.
 */
export function isOpaqueMaterial(material: MeshMaterial): boolean {
  if (material.stroke !== null && material.stroke[3] < 1) return false
  // Nothing to fill with means every fill fragment comes out transparent, which is the one
  // thing an opaque object may not do - see FillPriority's 'none'.
  if (material.fillPriority === 'none') return false
  if (material.fillPriority === 'color') return material.fill !== null && material.fill[3] >= 1

  const stops =
    material.fillPriority === 'linear-gradient'
      ? material.fillLinearGradientColorStops
      : material.fillRadialGradientColorStops
  // A gradient with no stops resolves to transparent black in the shader, not to the flat
  // fill colour - see mesh.wgsl.ts's sampleGradient.
  if (stops.length === 0) return false
  for (let i = 0; i < stops.length; i++) {
    if (stops[i].color[3] < 1) return false
  }
  return true
}

/**
 * Whether a mesh-lane shape paints only opaque fragments. A shape whose parts are styled
 * independently (VectorText's runs) has to satisfy this for all of them - the object is
 * drawn as one unit, so one translucent run makes the whole thing translucent.
 */
export function isOpaqueShape(shape: Shape): boolean {
  // The object's own transparency multiplies every fragment it paints, so anything below 1
  // disqualifies the shape however solid its colours are. This check has to come FIRST and
  // has to exist: an opacity the classifier could not see is the exact shape of the bug the
  // header warns about - a wrong "opaque" writes depth ahead of everything behind it and
  // punches a hole in the picture.
  if (shape.opacity < 1) return false
  const materials = shape.materials()
  // Shape carries the whole fill/stroke vocabulary itself, which is what the batcher falls
  // back to when a shape declares no materials at all.
  if (materials.length === 0) return isOpaqueMaterial(shape)
  // Indexed rather than for-of throughout: this runs once per visible shape per gather, and
  // at a hundred thousand of them an iterator allocation per shape is measurable.
  for (let i = 0; i < materials.length; i++) {
    if (!isOpaqueMaterial(materials[i])) return false
  }
  return true
}

/** A list split into an opaque head and a translucent tail, with the depths kept in step. */
export interface OpacityPartition {
  shapes: readonly Shape[]
  depths: readonly number[]
  /** Index of the first translucent shape - equivalently, how many opaque ones there are. */
  translucentStart: number
}

/**
 * Stably partitions a lane's shapes (and their depths, index-aligned) into the opaque ones
 * followed by the translucent ones. Stable matters on both sides for different reasons: the
 * translucent tail must stay in back-to-front order because that is the only order alpha
 * blending composites correctly in, and keeping the opaque head in the same order too means
 * a scene that never mixes the two is handed straight back untouched - no reordering, no
 * allocation, and no rebuild triggered by a list that only looks different.
 */
export function partitionByOpacity(shapes: readonly Shape[], depths: readonly number[]): OpacityPartition {
  let opaqueCount = 0
  let seenTranslucent = false
  let alreadyPartitioned = true
  for (let i = 0; i < shapes.length; i++) {
    if (isOpaqueShape(shapes[i])) {
      opaqueCount++
      if (seenTranslucent) alreadyPartitioned = false
    } else {
      seenTranslucent = true
    }
  }
  if (alreadyPartitioned) return { shapes, depths, translucentStart: opaqueCount }

  // Only a genuinely mixed, out-of-order lane pays for the second classification pass and
  // the two arrays.
  const ordered: Shape[] = new Array(shapes.length)
  const orderedDepths: number[] = new Array(shapes.length)
  let head = 0
  let tail = opaqueCount
  for (let i = 0; i < shapes.length; i++) {
    const slot = isOpaqueShape(shapes[i]) ? head++ : tail++
    ordered[slot] = shapes[i]
    orderedDepths[slot] = depths[i]
  }
  return { shapes: ordered, depths: orderedDepths, translucentStart: opaqueCount }
}
