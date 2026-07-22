// SceneRenderer - the cube-and-camera scene. It owns the cube geometry/pipeline/
// instances and the free-fly camera + input, and knows how to advance them and record
// their draw calls into a render pass. It does NOT own the GPU context, the resize
// observer, or the frame loop - those are system components (see src/systems), wired
// together by createSceneRenderer() below.

import { CubeGeometry } from './CubeGeometry'
import { createCubePipeline, DEPTH_FORMAT } from './pipeline'
import { Cube } from './Cube'
import { FreeFloatCamera } from '../camera/FreeFloatCamera'
import { FreeFlyController } from '../camera/FreeFlyController'
import { Vector3 } from '../math/Vector3'
import { createGpuContext } from '../systems/GpuContext'
import { CanvasResizer } from '../systems/CanvasResizer'
import { FrameRenderer, type FrameContext } from '../systems/FrameRenderer'

export class SceneRenderer {
  /** The active free-fly camera, e.g. to read/adjust pose or FOV. */
  readonly camera: FreeFloatCamera

  private readonly geometry: CubeGeometry
  private readonly pipeline: GPURenderPipeline
  private readonly cubes: Cube[]
  private readonly controller: FreeFlyController

  private speed = 1 // radians per second multiplier
  private angle = 0

  constructor(device: GPUDevice, format: GPUTextureFormat, canvas: HTMLCanvasElement) {
    // Shared, reusable cube resources.
    this.geometry = new CubeGeometry(device)
    this.pipeline = createCubePipeline(device, format)

    // Two cubes next to each other, spinning at slightly different rates.
    this.cubes = [
      new Cube(device, this.pipeline, this.geometry, { position: [-2.2, 0, 0], spinScale: 1 }),
      new Cube(device, this.pipeline, this.geometry, { position: [2.2, 0, 0], spinScale: -1.4 }),
    ]

    // Default camera: an FPS free-fly camera looking down -Z at the cubes. WASD to move,
    // right-mouse to look, wheel / middle-mouse to zoom (see FreeFlyController).
    this.camera = new FreeFloatCamera()
    this.camera.active = true
    this.camera.eye = new Vector3(0, 0, 9)
    this.camera.fovY = (60 * Math.PI) / 180
    this.controller = new FreeFlyController(canvas, this.camera)
  }

  setSpeed(next: number): void {
    this.speed = next
  }

  /** Advance the camera (from input) and the cube spin by dt seconds. */
  update(dt: number): void {
    this.controller.update(dt)
    this.angle += dt * this.speed
  }

  /** Record the scene's draw calls into an open render pass. */
  draw(pass: GPURenderPassEncoder, width: number, height: number): void {
    const viewProjection = this.camera.viewProjection(width / height)
    pass.setPipeline(this.pipeline)
    for (const cube of this.cubes) {
      cube.draw(pass, viewProjection, this.angle)
    }
  }

  destroy(): void {
    this.controller.dispose()
    for (const cube of this.cubes) {
      cube.destroy()
    }
    this.geometry.destroy()
  }
}

export interface SceneRendererHandle {
  setSpeed: (speed: number) => void
  camera: FreeFloatCamera
  destroy: () => void
}

/**
 * Composition root: wires the GPU context, resize observer and frame loop (system
 * components) to a SceneRenderer, and starts rendering two spinning, vertex-colored
 * cubes viewed through a free-fly camera. Throws if WebGPU is unavailable.
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
    { depthFormat: DEPTH_FORMAT },
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
