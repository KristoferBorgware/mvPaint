// SceneRenderer - the 2D shape scene. It builds a Scene tree (root -> camera, root ->
// shapes) and renders by collecting visible shapes in painter order and handing them to
// the mesh renderer (frame uniforms + mesh batcher + one mesh pipeline). It does NOT
// own the GPU context, resize observer, or frame loop - those are system components
// wired together by createSceneRenderer() below.

import { Rect } from '../shapes/Rect'
import { Circle } from '../shapes/Circle'
import { Polyline } from '../shapes/Polyline'
import { Shape } from '../scene/Shape'
import { loadSvgDocument } from '../svg/loadSvg'
import { EXAMPLE_SVG } from '../svg/exampleSvg'
import { OrthographicCamera } from '../camera/OrthographicCamera'
import { Scene } from '../scene/Scene'
import {
  createFrameBindGroupLayout,
  createMeshPipelineLayout,
  createObjectBindGroupLayout,
} from '../render/layouts'
import { FrameUniforms } from '../render/FrameUniforms'
import { MeshBatcher } from '../render/MeshBatcher'
import { createMeshPipeline } from '../render/MeshPipeline'
import { createGpuContext } from '../systems/GpuContext'
import { CanvasResizer } from '../systems/CanvasResizer'
import { FrameRenderer, type FrameContext } from '../systems/FrameRenderer'

const WHITE: GPUColor = { r: 1, g: 1, b: 1, a: 1 }
const SAMPLE_COUNT = 4

export class SceneRenderer {
  /** The scene graph: root -> camera, root -> shapes. */
  readonly scene = new Scene()
  /** The active 2D orthographic camera (looks down -Z; X right, Y up). */
  readonly camera: OrthographicCamera

  private readonly pipeline: GPURenderPipeline
  private readonly frameUniforms: FrameUniforms
  private readonly batcher: MeshBatcher
  private readonly canvas: HTMLCanvasElement

  private speed = 1 // spin multiplier (radians per second)
  private angle = 0
  private zoom = 1 // camera zoom factor: >1 zooms in (shapes larger), <1 zooms out
  private geometryDirty = true
  // Per-rect spin rates, so update() can drive their rotation (transform-only, no rebuild).
  private readonly spins = new Map<Rect, number>()

  constructor(device: GPUDevice, format: GPUTextureFormat, canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const frameLayout = createFrameBindGroupLayout(device)
    const objectLayout = createObjectBindGroupLayout(device)
    const pipelineLayout = createMeshPipelineLayout(device, frameLayout, objectLayout)
    this.pipeline = createMeshPipeline(device, format, SAMPLE_COUNT, pipelineLayout)
    this.frameUniforms = new FrameUniforms(device, frameLayout)
    this.batcher = new MeshBatcher(device, objectLayout)

    // 2D orthographic camera looking down -Z, parented to the scene root. viewHeight is
    // set from the canvas's CSS height every frame (see draw()), so 1 world unit = 1 CSS
    // pixel on every device - device pixel ratio only changes how many physical pixels
    // render each logical one, never the logical (world-unit) size.
    this.camera = new OrthographicCamera('camera')
    this.camera.active = true
    this.scene.root.addChild(this.camera)

    // Two rects side by side, filled + stroked, spinning about their centers. Sized in
    // (now pixel-equivalent) world units.
    const left = this.scene.root.addChild(
      new Rect({
        name: 'rect-left',
        x: -110,
        y: 0,
        width: 160,
        height: 160,
        fill: [0.9, 0.28, 0.24, 1],
        stroke: [0.5, 0.1, 0.08, 1],
        strokeWidth: 6,
      }),
    )
    // Linear gradient across the rect's own diagonal, in its local (pre-transform)
    // space - it moves and rotates with the rect.
    left.fillPriority = 'linear-gradient'
    left.fillLinearGradientStartPoint = { x: -80, y: -80 }
    left.fillLinearGradientEndPoint = { x: 80, y: 80 }
    left.fillLinearGradientColorStops = [
      { offset: 0, color: [1, 0.9, 0.3, 1] },
      { offset: 1, color: [0.9, 0.1, 0.2, 1] },
    ]
    const right = this.scene.root.addChild(
      new Rect({
        name: 'rect-right',
        x: 120,
        y: 0,
        width: 200,
        height: 130,
        fill: [0.2, 0.45, 0.9, 1],
        stroke: [0.08, 0.18, 0.5, 1],
        strokeWidth: 6,
      }),
    )
    this.spins.set(left, 1)
    this.spins.set(right, -1.4)

    // A circle centered between the rects, drawn last so it layers on top (painter order).
    const circle = this.scene.root.addChild(
      new Circle({
        name: 'circle',
        x: 0,
        y: 0,
        radius: 90,
        fill: [0.2, 0.72, 0.36, 1],
        stroke: [0.1, 0.4, 0.2, 1],
        strokeWidth: 6,
      }),
    )
    // Radial gradient from the circle's own center out to its own radius, in local
    // space - a concentric center-to-edge fade.
    circle.fillPriority = 'radial-gradient'
    circle.fillRadialGradientStartPoint = { x: 0, y: 0 }
    circle.fillRadialGradientStartRadius = 0
    circle.fillRadialGradientEndPoint = { x: 0, y: 0 }
    circle.fillRadialGradientEndRadius = 90
    circle.fillRadialGradientColorStops = [
      { offset: 0, color: [0.9, 1, 0.6, 1] },
      { offset: 1, color: [0.1, 0.5, 0.2, 1] },
    ]

    // An open zigzag polyline below the shapes, demonstrating the general contour
    // stroker on a non-rectangular, non-circular path: round join + round caps
    // (Canvas2D-style lineJoin/lineCap, both configurable per-instance).
    this.scene.root.addChild(
      new Polyline({
        name: 'zigzag',
        points: [
          { x: -180, y: -180 },
          { x: -90, y: -120 },
          { x: 0, y: -180 },
          { x: 90, y: -120 },
          { x: 180, y: -180 },
        ],
        stroke: [0.55, 0.35, 0.85, 1],
        strokeWidth: 14,
        lineJoin: 'round',
        lineCap: 'round',
      }),
    )

    // A whole SVG document loaded through the path pipeline: its shapes (gradient-filled
    // ring with a hole, radial-filled stroked circle, stroked open curve) become Path
    // nodes under one container. The root matrix flips Y (SVG is y-down, the scene is
    // y-up) and lifts the 0..200 artwork into the upper-center of the view.
    const svgDoc = loadSvgDocument(EXAMPLE_SVG, { rootMatrix: [1, 0, 0, -1, -100, 280] })
    this.scene.root.addChild(svgDoc)

    this.scene.refreshActiveCamera()
  }

  setSpeed(next: number): void {
    this.speed = next
  }

  /** Camera zoom: >1 zooms in (content appears larger), <1 zooms out. */
  setZoom(next: number): void {
    this.zoom = next > 0 ? next : 1
  }

  /** Advance the animation clock and each rect's rotation (transform only). */
  update(dt: number): void {
    this.angle += dt * this.speed
    for (const [rect, spinScale] of this.spins) {
      rect.rotation = this.angle * spinScale
    }
  }

  /** Collect visible shapes in painter (traversal) order; index becomes the object id. */
  private collectShapes(): Shape[] {
    const shapes: Shape[] = []
    this.scene.root.traversePreOrder((node) => {
      if (node instanceof Shape && node.visible) shapes.push(node)
    })
    return shapes
  }

  /** Update frame uniforms, (re)build geometry if dirty, refresh transforms, one draw. */
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

    const shapes = this.collectShapes()
    if (this.geometryDirty) {
      this.batcher.rebuild(shapes)
      this.geometryDirty = false
    }
    this.batcher.updateObjects(shapes)

    pass.setPipeline(this.pipeline)
    this.batcher.draw(pass, this.frameUniforms.bindGroup)
  }

  destroy(): void {
    this.batcher.destroy()
    this.frameUniforms.destroy()
  }
}

export interface SceneRendererHandle {
  setSpeed: (speed: number) => void
  setZoom: (zoom: number) => void
  camera: OrthographicCamera
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
}

/**
 * Composition root: wires the GPU context, resize observer and frame loop (system
 * components) to a SceneRenderer, and starts rendering the scene (gradient-filled and
 * stroked shapes, plus a stroked polyline) on a white background through a 2D
 * orthographic camera, MSAA 4x. Throws if WebGPU is unavailable.
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

  // Catch the most common startup failure - an invalid render pipeline built from a
  // shader/layout mismatch - which is created inside the SceneRenderer constructor.
  gpu.device.pushErrorScope('validation')
  const scene = new SceneRenderer(gpu.device, gpu.format, canvas)
  gpu.device.popErrorScope().then((error) => {
    if (error) {
      console.error('WebGPU pipeline setup error:', error.message)
      options.onDeviceError?.(error.message)
    }
  })

  const resizer = new CanvasResizer(canvas)

  const frameRenderer = new FrameRenderer(
    gpu,
    resizer,
    ({ pass, dt, width, height }: FrameContext) => {
      scene.update(dt)
      scene.draw(pass, width, height)
    },
    { clearColor: WHITE, sampleCount: SAMPLE_COUNT }, // no depthFormat: 2D uses draw order
  )
  frameRenderer.start()

  return {
    setSpeed(next: number) {
      scene.setSpeed(next)
    },
    setZoom(next: number) {
      scene.setZoom(next)
    },
    camera: scene.camera,
    destroy() {
      frameRenderer.stop()
      scene.destroy()
      resizer.dispose()
      gpu.device.destroy()
    },
  }
}
