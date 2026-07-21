// Scene orchestration: owns the GPU context, shared geometry/pipeline and the
// cube instances, and drives the animation + resize loop. Adding more cubes is
// just a matter of pushing more Cube instances.

import { createGpuContext } from './GpuContext'
import { CubeGeometry } from './CubeGeometry'
import { createCubePipeline, DEPTH_FORMAT } from './pipeline'
import { Cube } from './Cube'
import { FreeFloatCamera } from '../camera/FreeFloatCamera'
import { FreeFlyController } from '../camera/FreeFlyController'
import { Vector3 } from '../math/Vector3'

export interface SceneRendererHandle {
  setSpeed: (speed: number) => void
  /** The active free-fly camera, e.g. to read/adjust pose or FOV. */
  camera: FreeFloatCamera
  destroy: () => void
}

/**
 * Initializes WebGPU on the given canvas and renders two spinning, vertex-colored
 * cubes side by side. Returns a handle to control spin speed and tear everything down.
 * Throws if WebGPU is unavailable.
 */
export async function createSceneRenderer(canvas: HTMLCanvasElement): Promise<SceneRendererHandle> {
  const { device, context, format } = await createGpuContext(canvas)

  // Shared, reusable resources.
  const geometry = new CubeGeometry(device)
  const pipeline = createCubePipeline(device, format)

  // Two cubes next to each other, spinning at slightly different rates.
  const cubes = [
    new Cube(device, pipeline, geometry, { position: [-2.2, 0, 0], spinScale: 1 }),
    new Cube(device, pipeline, geometry, { position: [2.2, 0, 0], spinScale: -1.4 }),
  ]

  // Default camera: an FPS free-fly camera looking down -Z at the cubes. WASD to move,
  // right-mouse to look, wheel / middle-mouse to zoom (see FreeFlyController).
  const camera = new FreeFloatCamera()
  camera.active = true
  camera.eye = new Vector3(0, 0, 9)
  camera.fovY = (60 * Math.PI) / 180
  const controller = new FreeFlyController(canvas, camera)

  // --- Depth texture (recreated on resize) ---
  let depthTexture: GPUTexture | null = null

  function ensureDepthTexture(width: number, height: number) {
    if (depthTexture && depthTexture.width === width && depthTexture.height === height) {
      return
    }
    depthTexture?.destroy()
    depthTexture = device.createTexture({
      size: [width, height],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
  }

  // --- Resize handling ---
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr))
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    ensureDepthTexture(canvas.width, canvas.height)
  }

  const resizeObserver = new ResizeObserver(() => resize())
  resizeObserver.observe(canvas)
  resize()

  // --- Animation state ---
  let speed = 1 // radians per second multiplier
  let angle = 0
  let lastTime = performance.now()
  let rafId = 0
  let disposed = false

  function frame(now: number) {
    if (disposed) return
    const dt = (now - lastTime) / 1000
    lastTime = now
    angle += dt * speed

    resize()

    // Advance the free-fly camera with this frame's input, then build its
    // view-projection (column-vector: projection * view).
    controller.update(dt)
    const aspect = canvas.width / canvas.height
    const viewProjection = camera.viewProjection(aspect)

    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.07, g: 0.07, b: 0.07, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthTexture!.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    })

    pass.setPipeline(pipeline)
    for (const cube of cubes) {
      cube.draw(pass, viewProjection, angle)
    }
    pass.end()

    device.queue.submit([encoder.finish()])
    rafId = requestAnimationFrame(frame)
  }

  rafId = requestAnimationFrame(frame)

  return {
    setSpeed(next: number) {
      speed = next
    },
    camera,
    destroy() {
      disposed = true
      cancelAnimationFrame(rafId)
      controller.dispose()
      resizeObserver.disconnect()
      depthTexture?.destroy()
      for (const cube of cubes) {
        cube.destroy()
      }
      geometry.destroy()
      device.destroy()
    },
  }
}
