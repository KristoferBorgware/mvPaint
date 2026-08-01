// The fallback's renderer: the same frame, drawn with WebGL2.
//
// The structure is the WebGPU one's, because the structure is not a WebGPU idea - it is the
// engine's. Gather (shared, render/gather.ts), then three passes:
//
//   1. OPAQUE - the mesh lane's provably-opaque head, one draw, writing depth.
//   2. TRANSLUCENT - everything else, strictly furthest-first across lanes, testing depth but
//      never writing it, one draw per lane change.
//   3. OVERLAY - the editor furniture on top, depth off entirely.
//
// What differs is underneath. There are no bind groups, so the frame's view-projection is a
// uniform set once per pass and the object records are a texture bound per lane. There is no
// command encoder, so passes are just calls in order. And there is no MSAA: this renders
// straight into the default framebuffer, so mesh edges are aliased where WebGPU's resolve
// would have smoothed them. Text is unaffected when its lane arrives - an MSDF glyph
// antialiases itself in the fragment shader.
//
// All four lanes are here. What is missing relative to WebGPU is MSAA, and nothing else.

import { Camera2D } from '../camera/Camera2D'
import { flipRows, type CapturePlan, type CaptureView } from '../render/capture'
import { GlCaptureTarget } from './CaptureTarget'
import type { AABB } from '../math/AABB'
import { Scene } from '../scene/Scene'
import { collectZOrder, localBoundsOf, pickNode, type PickableNode } from '../scene/picking'
import { nodesInBox, type MarqueeOptions } from '../scene/selection'
import { screenToWorld } from '../input/viewport'
import { Shape } from '../shapes/Shape'
import type { TransformableNode } from '../shapes/Group'
import { meshGeometryEpoch } from '../shapes/contentEpoch'
import { SceneGather, sameMembers } from '../render/gather'
import { buildDrawRuns, type LaneName } from '../render/drawOrder'
import { textShapingEpoch } from '../shapes/contentEpoch'
import { Text } from '../shapes/Text'
import type { Image } from '../shapes/Image'
import type { Gl2Context } from './Gl2Context'
import type { GlFontBook } from './FontBook'
import { GlProgram, GlStateCache } from './programs'
import { meshFragmentGlsl, meshVertexGlsl } from './shaders/mesh.glsl'
import { textFragmentGlsl, textVertexGlsl } from './shaders/text.glsl'
import { imageFragmentGlsl, imageVertexGlsl } from './shaders/image.glsl'
import { shadowQuadFragmentGlsl, shadowQuadVertexGlsl } from './shaders/shadow.glsl'
import { GlMeshBatcher } from './lanes/MeshBatcher'
import { GlTextBatcher } from './lanes/TextBatcher'
import { GlImageBatcher } from './lanes/ImageBatcher'
import { GlShadowBatcher } from './lanes/ShadowBatcher'
import { GlShadowAtlas } from './ShadowAtlas'

/** Shared empty list, so a shadowless frame allocates nothing to say so. */
const NO_SHADOWS: readonly Shape[] = []

export class GlSceneRenderer {
  readonly scene = new Scene()

  private activeCamera: Camera2D
  // Allocated on the first capture - most sessions never take one.
  private captureTarget: GlCaptureTarget | null = null
  private readonly gl: WebGL2RenderingContext
  private readonly canvas: HTMLCanvasElement
  private readonly stateCache: GlStateCache

  private readonly meshOpaque: GlProgram
  private readonly meshTranslucent: GlProgram
  private readonly meshOverlay: GlProgram
  private readonly meshBatcher: GlMeshBatcher

  private readonly textProgram: GlProgram
  private readonly textBatcher: GlTextBatcher

  private readonly imageProgram: GlProgram
  private readonly imageBatcher: GlImageBatcher

  private readonly shadowProgram: GlProgram
  private readonly shadowBatcher: GlShadowBatcher
  private readonly shadowAtlas: GlShadowAtlas
  private shadowGeometryDirty = true

  // Shaping, measuring and culling need font METRICS; drawing also needs the atlas. One object
  // supplies both, and it is a FontProvider, so picking and culling never touch the texture.
  private readonly fonts: GlFontBook

  private readonly gather = new SceneGather()
  private cullMargin = 0
  private cullingEnabled = true
  private zSortEnabled = true
  private shadowsEnabled = true
  private geometryDirty = true
  private textGeometryDirty = true
  private imageGeometryDirty = true
  private builtMeshEpoch = -1
  private builtTextEpoch = -1
  private visibleMeshShapes: readonly Shape[] = []
  private visibleTexts: readonly Text[] = []
  private visibleImages: readonly Image[] = []

  constructor(context: Gl2Context, fonts: GlFontBook, camera?: Camera2D | null) {
    this.gl = context.gl
    this.canvas = context.canvas
    this.fonts = fonts
    this.activeCamera = camera ?? new Camera2D()
    this.stateCache = new GlStateCache(this.gl)

    // Three programs from one shader pair, differing only in what they do with depth - the
    // same three variants webgpu/pipelines/MeshPipeline.ts builds, for the same reasons.
    const mesh = { vertex: meshVertexGlsl, fragment: meshFragmentGlsl }
    this.meshOpaque = new GlProgram(this.gl, this.stateCache, {
      ...mesh,
      label: 'mesh-opaque',
      state: { blend: true, depthTest: true, depthWrite: true, depthFunc: this.gl.LEQUAL },
    })
    this.meshTranslucent = new GlProgram(this.gl, this.stateCache, {
      ...mesh,
      label: 'mesh-translucent',
      // Tested against what pass 1 wrote, never written: back-to-front already resolves these
      // against each other, and writing would make them reject one another instead of blending.
      state: { blend: true, depthTest: true, depthWrite: false, depthFunc: this.gl.LEQUAL },
    })
    this.meshOverlay = new GlProgram(this.gl, this.stateCache, {
      ...mesh,
      label: 'mesh-overlay',
      state: { blend: true, depthTest: true, depthWrite: false, depthFunc: this.gl.ALWAYS },
    })
    this.meshBatcher = new GlMeshBatcher(this.gl)

    // Text is never opaque - an MSDF glyph's alpha IS its coverage, so every outline is a ring
    // of partial-alpha fragments however solid the run's colour is. One depth-read-only program
    // is all the lane can ever need (see render/opacity.ts).
    this.textProgram = new GlProgram(this.gl, this.stateCache, {
      label: 'text',
      vertex: textVertexGlsl,
      fragment: textFragmentGlsl,
      state: { blend: true, depthTest: true, depthWrite: false, depthFunc: this.gl.LEQUAL },
    })
    this.textBatcher = new GlTextBatcher(this.gl)

    // An image can never be proven opaque either: what is in a texture is the application's
    // business and is never read back, so a tint alpha of 1 proves nothing (see
    // render/opacity.ts). One depth-read-only program, like text.
    this.imageProgram = new GlProgram(this.gl, this.stateCache, {
      label: 'image',
      vertex: imageVertexGlsl,
      fragment: imageFragmentGlsl,
      state: { blend: true, depthTest: true, depthWrite: false, depthFunc: this.gl.LEQUAL },
    })
    this.imageBatcher = new GlImageBatcher(this.gl)

    // A shadow is a translucent blob by definition, so it too is depth-read-only.
    this.shadowProgram = new GlProgram(this.gl, this.stateCache, {
      label: 'shadow',
      vertex: shadowQuadVertexGlsl,
      fragment: shadowQuadFragmentGlsl,
      state: { blend: true, depthTest: true, depthWrite: false, depthFunc: this.gl.LEQUAL },
    })
    this.shadowBatcher = new GlShadowBatcher(this.gl)
    this.shadowAtlas = new GlShadowAtlas(this.gl, this.stateCache)
  }

  get camera(): Camera2D {
    return this.activeCamera
  }

  setCamera(camera: Camera2D | null): void {
    this.activeCamera = camera ?? new Camera2D()
  }

  setZoom(next: number): void {
    this.activeCamera.zoom = next > 0 ? next : 1
  }

  getZoom(): number {
    return this.activeCamera.zoom
  }

  setCullMargin(margin: number): void {
    this.cullMargin = margin
  }

  getCullMargin(): number {
    return this.cullMargin
  }

  setCullingEnabled(enabled: boolean): void {
    if (enabled !== this.cullingEnabled) this.gather.invalidate()
    this.cullingEnabled = enabled
  }

  getCullingEnabled(): boolean {
    return this.cullingEnabled
  }

  setZSortEnabled(enabled: boolean): void {
    if (enabled !== this.zSortEnabled) this.gather.invalidate()
    this.zSortEnabled = enabled
  }

  getZSortEnabled(): boolean {
    return this.zSortEnabled
  }

  setShadowsEnabled(enabled: boolean): void {
    this.shadowsEnabled = enabled
  }

  getShadowsEnabled(): boolean {
    return this.shadowsEnabled
  }

  getCullBounds(): AABB | null {
    return this.gather.getCullBounds()
  }

  pick(screenX: number, screenY: number): PickableNode | null {
    const world = screenToWorld(this.camera, screenX, screenY, {
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
    })
    if (!world) return null
    return pickNode(this.scene, world.x, world.y, this.fonts)
  }

  localBoundsOf(node: TransformableNode): AABB {
    return localBoundsOf(node, this.fonts)
  }

  nodesInBox(from: { x: number; y: number }, to: { x: number; y: number }, options: MarqueeOptions = {}): Shape[] {
    return nodesInBox(this.scene, from, to, { fontBook: this.fonts, ...options })
  }

  markGeometryDirty(): void {
    this.geometryDirty = true
  }

  markTextGeometryDirty(): void {
    this.textGeometryDirty = true
  }

  markImageGeometryDirty(): void {
    this.imageGeometryDirty = true
  }

  /**
   * Re-bake any stale shadow silhouette. Runs BEFORE the frame, because baking binds its own
   * framebuffer and it would be a mess to do that halfway through drawing the scene - the same
   * reason the WebGPU path needs a prepass on the frame's encoder.
   */
  prepareShadows(): void {
    if (!this.shadowsEnabled) return
    const ordered = collectZOrder(this.scene, this.zSortEnabled)
    // Deliberately NOT culled: a shape just off-screen can still cast a shadow that reaches
    // into view, and keeping its slot baked avoids a stutter the moment it scrolls in.
    this.shadowAtlas.update(ordered.filter((s) => !(s instanceof Text)))
  }

  /** One frame, into the default framebuffer. `width`/`height` are backing-store pixels. */
  /**
   * Draws the scene into whatever framebuffer is currently bound, at `width` x `height`
   * device pixels.
   *
   * `view` overrides the three things a capture needs to differ in - which camera, what view
   * size that camera is asked to cover, and what to clear to - and is absent for a live frame,
   * which takes all three from the canvas. Everything else about the two is identical, which is
   * the point: a screenshot that went through its own drawing code would drift from the picture
   * it is supposed to be a copy of.
   */
  draw(width: number, height: number, view?: CaptureView): void {
    const gl = this.gl
    const camera = view?.camera ?? this.activeCamera
    // The camera is sized in CSS pixels; the device pixel ratio decides how many physical
    // pixels render each logical one and nothing more.
    const viewWidth = view?.viewWidth ?? this.canvas.clientWidth
    const viewHeight = view?.viewHeight ?? this.canvas.clientHeight

    const canReuseGather =
      !this.cullingEnabled &&
      !this.zSortEnabled &&
      !this.geometryDirty &&
      !this.textGeometryDirty &&
      !this.imageGeometryDirty &&
      this.builtMeshEpoch === meshGeometryEpoch() &&
      this.gather.hasCache()

    const g = this.gather.run(
      {
        scene: this.scene,
        camera,
        fonts: this.fonts,
        viewWidth,
        viewHeight,
        cullingEnabled: this.cullingEnabled,
        zSortEnabled: this.zSortEnabled,
        cullMargin: this.cullMargin,
      },
      canReuseGather,
    )

    if (!canReuseGather) {
      if (
        this.geometryDirty ||
        this.builtMeshEpoch !== meshGeometryEpoch() ||
        !sameMembers(g.visibleMeshShapes, this.visibleMeshShapes)
      ) {
        this.meshBatcher.rebuild(g.visibleMeshShapes)
        this.geometryDirty = false
        this.builtMeshEpoch = meshGeometryEpoch()
      }
      this.visibleMeshShapes = g.visibleMeshShapes
    }
    this.meshBatcher.updateObjects(g.visibleMeshShapes, g.visibleMeshDepths)

    if (
      this.textGeometryDirty ||
      this.builtTextEpoch !== textShapingEpoch() ||
      !sameMembers(g.texts, this.visibleTexts)
    ) {
      this.textBatcher.rebuild(g.texts, this.fonts)
      this.textGeometryDirty = false
      this.builtTextEpoch = textShapingEpoch()
    }
    this.visibleTexts = g.texts
    this.textBatcher.updateObjects(g.depths)

    // The image lane's geometry only changes when the visible SET does, or when a node's
    // texture, crop, tiling or flip does - all of which come with an explicit dirty mark,
    // since none of them is a per-frame value the way a transform or a tint is.
    if (this.imageGeometryDirty || !sameMembers(g.images, this.visibleImages)) {
      this.imageBatcher.rebuild(g.images)
      this.imageGeometryDirty = false
    }
    this.visibleImages = g.images
    this.imageBatcher.updateObjects(g.depths as ReadonlyMap<Image, number>)

    // Shadows. Packed and updated here, but DRAWN in the interleaved order below like any
    // other lane: a shadow has to composite over whatever is behind it and under whatever is
    // in front. Half a depth step behind its caster puts it immediately before that caster in
    // the order, so a shape still paints over its own shadow.
    const shadowCasters = this.shadowsEnabled ? g.meshShapes.filter((s) => s.hasShadow()) : NO_SHADOWS
    const shadowNudge = 0.5 / (g.ordered.length + 1)
    if (shadowCasters.length > 0 || this.shadowBatcher.packed.length > 0) {
      if (this.shadowGeometryDirty || !sameMembers(shadowCasters, this.shadowBatcher.packed)) {
        this.shadowBatcher.rebuild(shadowCasters)
        this.shadowGeometryDirty = false
      }
      this.shadowBatcher.updateObjects(this.shadowAtlas, g.depths, shadowNudge)
    }

    // A run list including shadows cannot come from the gather cache: a blur or an offset can
    // be animated with no dirty mark at all.
    const drawRuns =
      shadowCasters.length > 0
        ? buildDrawRuns({
            mesh: { depths: g.visibleMeshDepths, from: g.meshTranslucentStart, to: g.overlayStart },
            text: { depths: g.textDepths, from: 0, to: g.texts.length },
            image: { depths: g.imageDepths, from: 0, to: g.images.length },
            shadow: {
              depths: shadowCasters.map((s) => (g.depths.get(s) ?? 0.5) + shadowNudge),
              from: 0,
              to: shadowCasters.length,
            },
          })
        : g.runs

    gl.viewport(0, 0, width, height)
    // Scissor and culling are never wanted here and are global state, so they are settled once
    // rather than being part of every program's block.
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.CULL_FACE)
    // Clearing depth needs the depth write ON, whatever the last program left behind.
    gl.depthMask(true)
    this.stateCache.invalidate()
    const bg = view?.background
    gl.clearColor(bg ? bg[0] : 1, bg ? bg[1] : 1, bg ? bg[2] : 1, bg ? bg[3] : 1)
    gl.clearDepth(1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    const viewProjection = camera.viewProjection(viewWidth, viewHeight).toGPU()

    // PASS 1 - the opaque half. No ordering needed: every fragment it paints is fully opaque,
    // so the depth buffer alone decides between two overlapping shapes, and one draw covers
    // the lot however finely they are stacked among the translucent ones.
    if (g.meshTranslucentStart > 0) {
      this.bindLane(this.meshOpaque, viewProjection)
      this.meshBatcher.draw(this.meshOpaque, this.meshBatcher.indexRangeFor(0, g.meshTranslucentStart))
    }

    // PASS 2 - everything translucent, interleaved strictly furthest-first (render/drawOrder).
    // Only the mesh lane contributes so far; the loop is written for all four because the run
    // list already is, and the lanes land into it unchanged.
    let boundLane: LaneName | null = null
    for (const run of drawRuns) {
      if (boundLane !== run.lane) {
        this.bindLane(
          run.lane === 'mesh'
            ? this.meshTranslucent
            : run.lane === 'text'
              ? this.textProgram
              : run.lane === 'image'
                ? this.imageProgram
                : this.shadowProgram,
          viewProjection,
        )
        boundLane = run.lane
      }
      if (run.lane === 'mesh') {
        this.meshBatcher.draw(this.meshTranslucent, this.meshBatcher.indexRangeFor(run.from, run.to))
      } else if (run.lane === 'text') {
        this.textBatcher.drawRange(this.textProgram, this.fonts, run.from, run.to)
      } else if (run.lane === 'image') {
        this.imageBatcher.drawRange(this.imageProgram, run.from, run.to)
      } else {
        this.shadowBatcher.drawRange(this.shadowProgram, this.shadowAtlas, run.from, run.to)
      }
    }

    // PASS 3 - the overlay tail, over every other lane, touching depth not at all.
    if (g.overlayStart < g.visibleMeshShapes.length) {
      this.bindLane(this.meshOverlay, viewProjection)
      this.meshBatcher.draw(
        this.meshOverlay,
        this.meshBatcher.indexRangeFor(g.overlayStart, g.visibleMeshShapes.length),
      )
    }
  }

  /**
   * Bind a lane's program and the frame-wide uniforms - what group(0) is on the other path.
   * Every lane wants the view-projection and, so far, nothing else; the per-lane bindings (the
   * object texture, an atlas) belong to the batcher that knows about them.
   */
  private bindLane(program: GlProgram, viewProjection: Float32Array): void {
    program.use()
    this.gl.uniformMatrix4fv(program.uniform('u_viewProjection'), false, viewProjection)
  }

  /**
   * Draws one frame into an offscreen target and reads it back as straight RGBA8, top row
   * first.
   *
   * The live view is untouched: the capture goes through its own camera into its own
   * framebuffer, and the canvas still holds whatever the last frame put there. What it does
   * cost is the gather - a capture culls against a different rectangle, so the next live frame
   * re-gathers rather than reusing the cache. That is a screenshot's fair price.
   *
   * The framebuffer is unbound in a finally, so a throw mid-draw cannot leave the renderer
   * pointing at the offscreen target and every subsequent frame invisible.
   */
  capture(plan: CapturePlan): Uint8ClampedArray {
    if (!this.captureTarget) this.captureTarget = new GlCaptureTarget(this.gl)
    const target = this.captureTarget
    try {
      target.bind(plan.pixelWidth, plan.pixelHeight)
      this.draw(plan.pixelWidth, plan.pixelHeight, {
        camera: plan.camera,
        viewWidth: plan.viewWidth,
        viewHeight: plan.viewHeight,
        background: plan.background,
      })
      const pixels = new Uint8ClampedArray(target.read().buffer)
      // GL reads bottom row first; an ImageData's first row is its top.
      return flipRows(pixels, plan.pixelWidth, plan.pixelHeight)
    } finally {
      target.unbind()
      // The next live frame draws to the canvas at the canvas's size, and the state cache has
      // no idea the viewport moved under it.
      this.stateCache.invalidate()
    }
  }

  destroy(): void {
    this.captureTarget?.destroy()
    this.meshBatcher.destroy()
    this.textBatcher.destroy()
    this.textProgram.destroy()
    this.imageBatcher.destroy()
    this.imageProgram.destroy()
    this.shadowBatcher.destroy()
    this.shadowProgram.destroy()
    this.shadowAtlas.destroy()
    this.fonts.destroy()
    this.meshOpaque.destroy()
    this.meshTranslucent.destroy()
    this.meshOverlay.destroy()
  }
}
