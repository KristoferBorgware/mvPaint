// The WebGPU render path's entry point - the engine's primary renderer.
//
// Its counterpart is webgl/index.ts, and the two are deliberately the same shape: acquire a
// device, load the font atlases, build a renderer, start a frame loop, and hand back a
// SceneRendererHandle over an EMPTY scene, which the caller then fills. Everything below that line differs completely, and neither
// path knows the other exists; renderer/createSceneRenderer.ts is the only thing that does.

import type { Camera2D } from '../camera/Camera2D'
import type { TransformableNode } from '../shapes/Group'
import type { CreateSceneRendererOptions, SceneRendererHandle } from '../renderer/SceneRendererHandle'
import { CanvasResizer } from '../systems/CanvasResizer'
import { createAtlasBindGroupLayout } from './layouts'
import { DEPTH_FORMAT } from './depthFormat'
import { FontBook } from './FontBook'
import { createGpuContext } from './GpuContext'
import { webGpuImageFactory } from './ImageTexture'
import { FrameRenderer, type FrameContext } from './FrameRenderer'
import { SceneRenderer, SAMPLE_COUNT } from './SceneRenderer'

export { SceneRenderer, SAMPLE_COUNT } from './SceneRenderer'

const WHITE: GPUColor = { r: 1, g: 1, b: 1, a: 1 }

/**
 * Composition root for the WebGPU path: wires the GPU context, resize observer and frame loop
 * (system components) to a SceneRenderer, loads the MSDF font atlases, and starts the render
 * loop on a white background through a 2D orthographic camera, MSAA 4x. Scene content is
 * added afterwards, through the returned handle's `scene`. Throws if WebGPU is unavailable.
 *
 * Applications call createSceneRenderer() (renderer/createSceneRenderer.ts) instead, which
 * comes here first and only falls back if this throws.
 */
export async function createWebGpuSceneRenderer(
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
  const scene = new SceneRenderer(gpu.device, gpu.format, canvas, fontBook, options.camera)
  gpu.device.popErrorScope().then((error) => {
    if (error) {
      console.error('WebGPU pipeline setup error:', error.message)
      options.onDeviceError?.(error.message)
    }
  })

  // One layout for every texture a scene builds, so the image lane can bind any of them
  // without a pipeline change (see webGpuImageFactory).
  const images = webGpuImageFactory(gpu.device, createAtlasBindGroupLayout(gpu.device))


  const resizer = new CanvasResizer(canvas)

  const frameRenderer = new FrameRenderer(
    gpu,
    resizer,
    ({ pass, dt, width, height }: FrameContext) => {
      onFrame?.(dt)
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

  // Backed by a closure variable so the frame loop reads whatever is currently set, and a
  // caller can attach, replace or clear it at any point after construction.
  let onFrame: ((dt: number) => void) | null = null

  return {
    path: 'webgpu',
    get onFrame() {
      return onFrame
    },
    set onFrame(next: ((dt: number) => void) | null) {
      onFrame = next
    },
    images,
    scene: scene.scene,
    // A getter, not a captured reference: setCamera() below can replace it, and a handle
    // holding the camera from construction would keep handing back the old one.
    get camera() {
      return scene.camera
    },
    setCamera(camera: Camera2D | null) {
      scene.setCamera(camera)
    },
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
    localBoundsOf(node: TransformableNode) {
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
    destroy() {
      frameRenderer.stop()
      scene.destroy()
      resizer.dispose()
      gpu.device.destroy()
    },
  }
}
