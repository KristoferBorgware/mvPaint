// SceneRenderer - the 2D shape scene. It owns a Scene tree (root -> camera), the mesh lane
// and text lane pipelines/batchers, and renders by collecting visible shapes/text each
// frame, assigning each a depth from its zIndex rank (see scene/picking.ts) so the two
// lanes' draw calls resolve their stacking order correctly via the depth buffer instead
// of "whichever lane draws last always wins". Shapes/text outside the camera's current
// view rectangle are culled before reaching either batcher (see scene/culling.ts) - a
// rebuild only re-runs when the visible SET changes (content added/removed, or something
// crossing the view boundary), not on every frame just because something moved. It does
// NOT own the GPU context, resize observer, frame loop, or any scene content - those are
// wired by createSceneRenderer() below, with content supplied by the caller through the
// `populate` option.

import { Shape } from '../shapes/Shape'
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
  private geometryDirty = true
  private textGeometryDirty = true
  // The shapes/text currently packed into the batchers - i.e. the last computed visible
  // set - so draw() can tell whether culling's output actually changed this frame.
  private visibleMeshShapes: Shape[] = []
  private visibleTexts: Text[] = []
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

  /**
   * Re-bakes any stale shadow silhouette into the shadow atlas. Must run on the SAME
   * command encoder BEFORE the main render pass opens, since baking needs render passes of
   * its own - see createSceneRenderer's `onPrePass` wiring below. Costs nothing on a frame
   * where no shadow-casting geometry changed, which is the common case.
   */
  prepareShadows(encoder: GPUCommandEncoder): void {
    const ordered = collectZOrder(this.scene)
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

    // One combined traversal + zIndex sort drives BOTH lanes' depth, so a mesh shape and
    // a Text can interleave correctly under the depth test regardless of which lane's
    // draw call runs first (see scene/picking.ts). Depth ranks are scene-wide (based on
    // EVERY shape), not affected by culling below.
    const ordered = collectZOrder(this.scene)
    const depths = new Map<Shape, number>()
    ordered.forEach((shape, rank) => depths.set(shape, depthForRank(rank, ordered.length)))
    // Text is the only Shape kind that doesn't tessellate for the mesh lane (its
    // tessellate() is the inherited no-op) - everything else belongs to the mesh batcher.
    const texts = ordered.filter((s): s is Text => s instanceof Text)
    const meshShapes = ordered.filter((s) => !(s instanceof Text))

    // Viewport cull: skip anything whose bounds don't overlap the camera's current view
    // rectangle (see scene/culling.ts) - falls back to "cull nothing" for a
    // non-orthographic camera, since only OrthographicCamera has a rectangular frustum.
    const viewBounds =
      camera instanceof OrthographicCamera ? camera.viewBounds(width / height).expanded(this.cullMargin) : null
    this.lastCullBounds = viewBounds
    const onScreen = viewBounds ? meshShapes.filter((s) => isShapeOnScreen(s, viewBounds)) : meshShapes
    const visibleTexts = viewBounds ? texts.filter((t) => isTextOnScreen(t, this.fontBook, viewBounds)) : texts

    // Overlays are packed last so they occupy a contiguous tail of the index buffer, which
    // is what lets one batch be drawn as two ranges: the scene, then (after the text lane)
    // the overlay with depth off, so editor furniture sits on top without occluding.
    const normal = onScreen.filter((s) => !s.overlay)
    const overlays = onScreen.filter((s) => s.overlay)
    const visibleMeshShapes = [...normal, ...overlays]
    const overlayStart = normal.length

    // rebuild() re-packs the shared GPU buffers, so it only needs to run when WHICH
    // objects belong in them changes - content added/removed, or the visible set itself
    // changing as the camera pans/zooms or an object crosses the view boundary - not
    // every frame just because something moved (that's updateObjects(), below, cheap and
    // unconditional either way).
    if (this.geometryDirty || !sameMembers(visibleMeshShapes, this.visibleMeshShapes)) {
      this.batcher.rebuild(visibleMeshShapes)
      this.geometryDirty = false
    }
    this.visibleMeshShapes = visibleMeshShapes
    this.batcher.updateObjects(visibleMeshShapes, depths)

    pass.setPipeline(this.pipeline)
    this.batcher.draw(pass, this.frameUniforms.bindGroup, this.batcher.indexRangeFor(0, overlayStart))

    if (this.textGeometryDirty || !sameMembers(visibleTexts, this.visibleTexts)) {
      this.textBatcher.rebuild(visibleTexts, this.fontBook)
      this.textGeometryDirty = false
    }
    this.visibleTexts = visibleTexts
    this.textBatcher.updateObjects(depths)
    pass.setPipeline(this.textPipeline)
    this.textBatcher.draw(pass, this.frameUniforms.bindGroup, this.fontBook)

    // Shadows draw AFTER the content lanes, depth-tested but never depth-writing (see
    // ShadowPipeline). That ordering is what makes them stack: by the time a shadow is
    // drawn, every shape has already written its depth, so the test alone decides whether
    // the shadow lands on top of a given shape or is hidden behind it - including the very
    // shape casting it. Drawing them first instead would paint every shadow under
    // everything, which is only correct for a single-layer scene.
    const shadowCasters = onScreen.filter((s) => s.hasShadow())
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

    // Last, and without touching depth: the overlay draws over every other lane.
    if (overlays.length > 0) {
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
   * initial scene content here (shapes, text, camera framing).
   */
  populate?: (scene: Scene, camera: OrthographicCamera) => void
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

  options.populate?.(scene.scene, scene.camera)

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
    destroy() {
      frameRenderer.stop()
      scene.destroy()
      resizer.dispose()
      gpu.device.destroy()
    },
  }
}
