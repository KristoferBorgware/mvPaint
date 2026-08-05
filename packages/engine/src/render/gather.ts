// The GATHER: everything a frame decides before it draws anything.
//
// Walk the tree, rank every shape by zIndex into a depth, bucket the ranked list into lanes,
// cull what the camera cannot see, split the mesh lane into [opaque | translucent | overlay],
// and merge the translucent halves of all four lanes into one furthest-first run list. What
// comes out is a description of the frame in terms of shapes and half-open ranges - and
// nothing else. There is no GPU type anywhere in this file, and there should not be: none of
// this is a rendering decision. It is the same answer whichever API ends up submitting it,
// which is exactly why it lives here rather than inside a renderer.
//
// It used to live inside webgpu/SceneRenderer.draw(). Moving it out changed no logic, no
// ordering and no caching; what it changed is that a second render path can share the
// subtlest code in the engine instead of growing a copy of it that drifts apart every time
// culling or the opacity split learns something new.
//
// THE FAST PATH is the reason this is a class rather than a function. When culling and the
// zIndex sort are both off, nothing here can change the visible SET on its own: no
// camera-dependent membership, no zIndex-driven reordering, and structural changes always
// arrive with an explicit dirty mark. In that state the whole gather reproduces
// byte-identical output every frame it isn't given a reason to change - which is most of
// them for a static scene - so last frame's arrays are handed straight back. That is how a
// 100k-shape scene avoids re-traversing itself sixty times a second, and it only works if
// something owns the previous answer. This does.

import type { AABB } from '../math/AABB'
import type { Camera2D } from '../camera/Camera2D'
import type { Scene } from '../scene/Scene'
import { Image } from '../shapes/Image'
import { Shape } from '../shapes/Shape'
import { MSDFText } from '../shapes/MSDFText'
import type { FontFamilies } from '../text/layout'
import { collectZOrder, depthForRank } from '../scene/picking'
import { isShapeOnScreen, isTextOnScreen } from '../scene/culling'
import { partitionByOpacity } from './opacity'
import { buildDrawRuns, type DrawRun } from './drawOrder'

/** One frame's worth of "what is drawn, in what order, at what depth". */
export interface GatherResult {
  /** Every shape in the scene, zIndex-ranked - not culled. Depth ranks are scene-wide. */
  ordered: readonly Shape[]
  depths: ReadonlyMap<Shape, number>
  /** The mesh-lane candidates after culling, before the overlay/opacity splits. */
  meshShapes: readonly Shape[]
  texts: readonly MSDFText[]
  textDepths: readonly number[]
  images: readonly Image[]
  imageDepths: readonly number[]
  /** The mesh lane's packed order: `[ opaque | translucent | overlay ]`. */
  visibleMeshShapes: readonly Shape[]
  visibleMeshDepths: readonly number[]
  meshTranslucentStart: number
  overlayStart: number
  /** The translucent pass's furthest-first run list, across every lane. */
  runs: readonly DrawRun[]
}

/** Everything the gather reads. All of it is scene or camera state - none of it is a resource. */
export interface GatherInput {
  scene: Scene
  camera: Camera2D
  /** Needed to measure MSDFText for culling - metrics only, no atlas (see MSDFText.shaped). */
  fonts: FontFamilies
  /** The canvas's LOGICAL size: the camera is sized in CSS pixels, not backing-store ones. */
  viewWidth: number
  viewHeight: number
  cullingEnabled: boolean
  zSortEnabled: boolean
  cullMargin: number
}

export class SceneGather {
  private cached: GatherResult | null = null
  // The last frame's (margin-expanded) cull rectangle, for a debug overlay. Null before the
  // first gather, and whenever culling is off - there is no rectangle to show then.
  private lastCullBounds: AABB | null = null

  /** True when there is a previous answer to hand back - see `run`'s `reuse`. */
  hasCache(): boolean {
    return this.cached !== null
  }

  /**
   * Drop the cached answer. Toggling culling or the zIndex sort must call this: a stale
   * cache would otherwise serve a set built under the OLD setting, whether or not the caller
   * also happens to mark something dirty.
   */
  invalidate(): void {
    this.cached = null
  }

  /** The last frame's (margin-expanded) cull rectangle, world space, or null. */
  getCullBounds(): AABB | null {
    return this.lastCullBounds
  }

  /**
   * Gather one frame. `reuse` is the caller's half of the fast-path decision - it owns the
   * dirty flags and content epochs that also have a say - and is only honoured when there is
   * actually a cached answer to reuse.
   */
  run(input: GatherInput, reuse: boolean): GatherResult {
    if (reuse && this.cached) {
      // Even here, because this is not about the visible SET. A shape whose stroke was told
      // not to follow its scale has geometry that depends on that scale, and the reuse path
      // is exactly the state in which nothing else would ever look again. What it finds costs
      // a frame here rather than none - the renderer has already decided to reuse by the time
      // this runs, so the rebuild it asks for lands on the next one - and it is the only
      // configuration where that is true.
      refreshStrokeGauges(this.cached.ordered)
      return this.cached
    }

    const { scene, camera, fonts, viewWidth, viewHeight } = input

    // One combined traversal + zIndex sort drives BOTH lanes' depth, so a mesh shape and a
    // MSDFText can interleave correctly under the depth test regardless of which lane's draw call
    // runs first (see scene/picking.ts). Depth ranks are scene-wide (based on EVERY shape),
    // not affected by culling below.
    const ordered = collectZOrder(scene, input.zSortEnabled)
    // Before anything reads geometry: a stroke built not to follow its shape's scale is stale
    // the moment that scale moves, and this is the one loop that sees every shape every frame.
    // It marks them dirty, which the renderer's rebuild check - made after this returns -
    // picks up in the same frame. See Shape.refreshStrokeGauge for why it has to be a sweep.
    refreshStrokeGauges(ordered)
    const depths = new Map<Shape, number>()
    // MSDFText is the only Shape kind that doesn't tessellate for the mesh lane (its tessellate()
    // is the inherited no-op) - everything else belongs to the mesh batcher, VectorText very
    // much included: it is text drawn AS mesh geometry, so it wants the mesh lane, not this
    // filter's other side. One pass buckets both instead of filtering `ordered` twice - same
    // result, half the iteration. meshDepths is built alongside meshShapes, parallel by
    // position - see MeshBatcher.updateObjects for why that's worth doing instead of a
    // shape-keyed Map lookup per object.
    const texts: MSDFText[] = []
    const images: Image[] = []
    const meshShapes: Shape[] = []
    const meshDepths: number[] = []
    for (let rank = 0; rank < ordered.length; rank++) {
      const shape = ordered[rank]
      const depth = depthForRank(rank, ordered.length)
      depths.set(shape, depth)
      // An Image has mesh geometry - that is what its shadow and its hit test are made of -
      // but the image lane paints those pixels, so it is bucketed out of the mesh draw here
      // rather than excluded from having geometry at all.
      if (shape instanceof MSDFText) texts.push(shape)
      else if (shape instanceof Image) images.push(shape)
      else {
        meshShapes.push(shape)
        meshDepths.push(depth)
      }
    }

    // Viewport cull: skip anything whose bounds don't overlap the camera's current view
    // rectangle (see scene/culling.ts). Switching cullingEnabled off skips the per-object test
    // itself, not just its effect. Depths are filtered in step with their shapes via an
    // explicit loop (not .filter(), which can't keep a second array in sync) whenever culling
    // can actually drop something.
    const viewBounds = input.cullingEnabled
      ? camera.viewBounds(viewWidth, viewHeight).expanded(input.cullMargin)
      : null
    this.lastCullBounds = viewBounds
    let onScreen: Shape[]
    let onScreenDepths: number[]
    if (viewBounds) {
      onScreen = []
      onScreenDepths = []
      for (let i = 0; i < meshShapes.length; i++) {
        if (isShapeOnScreen(meshShapes[i], viewBounds)) {
          onScreen.push(meshShapes[i])
          onScreenDepths.push(meshDepths[i])
        }
      }
    } else {
      onScreen = meshShapes
      onScreenDepths = meshDepths
    }
    const visibleTexts = viewBounds ? texts.filter((t) => isTextOnScreen(t, fonts, viewBounds)) : texts
    // An image's quad IS its local bounds, so the ordinary shape cull applies unchanged.
    const visibleImages = viewBounds ? images.filter((i) => isShapeOnScreen(i, viewBounds)) : images
    // Depths lifted out of the map into arrays aligned with each lane's own packed list - the
    // draw-order merge below walks them once per object per frame, and a hash lookup in that
    // loop is the same avoidable cost it is in MeshBatcher.updateObjects.
    const visibleTextDepths = visibleTexts.map((t) => depths.get(t)!)
    const visibleImageDepths = visibleImages.map((i) => depths.get(i)!)

    // Overlays are packed last so they occupy a contiguous tail of the index buffer, which is
    // what lets ONE batch serve every pass: each draw is a half-open range of the same buffer,
    // and the tail is the one drawn with depth off so editor furniture sits on top without
    // occluding. Same one-pass bucketing as above, depths carried alongside; the overlay tail
    // is only appended (a second, usually empty pair of arrays) when there's actually one.
    const normal: Shape[] = []
    const normalDepths: number[] = []
    const overlays: Shape[] = []
    const overlayDepths: number[] = []
    for (let i = 0; i < onScreen.length; i++) {
      const shape = onScreen[i]
      if (shape.overlay) {
        overlays.push(shape)
        overlayDepths.push(onScreenDepths[i])
      } else {
        normal.push(shape)
        normalDepths.push(onScreenDepths[i])
      }
    }
    // Before that tail, the lane splits again: the shapes that provably paint no partial alpha
    // (see render/opacity.ts) are moved to the FRONT of the list, so they too occupy a
    // contiguous range and can be drawn as one call in the opaque pass. Both halves keep their
    // rank order, which is what the translucent one needs and what lets a scene that is
    // entirely one or the other be handed back untouched.
    const split = partitionByOpacity(normal, normalDepths)
    const visibleMeshShapes = overlays.length > 0 ? split.shapes.concat(overlays) : split.shapes
    const visibleMeshDepths = overlays.length > 0 ? split.depths.concat(overlayDepths) : split.depths
    const meshTranslucentStart = split.translucentStart
    const overlayStart = split.shapes.length

    // The translucent pass's order: furthest first, whatever lane that is. The mesh lane
    // contributes only its translucent middle - its opaque head is drawn as one batch in the
    // first pass, and its overlay tail last of all with depth off.
    const runs = buildDrawRuns({
      mesh: { depths: visibleMeshDepths, from: meshTranslucentStart, to: overlayStart },
      text: { depths: visibleTextDepths, from: 0, to: visibleTexts.length },
      image: { depths: visibleImageDepths, from: 0, to: visibleImages.length },
    })

    this.cached = {
      ordered,
      depths,
      meshShapes: onScreen,
      texts: visibleTexts,
      textDepths: visibleTextDepths,
      images: visibleImages,
      imageDepths: visibleImageDepths,
      visibleMeshShapes,
      visibleMeshDepths,
      meshTranslucentStart,
      overlayStart,
      runs,
    }
    return this.cached
  }
}

/**
 * Elementwise reference comparison - "did the visible set change since it was last packed?"
 *
 * Both arrays are filtered from the SAME zIndex-sorted list, so if the underlying set of
 * members is unchanged, filtering it again reproduces the identical order and a plain
 * reference walk is enough. Lives here because both render paths ask the same question of
 * the same arrays.
 */
export function sameMembers<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Asks every shape whether the scale its stroke was built against still holds.
 *
 * Free for a shape that never opted out of scaling its stroke - one boolean read - which is
 * what makes it affordable to run over the whole scene rather than over a list somebody has
 * to remember to keep. See Shape.refreshStrokeGauge.
 */
function refreshStrokeGauges(shapes: readonly Shape[]): void {
  for (let i = 0; i < shapes.length; i++) shapes[i].refreshStrokeGauge()
}
