// SceneRenderer - the 2D shape scene. It owns a Scene tree (root -> camera), the mesh lane
// and text lane pipelines/batchers, and renders by collecting visible shapes/text each
// frame, assigning each a depth from its zIndex rank (see scene/picking.ts) so the two
// lanes' draw calls resolve their stacking order correctly via the depth buffer instead
// of "whichever lane draws last always wins". Shapes/text outside the camera's current
// view rectangle are culled before reaching either batcher (see scene/culling.ts) - a
// rebuild only re-runs when the visible SET changes (content added/removed, or something
// crossing the view boundary), not on every frame just because something moved. Culling
// itself can be switched off (setCullingEnabled) for a scene that specifically wants to
// stress-test "everything, always" rather than benefit from - or be masked by - culling.
// It does NOT own the GPU context, resize observer, frame loop, or any scene content -
// those are wired by createSceneRenderer() below, with content supplied by the caller
// through the `populate` option.

import { Shape } from '../shapes/Shape'
import { meshGeometryEpoch, textShapingEpoch } from '../shapes/contentEpoch'
import { Text } from '../shapes/Text'
import { OrthographicCamera } from '../camera/OrthographicCamera'
import { Scene } from '../scene/Scene'
import { AABB } from '../math/AABB'
import { collectZOrder, depthForRank, localBoundsOf, pickNode, type PickableNode } from '../scene/picking'
import { isShapeOnScreen, isTextOnScreen } from '../scene/culling'
import { nodesInBox, type MarqueeOptions } from '../scene/selection'
import { screenToWorld } from '../input/viewport'
import {
  createAtlasBindGroupLayout,
  createFrameBindGroupLayout,
  createMeshPipelineLayout,
  createObjectBindGroupLayout,
  createShadowPipelineLayout,
  createTextPipelineLayout,
} from '../render/layouts'
import { DEPTH_FORMAT } from '../render/depthFormat'
import { FrameUniforms } from '../render/FrameUniforms'
import { MeshBatcher } from '../render/MeshBatcher'
import { createMeshPipeline } from '../render/MeshPipeline'
import { ShadowAtlas } from '../render/ShadowAtlas'
import { ShadowBatcher } from '../render/ShadowBatcher'
import { createShadowPipeline } from '../render/ShadowPipeline'
import { TextBatcher } from '../render/TextBatcher'
import { createTextPipeline } from '../render/TextPipeline'
import { createImagePipeline } from '../render/ImagePipeline'
import { ImageBatcher } from '../render/ImageBatcher'
import { Image } from '../shapes/Image'
import { FontBook } from '../text/FontAtlas'
import { createGpuContext } from '../systems/GpuContext'
import { CanvasResizer } from '../systems/CanvasResizer'
import { FrameRenderer, type FrameContext } from '../systems/FrameRenderer'

const WHITE: GPUColor = { r: 1, g: 1, b: 1, a: 1 }
const SAMPLE_COUNT = 4

// Both arrays are filtered from the SAME zIndex-sorted list, so if the underlying set of
// members is unchanged, filtering it again reproduces the identical order - a plain
// elementwise reference comparison is enough to detect "did the visible set change".
function sameMembers<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export class SceneRenderer {
  /** The scene graph: root -> camera, root -> content added by the caller. */
  readonly scene = new Scene()
  /** The active 2D orthographic camera (looks down -Z; X right, Y up). */
  readonly camera: OrthographicCamera

  private readonly pipeline: GPURenderPipeline
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

  private zoom = 1 // camera zoom factor: >1 zooms in (shapes larger), <1 zooms out
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
  // depth-ranked every frame either way - only the O(n log n) sort itself is skippable, for
  // a scene that never sets zIndex (every comparison ties, so the stable sort reproduces
  // traversal order anyway) or that doesn't care which shape ends up in front.
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
  // Last frame's gather-phase output (traversal, depth assignment, culling, overlay
  // split), reused verbatim while cullingEnabled and zSortEnabled are both off and
  // nothing has been marked dirty since - see draw()'s canReuseGather.
  private cachedGather: {
    ordered: readonly Shape[]
    depths: ReadonlyMap<Shape, number>
    meshShapes: readonly Shape[]
    texts: readonly Text[]
    images: readonly Image[]
    visibleMeshShapes: readonly Shape[]
    visibleMeshDepths: readonly number[]
    overlayStart: number
  } | null = null
  // The last frame's (margin-expanded) cull rectangle, for getCullBounds() - lets a
  // caller draw it as a debug overlay. Null before the first draw, or whenever the
  // active camera isn't an OrthographicCamera (no rectangular frustum to show).
  private lastCullBounds: AABB | null = null

  constructor(device: GPUDevice, format: GPUTextureFormat, canvas: HTMLCanvasElement, fontBook: FontBook) {
    this.canvas = canvas
    this.fontBook = fontBook
    const frameLayout = createFrameBindGroupLayout(device)
    const objectLayout = createObjectBindGroupLayout(device)
    const pipelineLayout = createMeshPipelineLayout(device, frameLayout, objectLayout)
    this.pipeline = createMeshPipeline(device, format, SAMPLE_COUNT, pipelineLayout)
    this.overlayPipeline = createMeshPipeline(device, format, SAMPLE_COUNT, pipelineLayout, { overlay: true })
    this.frameUniforms = new FrameUniforms(device, frameLayout)
    this.batcher = new MeshBatcher(device, objectLayout)

    // Text lane: its own pipeline (adds the atlas bind group) and batcher, sharing group(0)
    // frame uniforms, group(1) object storage layout, and the MSAA sample count.
    const textPipelineLayout = createTextPipelineLayout(device, frameLayout, objectLayout, fontBook.atlasLayout)
    this.textPipeline = createTextPipeline(device, format, SAMPLE_COUNT, textPipelineLayout)
    this.textBatcher = new TextBatcher(device, objectLayout)

    // Image lane: the same shape as the text lane - its own pipeline over a vertex with a
    // texture coordinate, sharing group(0)/group(1) and the very same group(2) layout, since
    // a font atlas and a picture are both just a sampled float texture.
    const imagePipelineLayout = createTextPipelineLayout(device, frameLayout, objectLayout, fontBook.atlasLayout)
    this.imagePipeline = createImagePipeline(device, format, SAMPLE_COUNT, imagePipelineLayout)
    this.imageBatcher = new ImageBatcher(device, objectLayout)

    // Shadow lane: blurred silhouettes are baked once into a shared atlas (see
    // render/ShadowAtlas.ts), then drawn as one quad each in a single call. Text is not
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

    // 2D orthographic camera looking down -Z, parented to the scene root. viewHeight is
    // set from the canvas's CSS height every frame (see draw()), so 1 world unit = 1 CSS
    // pixel on every device - device pixel ratio only changes how many physical pixels
    // render each logical one, never the logical (world-unit) size.
    this.camera = new OrthographicCamera('camera')
    this.camera.active = true
    this.scene.root.addChild(this.camera)
    this.scene.refreshActiveCamera()
  }

  /** Camera zoom: >1 zooms in (content appears larger), <1 zooms out. */
  setZoom(next: number): void {
    this.zoom = next > 0 ? next : 1
  }

  getZoom(): number {
    return this.zoom
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
    // A stale cachedGather would otherwise let draw()'s fast path serve a viewport-culled
    // (or now-uncullled) set built under the OLD setting - flipping this always invalidates
    // it, whether or not the caller also happens to call markGeometryDirty().
    if (enabled !== this.cullingEnabled) this.cachedGather = null
    this.cullingEnabled = enabled
  }

  getCullingEnabled(): boolean {
    return this.cullingEnabled
  }

  /** See `zSortEnabled`. */
  setZSortEnabled(enabled: boolean): void {
    if (enabled !== this.zSortEnabled) this.cachedGather = null
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
    return this.lastCullBounds
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
  localBoundsOf(node: PickableNode): AABB {
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
    const camera = this.scene.activeCamera
    if (!camera) return

    // 1 world unit = 1 CSS pixel at zoom 1: use the canvas's logical (DPR-independent)
    // height, not the device-pixel backing-store height passed in `height`. Aspect is
    // unaffected - device pixels and CSS pixels share the same aspect ratio (dpr cancels).
    // Dividing by zoom shrinks the visible world extent, so content appears larger.
    if (camera instanceof OrthographicCamera) {
      camera.viewHeight = Math.max(1, this.canvas.clientHeight / this.zoom)
    }

    this.frameUniforms.write(camera.viewProjection(width / height).toGPU(), width, height)

    // Culling and zIndex sort both off means nothing here can change the visible SET on
    // its own: no camera-dependent membership (nothing is ever culled), no zIndex-driven
    // reordering, and structural changes (shapes actually added/removed) always come with
    // an explicit markGeometryDirty()/markTextGeometryDirty() call. In that state, this
    // whole gather - traversal, depth assignment, split, filter - reproduces byte-identical
    // output every single frame it isn't given a reason to change, which is most of them
    // for a static scene. Reusing last frame's arrays instead of rebuilding them is what
    // lets a scene like the shape stress test skip tens of thousands of shapes' worth of
    // traversal and array-building on every frame it's just sitting there.
    const canReuseGather =
      !this.cullingEnabled &&
      !this.zSortEnabled &&
      !this.geometryDirty &&
      !this.textGeometryDirty &&
      !this.imageGeometryDirty &&
      // The mesh rebuild lives inside the gather branch below, so reusing the gather would
      // skip it. The text and image lanes rebuild outside it and need no say here.
      this.builtMeshEpoch === meshGeometryEpoch() &&
      this.cachedGather !== null

    let ordered: readonly Shape[]
    let depths: ReadonlyMap<Shape, number>
    let meshShapes: readonly Shape[]
    let visibleTexts: readonly Text[]
    let visibleImages: readonly Image[]
    let visibleMeshShapes: readonly Shape[]
    let visibleMeshDepths: readonly number[]
    let overlayStart: number

    if (canReuseGather) {
      const g = this.cachedGather!
      ordered = g.ordered
      depths = g.depths
      meshShapes = g.meshShapes
      visibleTexts = g.texts
      visibleImages = g.images
      visibleMeshShapes = g.visibleMeshShapes
      visibleMeshDepths = g.visibleMeshDepths
      overlayStart = g.overlayStart
    } else {
      // One combined traversal + zIndex sort drives BOTH lanes' depth, so a mesh shape and
      // a Text can interleave correctly under the depth test regardless of which lane's
      // draw call runs first (see scene/picking.ts). Depth ranks are scene-wide (based on
      // EVERY shape), not affected by culling below.
      const orderedLocal = collectZOrder(this.scene, this.zSortEnabled)
      const depthsLocal = new Map<Shape, number>()
      // Text is the only Shape kind that doesn't tessellate for the mesh lane (its
      // tessellate() is the inherited no-op) - everything else belongs to the mesh batcher,
      // VectorText very much included: it is text drawn AS mesh geometry, so it wants the
      // mesh lane, not this filter's other side. One pass buckets both instead of filtering
      // `ordered` twice - same result, half the iteration. meshDepthsLocal is built
      // alongside meshShapesLocal, parallel by position - see MeshBatcher.updateObjects for
      // why that's worth doing instead of a shape-keyed Map lookup per object.
      const texts: Text[] = []
      const images: Image[] = []
      const meshShapesLocal: Shape[] = []
      const meshDepthsLocal: number[] = []
      for (let rank = 0; rank < orderedLocal.length; rank++) {
        const shape = orderedLocal[rank]
        const depth = depthForRank(rank, orderedLocal.length)
        depthsLocal.set(shape, depth)
        // An Image has mesh geometry - that is what its shadow and its hit test are made
        // of - but the image lane paints those pixels, so it is bucketed out of the mesh
        // draw here rather than excluded from having geometry at all.
        if (shape instanceof Text) texts.push(shape)
        else if (shape instanceof Image) images.push(shape)
        else {
          meshShapesLocal.push(shape)
          meshDepthsLocal.push(depth)
        }
      }

      // Viewport cull: skip anything whose bounds don't overlap the camera's current view
      // rectangle (see scene/culling.ts) - falls back to "cull nothing" for a
      // non-orthographic camera (only OrthographicCamera has a rectangular frustum) or when
      // cullingEnabled is off, which also skips the per-object test itself, not just its
      // effect. Depths are filtered in step with their shapes via an explicit loop (not
      // .filter(), which can't keep a second array in sync) whenever culling can actually
      // drop something.
      const viewBounds =
        this.cullingEnabled && camera instanceof OrthographicCamera
          ? camera.viewBounds(width / height).expanded(this.cullMargin)
          : null
      this.lastCullBounds = viewBounds
      let onScreen: Shape[]
      let onScreenDepths: number[]
      if (viewBounds) {
        onScreen = []
        onScreenDepths = []
        for (let i = 0; i < meshShapesLocal.length; i++) {
          if (isShapeOnScreen(meshShapesLocal[i], viewBounds)) {
            onScreen.push(meshShapesLocal[i])
            onScreenDepths.push(meshDepthsLocal[i])
          }
        }
      } else {
        onScreen = meshShapesLocal
        onScreenDepths = meshDepthsLocal
      }
      const visibleTextsLocal = viewBounds ? texts.filter((t) => isTextOnScreen(t, this.fontBook, viewBounds)) : texts
      // An image's quad IS its local bounds, so the ordinary shape cull applies unchanged.
      const visibleImagesLocal = viewBounds ? images.filter((i) => isShapeOnScreen(i, viewBounds)) : images

      // Overlays are packed last so they occupy a contiguous tail of the index buffer, which
      // is what lets one batch be drawn as two ranges: the scene, then (after the text lane)
      // the overlay with depth off, so editor furniture sits on top without occluding. Same
      // one-pass bucketing as above, depths carried alongside; the overlay tail is only
      // appended (a second, usually empty pair of arrays) when there's actually one to append.
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
      const visibleMeshShapesLocal = overlays.length > 0 ? normal.concat(overlays) : normal
      const visibleMeshDepthsLocal = overlays.length > 0 ? normalDepths.concat(overlayDepths) : normalDepths
      const overlayStartLocal = normal.length

      // rebuild() re-packs the shared GPU buffers, so it only needs to run when WHICH
      // objects belong in them changes - content added/removed, or the visible set itself
      // changing as the camera pans/zooms or an object crosses the view boundary - not
      // every frame just because something moved (that's updateObjects(), below, cheap and
      // unconditional either way).
      if (
        this.geometryDirty ||
        this.builtMeshEpoch !== meshGeometryEpoch() ||
        !sameMembers(visibleMeshShapesLocal, this.visibleMeshShapes)
      ) {
        this.batcher.rebuild(visibleMeshShapesLocal)
        this.geometryDirty = false
        this.builtMeshEpoch = meshGeometryEpoch()
      }
      this.visibleMeshShapes = visibleMeshShapesLocal

      ordered = orderedLocal
      depths = depthsLocal
      meshShapes = onScreen
      visibleTexts = visibleTextsLocal
      visibleImages = visibleImagesLocal
      visibleMeshShapes = visibleMeshShapesLocal
      visibleMeshDepths = visibleMeshDepthsLocal
      overlayStart = overlayStartLocal

      this.cachedGather = {
        ordered: orderedLocal,
        depths: depthsLocal,
        meshShapes: onScreen,
        texts: visibleTextsLocal,
        images: visibleImagesLocal,
        visibleMeshShapes: visibleMeshShapesLocal,
        visibleMeshDepths: visibleMeshDepthsLocal,
        overlayStart: overlayStartLocal,
      }
    }

    this.batcher.updateObjects(visibleMeshShapes, visibleMeshDepths)

    pass.setPipeline(this.pipeline)
    this.batcher.draw(pass, this.frameUniforms.bindGroup, this.batcher.indexRangeFor(0, overlayStart))

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
    pass.setPipeline(this.textPipeline)
    this.textBatcher.draw(pass, this.frameUniforms.bindGroup, this.fontBook)

    // Image lane. Its geometry only changes when the visible SET does, or when a node's
    // texture/crop/tiling/flip does - all of which come with an explicit dirty mark, since
    // none of them is a per-frame value the way a transform or a tint is.
    if (this.imageGeometryDirty || !sameMembers(visibleImages, this.visibleImages)) {
      this.imageBatcher.rebuild(visibleImages)
      this.imageGeometryDirty = false
    }
    this.visibleImages = visibleImages
    this.imageBatcher.updateObjects(depths as ReadonlyMap<Image, number>)
    pass.setPipeline(this.imagePipeline)
    this.imageBatcher.draw(pass, this.frameUniforms.bindGroup)

    // Shadows draw AFTER the content lanes, depth-tested but never depth-writing (see
    // ShadowPipeline). That ordering is what makes them stack: by the time a shadow is
    // drawn, every shape has already written its depth, so the test alone decides whether
    // the shadow lands on top of a given shape or is hidden behind it - including the very
    // shape casting it. Drawing them first instead would paint every shadow under
    // everything, which is only correct for a single-layer scene. Skipped entirely when
    // shadowsEnabled is off - see its declaration for why that's worth having.
    if (this.shadowsEnabled) {
      const shadowCasters = meshShapes.filter((s) => s.hasShadow())
      if (shadowCasters.length > 0 || this.shadowBatcher.packed.length > 0) {
        if (this.shadowGeometryDirty || !sameMembers(shadowCasters, this.shadowBatcher.packed)) {
          this.shadowBatcher.rebuild(shadowCasters)
          this.shadowGeometryDirty = false
        }
        // Half a depth step behind the caster: far enough to lose the depth test against its
        // own shape, near enough to stay in front of whatever sits below it. This also
        // re-reads each shadow's atlas slot, so a silhouette re-baked this frame is picked up
        // without the geometry above needing to know anything about it.
        this.shadowBatcher.updateObjects(this.shadowAtlas, depths, 0.5 / (ordered.length + 1))
        pass.setPipeline(this.shadowPipeline)
        this.shadowBatcher.draw(pass, this.frameUniforms.bindGroup, this.shadowAtlas)
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

export interface SceneRendererHandle {
  /** The scene graph root - add/remove content here, then call markGeometryDirty()/markTextGeometryDirty(). */
  scene: Scene
  camera: OrthographicCamera
  setZoom: (zoom: number) => void
  getZoom: () => number
  /** Debug/testing knob: grows (or shrinks, if negative) the viewport-culling rectangle. */
  setCullMargin: (margin: number) => void
  getCullMargin: () => number
  /** Turns viewport culling on/off entirely - see SceneRenderer's `cullingEnabled`. */
  setCullingEnabled: (enabled: boolean) => void
  getCullingEnabled: () => boolean
  /** Turns the zIndex depth-sort on/off - see SceneRenderer's `zSortEnabled`. */
  setZSortEnabled: (enabled: boolean) => void
  getZSortEnabled: () => boolean
  /** Turns the shadow lane on/off entirely - see SceneRenderer's `shadowsEnabled`. */
  setShadowsEnabled: (enabled: boolean) => void
  getShadowsEnabled: () => boolean
  /** The last frame's (margin-expanded) cull rectangle, world space, or null before the first draw. */
  getCullBounds: () => AABB | null
  /** The topmost pickable shape/text under a canvas-relative CSS pixel, or null. */
  pick: (screenX: number, screenY: number) => PickableNode | null
  /** A picked node's own local-space bounds - for sizing a selection-highlight overlay. */
  localBoundsOf: (node: PickableNode) => AABB
  /** Every visible, pickable shape meeting a world-space rectangle - what a marquee selects. */
  nodesInBox: (from: { x: number; y: number }, to: { x: number; y: number }, options?: MarqueeOptions) => Shape[]
  markGeometryDirty: () => void
  markTextGeometryDirty: () => void
  markImageGeometryDirty: () => void
  /** The GPU device, for building an ImageTexture - the one resource an application has to
   * create for itself, since only it knows which pictures the scene wants. */
  device: GPUDevice
  destroy: () => void
}

export interface CreateSceneRendererOptions {
  /**
   * Called with a human-readable message on a GPU device error (e.g. an invalid
   * pipeline from a shader/bind-group-layout mismatch). Such errors do NOT throw - they
   * surface asynchronously via the device - so without this they render as a silently
   * blank canvas. Reporting them makes that failure mode visible instead.
   */
  onDeviceError?: (message: string) => void
  /**
   * Called once after the scene and camera are ready, before the first frame - build the
   * initial scene content here (shapes, text, camera framing). `device` is passed because
   * this runs before the handle exists, and content with images needs one to build a
   * texture from.
   */
  populate?: (scene: Scene, camera: OrthographicCamera, device: GPUDevice) => void
  /** Called every frame, before the draw - e.g. to animate scene content. */
  onFrame?: (dt: number) => void
}

/**
 * Composition root: wires the GPU context, resize observer and frame loop (system
 * components) to a SceneRenderer, loads the MSDF font atlases, and starts the render loop
 * on a white background through a 2D orthographic camera, MSAA 4x. Scene content is supplied
 * by the caller via `options.populate`. Throws if WebGPU is unavailable.
 */
export async function createSceneRenderer(
  canvas: HTMLCanvasElement,
  options: CreateSceneRendererOptions = {},
): Promise<SceneRendererHandle> {
  const gpu = await createGpuContext(canvas)

  // Surface asynchronous device (validation) errors - an invalid pipeline or a bad
  // draw does not throw; it just poisons the command buffer and the canvas stays blank.
  gpu.device.addEventListener('uncapturederror', (event) => {
    const message = (event as GPUUncapturedErrorEvent).error.message
    console.error('WebGPU device error:', message)
    options.onDeviceError?.(message)
  })

  // Load the MSDF font atlases (fetch each PNG + upload to the GPU) before building the scene,
  // so the text lane has its textures ready on the first frame.
  const fontBook = await FontBook.load(gpu.device)

  // Catch the most common startup failure - an invalid render pipeline built from a
  // shader/layout mismatch - which is created inside the SceneRenderer constructor.
  gpu.device.pushErrorScope('validation')
  const scene = new SceneRenderer(gpu.device, gpu.format, canvas, fontBook)
  gpu.device.popErrorScope().then((error) => {
    if (error) {
      console.error('WebGPU pipeline setup error:', error.message)
      options.onDeviceError?.(error.message)
    }
  })

  options.populate?.(scene.scene, scene.camera, gpu.device)

  const resizer = new CanvasResizer(canvas)

  const frameRenderer = new FrameRenderer(
    gpu,
    resizer,
    ({ pass, dt, width, height }: FrameContext) => {
      options.onFrame?.(dt)
      scene.draw(pass, width, height)
    },
    {
      clearColor: WHITE,
      sampleCount: SAMPLE_COUNT,
      depthFormat: DEPTH_FORMAT,
      // Shadow rendering needs its own offscreen render passes on the same encoder,
      // finished before the main pass (which draws the composited result) begins.
      onPrePass: (encoder) => scene.prepareShadows(encoder),
    },
  )
  frameRenderer.start()

  return {
    scene: scene.scene,
    camera: scene.camera,
    setZoom(next: number) {
      scene.setZoom(next)
    },
    getZoom() {
      return scene.getZoom()
    },
    setCullMargin(margin: number) {
      scene.setCullMargin(margin)
    },
    getCullMargin() {
      return scene.getCullMargin()
    },
    setCullingEnabled(enabled: boolean) {
      scene.setCullingEnabled(enabled)
    },
    getCullingEnabled() {
      return scene.getCullingEnabled()
    },
    setZSortEnabled(enabled: boolean) {
      scene.setZSortEnabled(enabled)
    },
    getZSortEnabled() {
      return scene.getZSortEnabled()
    },
    setShadowsEnabled(enabled: boolean) {
      scene.setShadowsEnabled(enabled)
    },
    getShadowsEnabled() {
      return scene.getShadowsEnabled()
    },
    getCullBounds() {
      return scene.getCullBounds()
    },
    pick(screenX: number, screenY: number) {
      return scene.pick(screenX, screenY)
    },
    localBoundsOf(node: PickableNode) {
      return scene.localBoundsOf(node)
    },
    nodesInBox(from, to, options) {
      return scene.nodesInBox(from, to, options)
    },
    markGeometryDirty() {
      scene.markGeometryDirty()
    },
    markTextGeometryDirty() {
      scene.markTextGeometryDirty()
    },
    markImageGeometryDirty() {
      scene.markImageGeometryDirty()
    },
    device: gpu.device,
    destroy() {
      frameRenderer.stop()
      scene.destroy()
      resizer.dispose()
      gpu.device.destroy()
    },
  }
}
