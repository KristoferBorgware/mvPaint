// SceneRenderer - the 2D shape scene. It owns a Scene tree, the mesh lane
// and text lane pipelines/batchers, and renders by collecting visible shapes/text each
// frame, assigning each a depth from its zIndex rank (see scene/picking.ts) so the two
// lanes' draw calls resolve their stacking order correctly via the depth buffer instead
// of "whichever lane draws last always wins".
//
// THE FRAME IS DRAWN IN TWO PASSES, for the reason every alpha-blending renderer has:
// blending is order-dependent and the depth test is not, and one draw order cannot serve
// both. So draw() splits the scene by whether an object can be proven to paint only opaque
// fragments (see render/opacity.ts):
//
//   1. The OPAQUE pass needs no ordering at all - the depth buffer decides between two
//      overlapping solid shapes - so each lane draws as a single batch, and writes depth.
//   2. The TRANSLUCENT pass is strictly furthest-first across all lanes at once (see
//      render/drawOrder.ts), one draw per lane change, so each fragment lands over what is
//      already behind it. It tests depth against pass 1 but never writes it.
//   3. Then the overlay tail, on top of everything, with depth off entirely.
//
// Only the mesh lane can currently fill pass 1; text and images are always translucent, and
// render/opacity.ts says why.
//
// WHAT IT DOES NOT DO is decide any of that. Which shapes are visible, what depth each one
// takes, which lane it belongs to, where the opaque/translucent/overlay boundaries fall and
// in what order the translucent half interleaves are all worked out by render/gather.ts,
// which contains no GPU type and is shared with the WebGL fallback path. This file starts
// where that answer arrives: it packs it into buffers and submits it. Culling can be switched
// off (setCullingEnabled) for a scene that specifically wants to stress-test "everything,
// always" rather than benefit from - or be masked by - culling.
//
// It does NOT own the GPU context, resize observer, frame loop, or any scene content -
// those are wired by createWebGpuSceneRenderer() in webgpu/index.ts. Nor does it own its
// CONTENT: it starts with an empty scene, and the caller adds nodes to it afterwards.
//
// Nor does it own the CAMERA. Where a scene is looked at from is an application's business,
// so a Camera2D is supplied (createSceneRenderer's `camera` option, or setCamera later) and
// can be swapped or shared at any time. Supplying none is a valid choice rather than a
// missing one: the scene then renders through a default camera, which puts world (0, 0) at
// the viewport's top-left corner at one world unit per CSS pixel.

import { Shape } from '../shapes/Shape'
import { meshGeometryEpoch, textShapingEpoch } from '../shapes/contentEpoch'
import { Text } from '../shapes/Text'
import { Camera2D } from '../camera/Camera2D'
import { Scene } from '../scene/Scene'
import { AABB } from '../math/AABB'
import { collectZOrder, localBoundsOf, pickNode, type PickableNode } from '../scene/picking'
import { buildDrawRuns, type LaneName } from '../render/drawOrder'
import { SceneGather, sameMembers } from '../render/gather'
import type { TransformableNode } from '../shapes/Group'
import { nodesInBox, type MarqueeOptions } from '../scene/selection'
import { screenToWorld } from '../input/viewport'
import {
  createAtlasBindGroupLayout,
  createFrameBindGroupLayout,
  createMeshPipelineLayout,
  createObjectBindGroupLayout,
  createShadowPipelineLayout,
  createTextPipelineLayout,
} from './layouts'
import { FrameUniforms } from './FrameUniforms'
import { MeshBatcher } from './lanes/MeshBatcher'
import { createMeshPipeline } from './pipelines/MeshPipeline'
import { ShadowAtlas } from './ShadowAtlas'
import { ShadowBatcher } from './lanes/ShadowBatcher'
import { createShadowPipeline } from './pipelines/ShadowPipeline'
import { TextBatcher } from './lanes/TextBatcher'
import { createTextPipeline } from './pipelines/TextPipeline'
import { createImagePipeline } from './pipelines/ImagePipeline'
import { ImageBatcher } from './lanes/ImageBatcher'
import { Image } from '../shapes/Image'
import { FontBook } from './FontBook'

/** MSAA 4x. Exported because the frame loop's targets must agree with the pipelines. */
export const SAMPLE_COUNT = 4

/** Shared empty list, so a shadowless frame allocates nothing to say so. */
const NO_SHADOWS: readonly Shape[] = []

export class SceneRenderer {
  /** The scene graph: the content added by the caller, and nothing else. */
  readonly scene = new Scene()

  // The view this scene is drawn through. Never null - an application that supplies no
  // camera gets the default one, rather than a frame that silently draws nothing.
  private activeCamera: Camera2D

  /** The mesh lane's opaque-pass pipeline: depth tested and written. */
  private readonly pipeline: GPURenderPipeline
  /** Same mesh pipeline with the depth WRITE off - the translucent pass's variant. */
  private readonly translucentPipeline: GPURenderPipeline
  /** Same mesh pipeline with the depth test/write off - see createMeshPipeline's `overlay`. */
  private readonly overlayPipeline: GPURenderPipeline
  private readonly frameUniforms: FrameUniforms
  private readonly batcher: MeshBatcher
  private readonly canvas: HTMLCanvasElement

  private readonly textPipeline: GPURenderPipeline
  private readonly textBatcher: TextBatcher
  private readonly imagePipeline: GPURenderPipeline
  private readonly imageBatcher: ImageBatcher
  private readonly fontBook: FontBook

  private readonly shadowAtlas: ShadowAtlas
  private readonly shadowBatcher: ShadowBatcher
  private readonly shadowPipeline: GPURenderPipeline
  private shadowGeometryDirty = true

  // Debug/testing knob: grows (or shrinks, if negative) the culling view rectangle by
  // this many world units on every side, so popping at the view edge - or the cull
  // itself - can be seen and tuned live. 0 = cull exactly at the camera's view rectangle.
  private cullMargin = 0
  // Whether viewport culling runs at all. Every shape/text is tested against the view
  // rectangle every frame regardless of margin - a linear scan, not free at thousands of
  // objects - so a scene specifically stress-testing "how many objects can this draw",
  // rather than culling itself, can turn that scan off and submit everything unconditionally.
  private cullingEnabled = true
  // Whether the depth-rank pass sorts by zIndex at all. Every shape is still collected and
  // depth-ranked every frame either way - only the O(n log n) sort itself is skippable, for a
  // scene built front-to-back in one pass (creation order and traversal order are then the
  // same walk, so the sort would only reproduce what is already there) or that doesn't care
  // which shape ends up in front.
  private zSortEnabled = true
  // Whether the shadow lane runs at all. Even with nothing to bake, prepareShadows() and
  // draw()'s shadow section each scan every shape looking for one that casts a shadow -
  // a scene that never uses shadows can skip both scans entirely instead of confirming,
  // twice a frame, that the answer is still "none".
  private shadowsEnabled = true
  private geometryDirty = true
  private textGeometryDirty = true
  // The content epochs the packed buffers were last built from. A node whose geometry or
  // shaping changes in place bumps these, which is the only way a lane can find out - it
  // packs many nodes into shared buffers and never revisits them. See shapes/contentEpoch.
  private builtMeshEpoch = -1
  private builtTextEpoch = -1
  private imageGeometryDirty = true
  // The shapes/text currently packed into the batchers - i.e. the last computed visible
  // set - so draw() can tell whether culling's output actually changed this frame.
  private visibleMeshShapes: readonly Shape[] = []
  private visibleTexts: readonly Text[] = []
  private visibleImages: readonly Image[] = []
  // Traversal, depth assignment, culling and the overlay/opacity splits - everything the
  // frame decides before it draws anything. It owns last frame's answer and hands it back
  // whole on the fast path; see render/gather.ts, and draw()'s canReuseGather for this
  // renderer's half of that decision.
  private readonly gather = new SceneGather()

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    canvas: HTMLCanvasElement,
    fontBook: FontBook,
    camera?: Camera2D | null,
  ) {
    this.canvas = canvas
    this.fontBook = fontBook
    const frameLayout = createFrameBindGroupLayout(device)
    const objectLayout = createObjectBindGroupLayout(device)
    const pipelineLayout = createMeshPipelineLayout(device, frameLayout, objectLayout)
    this.pipeline = createMeshPipeline(device, format, SAMPLE_COUNT, pipelineLayout)
    this.translucentPipeline = createMeshPipeline(device, format, SAMPLE_COUNT, pipelineLayout, { translucent: true })
    this.overlayPipeline = createMeshPipeline(device, format, SAMPLE_COUNT, pipelineLayout, { overlay: true })
    this.frameUniforms = new FrameUniforms(device, frameLayout)
    this.batcher = new MeshBatcher(device, objectLayout)

    // Text lane: its own pipeline (adds the atlas bind group) and batcher, sharing group(0)
    // frame uniforms, group(1) object storage layout, and the MSAA sample count.
    const textPipelineLayout = createTextPipelineLayout(device, frameLayout, objectLayout, fontBook.atlasLayout)
    this.textPipeline = createTextPipeline(device, format, SAMPLE_COUNT, textPipelineLayout)
    this.textBatcher = new TextBatcher(device, objectLayout)

    // Image lane: the same shape as the text lane - its own pipeline over a vertex with a
    // texture coordinate, sharing group(0)/group(1) and the same KIND of group(2), since a font
    // atlas and a picture are both just a sampled float texture. Not the same layout, though:
    // the text lane's group(2) is a 2d-array (one layer per font style, so all four draw at
    // once), while a picture is a plain 2d.
    const imageAtlasLayout = createAtlasBindGroupLayout(device)
    const imagePipelineLayout = createTextPipelineLayout(device, frameLayout, objectLayout, imageAtlasLayout)
    this.imagePipeline = createImagePipeline(device, format, SAMPLE_COUNT, imagePipelineLayout)
    this.imageBatcher = new ImageBatcher(device, objectLayout)

    // Shadow lane: blurred silhouettes are baked once into a shared atlas (see
    // webgpu/ShadowAtlas.ts), then drawn as one quad each in a single call. Text is not
    // part of this - it duplicates its glyphs instead (see text/layout.ts).
    this.shadowAtlas = new ShadowAtlas(device)
    const shadowObjectLayout = createObjectBindGroupLayout(device)
    const shadowPipelineLayout = createShadowPipelineLayout(
      device,
      frameLayout,
      shadowObjectLayout,
      createAtlasBindGroupLayout(device),
    )
    this.shadowPipeline = createShadowPipeline(device, format, SAMPLE_COUNT, shadowPipelineLayout)
    this.shadowBatcher = new ShadowBatcher(device, shadowObjectLayout)

    this.activeCamera = camera ?? new Camera2D()
  }

  /** The camera this scene is currently drawn through. */
  get camera(): Camera2D {
    return this.activeCamera
  }

  /**
   * Replaces the camera. Passing null goes back to a fresh default one - world (0, 0) at
   * the viewport's top-left, one world unit per CSS pixel - so there is always a view, and
   * "no camera" is a framing rather than a failure.
   */
  setCamera(camera: Camera2D | null): void {
    this.activeCamera = camera ?? new Camera2D()
  }

  /** Camera zoom: >1 zooms in (content appears larger), <1 zooms out. */
  setZoom(next: number): void {
    this.activeCamera.zoom = next > 0 ? next : 1
  }

  getZoom(): number {
    return this.activeCamera.zoom
  }

  /** Debug/testing knob - see `cullMargin`. */
  setCullMargin(margin: number): void {
    this.cullMargin = margin
  }

  getCullMargin(): number {
    return this.cullMargin
  }

  /** See `cullingEnabled`. Disabling also clears the debug cull-bounds overlay's rectangle. */
  setCullingEnabled(enabled: boolean): void {
    // A stale gather would otherwise let draw()'s fast path serve a viewport-culled
    // (or now-uncullled) set built under the OLD setting - flipping this always invalidates
    // it, whether or not the caller also happens to call markGeometryDirty().
    if (enabled !== this.cullingEnabled) this.gather.invalidate()
    this.cullingEnabled = enabled
  }

  getCullingEnabled(): boolean {
    return this.cullingEnabled
  }

  /** See `zSortEnabled`. */
  setZSortEnabled(enabled: boolean): void {
    if (enabled !== this.zSortEnabled) this.gather.invalidate()
    this.zSortEnabled = enabled
  }

  getZSortEnabled(): boolean {
    return this.zSortEnabled
  }

  /** See `shadowsEnabled`. */
  setShadowsEnabled(enabled: boolean): void {
    this.shadowsEnabled = enabled
  }

  getShadowsEnabled(): boolean {
    return this.shadowsEnabled
  }

  /** The last frame's (margin-expanded) cull rectangle, world space - for a debug overlay. */
  getCullBounds(): AABB | null {
    return this.gather.getCullBounds()
  }

  /**
   * The topmost pickable shape/text under a viewport pixel (CSS px, relative to the
   * canvas's own top-left - e.g. `event.clientX/Y` minus `canvas.getBoundingClientRect()`).
   */
  pick(screenX: number, screenY: number): PickableNode | null {
    const world = screenToWorld(this.camera, screenX, screenY, {
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
    })
    if (!world) return null
    return pickNode(this.scene, world.x, world.y, this.fontBook)
  }

  /** A picked node's own local-space bounds - for sizing a selection-highlight overlay. */
  localBoundsOf(node: TransformableNode): AABB {
    return localBoundsOf(node, this.fontBook)
  }

  /**
   * Every visible, pickable shape meeting a world-space rectangle - what a marquee
   * selects. Goes through the renderer so Text is measured against the loaded atlases.
   */
  nodesInBox(from: { x: number; y: number }, to: { x: number; y: number }, options: MarqueeOptions = {}): Shape[] {
    return nodesInBox(this.scene, from, to, { fontBook: this.fontBook, ...options })
  }

  /** Force a mesh-lane geometry rebuild on the next draw (call after adding/removing shapes). */
  markGeometryDirty(): void {
    this.geometryDirty = true
  }

  /** Force a text-lane geometry rebuild on the next draw (call after adding/removing Text). */
  markTextGeometryDirty(): void {
    this.textGeometryDirty = true
  }

  /** Force an image-lane rebuild on the next draw (after adding/removing an Image, or
   * changing one's texture, crop, tiling or flip - none of which is a per-frame value). */
  markImageGeometryDirty(): void {
    this.imageGeometryDirty = true
  }

  /**
   * Re-bakes any stale shadow silhouette into the shadow atlas. Must run on the SAME
   * command encoder BEFORE the main render pass opens, since baking needs render passes of
   * its own - see createSceneRenderer's `onPrePass` wiring below. Costs nothing on a frame
   * where no shadow-casting geometry changed, which is the common case.
   */
  prepareShadows(encoder: GPUCommandEncoder): void {
    if (!this.shadowsEnabled) return
    const ordered = collectZOrder(this.scene, this.zSortEnabled)
    // Images stay in: an Image emits its quad from buildGeometry() precisely so it has a
    // silhouette to bake, even though the mesh lane does not DRAW it (see the split below).
    // The shadow is the quad's, not the alpha channel's - see Image's header.
    const meshShapes = ordered.filter((s) => !(s instanceof Text))
    // Deliberately NOT culled: a shape just off-screen can still cast a shadow that reaches
    // into view, and keeping its slot baked avoids a stutter the moment it scrolls in.
    this.shadowAtlas.update(encoder, meshShapes)
  }

  /** Update frame uniforms, (re)build geometry if dirty, refresh transforms/depth, draw both lanes. */
  draw(pass: GPURenderPassEncoder, width: number, height: number): void {
    const camera = this.activeCamera

    // The camera is sized in CSS pixels, so it is given the canvas's logical size, not the
    // device-pixel backing store passed in `width`/`height`. That is what makes 1 world
    // unit at zoom 1 the same physical size on a retina display as anywhere else: the
    // device pixel ratio decides how many physical pixels render each logical one and
    // nothing more. The uniform buffer still carries the backing-store size, which is what
    // the shaders want.
    const viewWidth = this.canvas.clientWidth
    const viewHeight = this.canvas.clientHeight

    this.frameUniforms.write(camera.viewProjection(viewWidth, viewHeight).toGPU(), width, height)

    // Culling and the zIndex sort both off means nothing in the gather can change the visible
    // SET on its own: no camera-dependent membership (nothing is ever culled), no zIndex-driven
    // reordering, and structural changes (shapes actually added/removed) always come with an
    // explicit markGeometryDirty()/markTextGeometryDirty() call. In that state last frame's
    // arrays are handed straight back - see render/gather.ts, which explains what that buys and
    // the one thing it costs (an alpha crossing 1 needs a markGeometryDirty() to be noticed).
    //
    // This half of the decision is the renderer's, because these flags are: the gather knows
    // nothing about dirty marks or content epochs.
    const canReuseGather =
      !this.cullingEnabled &&
      !this.zSortEnabled &&
      !this.geometryDirty &&
      !this.textGeometryDirty &&
      !this.imageGeometryDirty &&
      // The mesh rebuild below is skipped on the reuse path along with the gather, so the mesh
      // epoch has a say here. The text and image lanes rebuild outside it and need none.
      this.builtMeshEpoch === meshGeometryEpoch() &&
      this.gather.hasCache()

    const {
      ordered,
      depths,
      meshShapes,
      texts: visibleTexts,
      textDepths: visibleTextDepths,
      images: visibleImages,
      imageDepths: visibleImageDepths,
      visibleMeshShapes,
      visibleMeshDepths,
      meshTranslucentStart,
      overlayStart,
      runs,
    } = this.gather.run(
      {
        scene: this.scene,
        camera,
        // Culling measures Text, which needs metrics and nothing else - the atlas is not
        // consulted here (see Text.shaped).
        fonts: this.fontBook,
        viewWidth,
        viewHeight,
        cullingEnabled: this.cullingEnabled,
        zSortEnabled: this.zSortEnabled,
        cullMargin: this.cullMargin,
      },
      canReuseGather,
    )

    // rebuild() re-packs the shared GPU buffers, so it only needs to run when WHICH objects
    // belong in them changes - content added/removed, or the visible set itself changing as the
    // camera pans/zooms or an object crosses the view boundary - not every frame just because
    // something moved (that's updateObjects(), below, cheap and unconditional either way).
    //
    // Guarded by the same condition the gather is: a reused gather is by definition the set
    // that is already packed, so there is nothing for rebuild() to find.
    if (!canReuseGather) {
      if (
        this.geometryDirty ||
        this.builtMeshEpoch !== meshGeometryEpoch() ||
        !sameMembers(visibleMeshShapes, this.visibleMeshShapes)
      ) {
        this.batcher.rebuild(visibleMeshShapes)
        this.geometryDirty = false
        this.builtMeshEpoch = meshGeometryEpoch()
      }
      this.visibleMeshShapes = visibleMeshShapes
    }

    this.batcher.updateObjects(visibleMeshShapes, visibleMeshDepths)

    if (
      this.textGeometryDirty ||
      this.builtTextEpoch !== textShapingEpoch() ||
      !sameMembers(visibleTexts, this.visibleTexts)
    ) {
      this.textBatcher.rebuild(visibleTexts, this.fontBook)
      this.textGeometryDirty = false
      this.builtTextEpoch = textShapingEpoch()
    }
    this.visibleTexts = visibleTexts
    this.textBatcher.updateObjects(depths)

    // Image lane. Its geometry only changes when the visible SET does, or when a node's
    // texture/crop/tiling/flip does - all of which come with an explicit dirty mark, since
    // none of them is a per-frame value the way a transform or a tint is.
    if (this.imageGeometryDirty || !sameMembers(visibleImages, this.visibleImages)) {
      this.imageBatcher.rebuild(visibleImages)
      this.imageGeometryDirty = false
    }
    this.visibleImages = visibleImages
    this.imageBatcher.updateObjects(depths as ReadonlyMap<Image, number>)

    // Shadows. Packed and updated here, but DRAWN in the interleaved order below like any
    // other lane: a shadow is a translucent blob that has to composite over whatever is
    // behind it and under whatever is in front, which is the same problem the content lanes
    // have. Half a depth step behind its caster (see the nudge) puts it immediately before
    // that caster in the order, so a shape still paints over its own shadow.
    //
    // Skipped entirely when shadowsEnabled is off - see its declaration for why that's
    // worth having.
    const shadowCasters = this.shadowsEnabled ? meshShapes.filter((s) => s.hasShadow()) : NO_SHADOWS
    const shadowNudge = 0.5 / (ordered.length + 1)
    if (shadowCasters.length > 0 || this.shadowBatcher.packed.length > 0) {
      if (this.shadowGeometryDirty || !sameMembers(shadowCasters, this.shadowBatcher.packed)) {
        this.shadowBatcher.rebuild(shadowCasters)
        this.shadowGeometryDirty = false
      }
      // Also re-reads each shadow's atlas slot, so a silhouette re-baked this frame is
      // picked up without the geometry above needing to know anything about it.
      this.shadowBatcher.updateObjects(this.shadowAtlas, depths, shadowNudge)
    }

    // Shadows change per frame (a blur or an offset can be animated with no dirty mark), so
    // a run list that includes them cannot come from the gather cache. Scenes big enough for
    // that cache to matter switch shadows off; every scene that keeps them is small enough
    // that rebuilding the merge each frame is not worth measuring.
    const drawRuns =
      shadowCasters.length > 0
        ? buildDrawRuns({
            mesh: { depths: visibleMeshDepths, from: meshTranslucentStart, to: overlayStart },
            text: { depths: visibleTextDepths, from: 0, to: visibleTexts.length },
            image: { depths: visibleImageDepths, from: 0, to: visibleImages.length },
            shadow: {
              depths: shadowCasters.map((s) => (depths.get(s) ?? 0.5) + shadowNudge),
              from: 0,
              to: shadowCasters.length,
            },
          })
        : runs

    // PASS 1 - the opaque half, which needs no ordering at all: every fragment it paints is
    // fully opaque (see render/opacity.ts), so the depth buffer alone decides which of two
    // overlapping shapes wins, and one draw covers the lot however finely they are stacked
    // among the translucent ones. It WRITES depth, which is what lets the second pass skip
    // whatever these have hidden.
    //
    // Only the mesh lane has an opaque half to draw: text and images can never prove
    // themselves opaque, and each has exactly one, depth-read-only pipeline for that reason.
    if (meshTranslucentStart > 0) {
      pass.setPipeline(this.pipeline)
      this.batcher.draw(pass, this.frameUniforms.bindGroup, this.batcher.indexRangeFor(0, meshTranslucentStart))
    }

    // PASS 2 - everything translucent, and the shadows, interleaved strictly furthest-first
    // rather than one lane after another (see drawOrder.ts). Every fragment therefore arrives
    // over what is already behind it, which is the only order alpha blending composites
    // correctly in - a translucent shape shows the text or image behind it instead of the
    // depth buffer rejecting it for belonging to a lane that draws later.
    //
    // Depth is still TESTED here, against what pass 1 wrote, so an opaque shape in front
    // still hides all of this. It is not WRITTEN: back-to-front already resolves these
    // against each other, and writing would make them reject one another instead of blending.
    let boundLane: LaneName | null = null
    for (const run of drawRuns) {
      if (run.lane !== boundLane) {
        pass.setPipeline(
          run.lane === 'mesh'
            ? this.translucentPipeline
            : run.lane === 'text'
              ? this.textPipeline
              : run.lane === 'image'
                ? this.imagePipeline
                : this.shadowPipeline,
        )
        boundLane = run.lane
      }
      if (run.lane === 'mesh') {
        this.batcher.draw(pass, this.frameUniforms.bindGroup, this.batcher.indexRangeFor(run.from, run.to))
      } else if (run.lane === 'text') {
        this.textBatcher.drawRange(pass, this.frameUniforms.bindGroup, this.fontBook, run.from, run.to)
      } else if (run.lane === 'image') {
        this.imageBatcher.drawRange(pass, this.frameUniforms.bindGroup, run.from, run.to)
      } else {
        this.shadowBatcher.drawRange(pass, this.frameUniforms.bindGroup, this.shadowAtlas, run.from, run.to)
      }
    }

    // Last, and without touching depth: the overlay draws over every other lane.
    if (overlayStart < visibleMeshShapes.length) {
      pass.setPipeline(this.overlayPipeline)
      this.batcher.draw(
        pass,
        this.frameUniforms.bindGroup,
        this.batcher.indexRangeFor(overlayStart, visibleMeshShapes.length),
      )
    }
  }

  destroy(): void {
    this.batcher.destroy()
    this.textBatcher.destroy()
    this.imageBatcher.destroy()
    this.shadowAtlas.destroy()
    this.shadowBatcher.destroy()
    this.fontBook.destroy()
    this.frameUniforms.destroy()
  }
}
