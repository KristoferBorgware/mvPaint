// SceneRenderer - the 2D shape scene. It builds a Scene tree (root -> camera, root ->
// rect shapes) and drives updates and rendering by traversing that graph. It does NOT
// own the GPU context, the resize observer, or the frame loop - those are system
// components (see src/systems), wired together by createSceneRenderer() below.

import { QuadGeometry } from './QuadGeometry'
import { createRectPipeline } from './rectPipeline'
import { Rect } from '../shapes/Rect'
import { Shape } from '../scene/Shape'
import { OrthographicCamera } from '../camera/OrthographicCamera'
import { Scene } from '../scene/Scene'
import { createGpuContext } from '../systems/GpuContext'
import { CanvasResizer } from '../systems/CanvasResizer'
import { FrameRenderer, type FrameContext } from '../systems/FrameRenderer'

const WHITE: GPUColor = { r: 1, g: 1, b: 1, a: 1 }

export class SceneRenderer {
  /** The scene graph: root -> camera, root -> rect shapes. */
  readonly scene = new Scene()
  /** The active 2D orthographic camera (looks down -Z; X right, Y up). */
  readonly camera: OrthographicCamera

  private readonly geometry: QuadGeometry
  private readonly pipeline: GPURenderPipeline

  private speed = 1 // spin multiplier (radians per second)
  private angle = 0
  // Per-rect spin rates, keyed by the shape, so update() can drive their rotation.
  private readonly spins = new Map<Rect, number>()

  constructor(device: GPUDevice, format: GPUTextureFormat, _canvas: HTMLCanvasElement) {
    this.geometry = new QuadGeometry(device)
    this.pipeline = createRectPipeline(device, format)

    // 2D orthographic camera looking down -Z, parented to the scene root.
    this.camera = new OrthographicCamera('camera')
    this.camera.active = true
    this.camera.viewHeight = 10
    this.scene.root.addChild(this.camera)

    // Two rects side by side, spinning about their centers at different rates.
    const left = this.scene.root.addChild(
      new Rect(device, this.pipeline, this.geometry, {
        name: 'rect-left',
        x: -3,
        y: 0,
        width: 3,
        height: 3,
        color: [0.9, 0.28, 0.24, 1],
      }),
    )
    const right = this.scene.root.addChild(
      new Rect(device, this.pipeline, this.geometry, {
        name: 'rect-right',
        x: 2.5,
        y: 0,
        width: 4,
        height: 2.5,
        color: [0.2, 0.45, 0.9, 1],
      }),
    )
    this.spins.set(left, 1)
    this.spins.set(right, -1.4)

    this.scene.refreshActiveCamera()
  }

  setSpeed(next: number): void {
    this.speed = next
  }

  /** Advance the animation clock and each rect's rotation by dt seconds. */
  update(dt: number): void {
    this.angle += dt * this.speed
    for (const [rect, spinScale] of this.spins) {
      rect.rotation = this.angle * spinScale
    }
  }

  /** Record the scene's draw calls by walking the graph through the active camera. */
  draw(pass: GPURenderPassEncoder, width: number, height: number): void {
    const camera = this.scene.activeCamera
    if (!camera) return

    const viewProjection = camera.viewProjection(width / height)
    pass.setPipeline(this.pipeline)
    this.scene.root.traversePreOrder((node) => {
      if (node instanceof Shape) node.draw(pass, viewProjection)
    })
  }

  destroy(): void {
    this.scene.root.traversePreOrder((node) => {
      if (node instanceof Shape) node.destroy()
    })
    this.geometry.destroy()
  }
}

export interface SceneRendererHandle {
  setSpeed: (speed: number) => void
  camera: OrthographicCamera
  destroy: () => void
}

/**
 * Composition root: wires the GPU context, resize observer and frame loop (system
 * components) to a SceneRenderer, and starts rendering two rects on a white background
 * through a 2D orthographic camera. Throws if WebGPU is unavailable.
 */
export async function createSceneRenderer(canvas: HTMLCanvasElement): Promise<SceneRendererHandle> {
  const gpu = await createGpuContext(canvas)
  const resizer = new CanvasResizer(canvas)
  const scene = new SceneRenderer(gpu.device, gpu.format, canvas)

  const frameRenderer = new FrameRenderer(
    gpu,
    resizer,
    ({ pass, dt, width, height }: FrameContext) => {
      scene.update(dt)
      scene.draw(pass, width, height)
    },
    { clearColor: WHITE }, // no depthFormat: 2D uses draw order
  )
  frameRenderer.start()

  return {
    setSpeed(next: number) {
      scene.setSpeed(next)
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
