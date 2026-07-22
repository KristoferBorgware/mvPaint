// SceneRenderer - the 2D shape scene. It builds a Scene tree (root -> camera, root ->
// shapes) and renders by collecting visible shapes in painter order and handing them to
// the mesh renderer (frame uniforms + instance batcher + one mesh pipeline). It does NOT
// own the GPU context, resize observer, or frame loop - those are system components
// wired together by createSceneRenderer() below.

import { Rect } from '../shapes/Rect'
import { Shape } from '../scene/Shape'
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

  private speed = 1 // spin multiplier (radians per second)
  private angle = 0
  private geometryDirty = true
  // Per-rect spin rates, so update() can drive their rotation (transform-only, no rebuild).
  private readonly spins = new Map<Rect, number>()

  constructor(device: GPUDevice, format: GPUTextureFormat, _canvas: HTMLCanvasElement) {
    const frameLayout = createFrameBindGroupLayout(device)
    const objectLayout = createObjectBindGroupLayout(device)
    const pipelineLayout = createMeshPipelineLayout(device, frameLayout, objectLayout)
    this.pipeline = createMeshPipeline(device, format, SAMPLE_COUNT, pipelineLayout)
    this.frameUniforms = new FrameUniforms(device, frameLayout)
    this.batcher = new MeshBatcher(device, objectLayout)

    // 2D orthographic camera looking down -Z, parented to the scene root.
    this.camera = new OrthographicCamera('camera')
    this.camera.active = true
    this.camera.viewHeight = 10
    this.scene.root.addChild(this.camera)

    // Two rects side by side, filled + stroked, spinning about their centers.
    const left = this.scene.root.addChild(
      new Rect({
        name: 'rect-left',
        x: -3,
        y: 0,
        width: 3,
        height: 3,
        fill: [0.9, 0.28, 0.24, 1],
        stroke: [0.5, 0.1, 0.08, 1],
        strokeWidth: 0.25,
      }),
    )
    const right = this.scene.root.addChild(
      new Rect({
        name: 'rect-right',
        x: 2.5,
        y: 0,
        width: 4,
        height: 2.5,
        fill: [0.2, 0.45, 0.9, 1],
        stroke: [0.08, 0.18, 0.5, 1],
        strokeWidth: 0.25,
      }),
    )
    this.spins.set(left, 1)
    this.spins.set(right, -1.4)

    this.scene.refreshActiveCamera()
  }

  setSpeed(next: number): void {
    this.speed = next
  }

  /** Advance the animation clock and each rect's rotation (transform only). */
  update(dt: number): void {
    this.angle += dt * this.speed
    for (const [rect, spinScale] of this.spins) {
      rect.rotation = this.angle * spinScale
    }
  }

  /** Collect visible shapes in painter (traversal) order; index becomes the objectId. */
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

    this.frameUniforms.write(camera.viewProjection(width / height).toGPU(), width, height)

    const shapes = this.collectShapes()
    if (this.geometryDirty) {
      this.batcher.rebuild(shapes)
      this.geometryDirty = false
    }
    this.batcher.updateTransforms(shapes)

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
  camera: OrthographicCamera
  destroy: () => void
}

/**
 * Composition root: wires the GPU context, resize observer and frame loop (system
 * components) to a SceneRenderer, and starts rendering two filled + stroked rects on a
 * white background through a 2D orthographic camera, MSAA 4x. Throws if WebGPU is
 * unavailable.
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
    { clearColor: WHITE, sampleCount: SAMPLE_COUNT }, // no depthFormat: 2D uses draw order
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
