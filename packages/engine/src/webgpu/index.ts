// The WebGPU render path's entry point - the engine's primary renderer.
//
// Its counterpart is webgl/index.ts, and the two are deliberately the same shape: acquire a
// device, load the font atlases, build a renderer, start a frame loop, and hand back a
// SceneRendererHandle over an EMPTY scene, which the caller then fills. Everything below that line differs completely, and neither
// path knows the other exists; systems/createSceneRenderer.ts is the only thing that does.

import type { Camera2D } from '../camera/Camera2D'
import type { TransformableNode } from '../shapes/Group'
import type { CaptureOptions, CreateSceneRendererOptions, SceneRendererHandle } from '../systems/SceneRendererHandle'
import { engineOwnsCanvas, resolveCanvas, type CanvasTarget } from '../systems/canvasTarget'
import { createFrameListeners } from '../systems/frameListeners'
import { attachSceneInput, type SceneInput } from '../input/sceneInput'
import { CanvasResizer } from '../systems/CanvasResizer'
import { createAtlasBindGroupLayout } from './layouts'
import { DEPTH_FORMAT } from './depthFormat'
import { GpuCaptureTarget } from './CaptureTarget'
import { blobToDataURL, encodeCanvas, pixelsToCanvas, resolveCapture } from '../render/capture'
import { MSDFFontLibrary } from './MSDFFontLibrary'
import { createGpuContext } from './GpuContext'
import { gpuImageFactory } from './ImageTexture'
import { cachingImageFactory } from '../resources/cachingImageFactory'
import { ResourceCache } from '../resources/ResourceCache'
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
 * Applications call createSceneRenderer() (systems/createSceneRenderer.ts) instead, which
 * comes here first and only falls back if this throws.
 */
export async function createWebGpuSceneRenderer(
  target?: CanvasTarget,
  options: CreateSceneRendererOptions = {},
): Promise<SceneRendererHandle> {
  // A no-op when the caller already has the element, which is what createSceneRenderer passes
  // down - so nothing is ever queried, or created, twice.
  const canvas = resolveCanvas(target)
  const gpu = await createGpuContext(canvas, { powerPreference: options.powerPreference })

  // Surface asynchronous device (validation) errors - an invalid pipeline or a bad
  // draw does not throw; it just poisons the command buffer and the canvas stays blank.
  gpu.device.addEventListener('uncapturederror', (event) => {
    const message = (event as GPUUncapturedErrorEvent).error.message
    console.error('WebGPU device error:', message)
    options.onDeviceError?.(message)
  })

  // The library takes its atlases from the font registry and keeps taking them - nothing about
  // fonts reaches this function. A family registered before this device existed is uploaded here;
  // one registered afterwards arrives on its own. See resources/FontRegistry.
  const fonts = await MSDFFontLibrary.load(gpu.device)

  // Catch the most common startup failure - an invalid render pipeline built from a
  // shader/layout mismatch - which is created inside the SceneRenderer constructor.
  gpu.device.pushErrorScope('validation')
  const scene = new SceneRenderer(gpu.device, gpu.format, canvas, fonts, options.camera)
  gpu.device.popErrorScope().then((error) => {
    if (error) {
      console.error('WebGPU pipeline setup error:', error.message)
      options.onDeviceError?.(error.message)
    }
  })

  // One layout for every texture a scene builds, so the image lane can bind any of them
  // without a pipeline change (see gpuImageFactory) - and one cache in front of it, so a
  // picture two nodes want is fetched, decoded and uploaded once (see cachingImageFactory).
  // The cache belongs to this renderer because its textures belong to this device.
  const images = cachingImageFactory(gpuImageFactory(gpu.device, createAtlasBindGroupLayout(gpu.device)), new ResourceCache())


  const resizer = new CanvasResizer(canvas)

  // The application's slot, then the engine's own per-frame work (the selection frame refits
  // from whatever the animation above just moved). See systems/frameListeners.ts.
  const frames = createFrameListeners()

  const frameRenderer = new FrameRenderer(
    gpu,
    resizer,
    ({ pass, dt, width, height }: FrameContext) => {
      onFrame?.(dt)
      frames.run(dt)
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

  // Allocated on the first capture - most sessions never take one - and torn down with the
  // renderer.
  let captureTarget: GpuCaptureTarget | null = null

  // A free function rather than a method, so toDataURL/toBlob can call it without reaching
  // through `this` - the handle is a plain object literal and has no useful one.
  const captureToCanvas = async (captureOptions?: CaptureOptions): Promise<HTMLCanvasElement> => {
    const plan = resolveCapture(captureOptions ?? {}, scene.camera, {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    })
    captureTarget ??= new GpuCaptureTarget(gpu.device, gpu.format, DEPTH_FORMAT, SAMPLE_COUNT)

    // WebGPU reports almost nothing by throwing. An invalid texture, an incompatible
    // attachment or a bad copy all produce a silently invalid object and an ASYNCHRONOUS error,
    // and the first sign of it downstream is a mapAsync that rejects or a buffer full of
    // zeroes. An error scope is the only way to get the sentence the implementation actually
    // wrote, and a capture is a once-per-click operation that can easily afford one.
    gpu.device.pushErrorScope('validation')
    gpu.device.pushErrorScope('out-of-memory')

    let pixels: Uint8ClampedArray | null = null
    let failure: unknown = null
    try {
      const encoder = gpu.device.createCommandEncoder()
      // Baking needs render passes of its own and has to finish before the capture pass opens -
      // the same ordering the live frame gets from FrameRenderer's onPrePass hook.
      scene.prepareShadows(encoder)

      const pass = encoder.beginRenderPass({
        colorAttachments: [captureTarget.colorAttachment(plan)],
        depthStencilAttachment: captureTarget.depthAttachment(),
      })
      scene.draw(pass, plan.pixelWidth, plan.pixelHeight, {
        camera: plan.camera,
        viewWidth: plan.viewWidth,
        viewHeight: plan.viewHeight,
        background: plan.background,
      })
      pass.end()
      captureTarget.copyOut(encoder)
      gpu.device.queue.submit([encoder.finish()])

      pixels = await captureTarget.read()
    } catch (cause) {
      // Held rather than rethrown here: the error scopes have to be popped in either case, and
      // what they carry is usually a better explanation than the exception itself.
      failure = cause
    }

    // Popped innermost first, and both always, or the stack is left unbalanced for every later
    // capture.
    const oom = await gpu.device.popErrorScope()
    const validation = await gpu.device.popErrorScope()
    const reported = validation ?? oom
    if (reported) {
      throw new Error(`Capture failed: ${reported.message}`)
    }
    if (failure) throw failure
    if (!pixels) throw new Error('Capture failed: the readback produced no pixels.')

    return pixelsToCanvas(pixels, plan.pixelWidth, plan.pixelHeight)
  }

  // Assigned once the handle exists, because the bindings are built ON it - see below.
  let input: SceneInput | null = null

  const handle: SceneRendererHandle = {
    path: 'webgpu',
    adapter: gpu.adapter,
    get onFrame() {
      return onFrame
    },
    set onFrame(next: ((dt: number) => void) | null) {
      onFrame = next
    },
    addFrameListener: frames.add,
    get input() {
      return input
    },
    images,
    scene: scene.scene,
    msdfFonts: fonts,
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
    pickAll(screenX: number, screenY: number) {
      return scene.pickAll(screenX, screenY)
    },
    localBoundsOf(node: TransformableNode) {
      return scene.localBoundsOf(node)
    },
    nodesInBox(from, to, options) {
      return scene.nodesInBox(from, to, options)
    },
    toCanvas: captureToCanvas,
    async toDataURL(captureOptions) {
      const blob = await encodeCanvas(
        await captureToCanvas(captureOptions),
        captureOptions?.mimeType,
        captureOptions?.quality,
      )
      return await blobToDataURL(blob)
    },
    async toBlob(captureOptions) {
      return await encodeCanvas(
        await captureToCanvas(captureOptions),
        captureOptions?.mimeType,
        captureOptions?.quality,
      )
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
      input?.destroy()
      input = null
      captureTarget?.destroy()
      frameRenderer.stop()
      scene.destroy()
      resizer.dispose()
      gpu.device.destroy()
      // A canvas the ENGINE built has no other reference anywhere - the caller never asked
      // for it and cannot clean it up - so leaving it behind would strand an element, and a
      // dead GPU context, per renderer. One the caller supplied is left exactly as it was.
      if (engineOwnsCanvas(canvas)) canvas.remove()
    },
  }

  // Last, and only if asked for: the pointer/keyboard bindings need the finished handle to
  // pick, project and measure through. Nothing at all is listened for without the option.
  input = attachSceneInput(handle, canvas, options.input)

  return handle
}
