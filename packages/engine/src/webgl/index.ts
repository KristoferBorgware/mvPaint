// The WebGL2 fallback render path - its entry point, and its deletion boundary.
//
// Everything under src/webgl/ exists to draw the same scene on a machine without WebGPU, and
// is expected to be removed once such a machine is rare. Nothing outside this directory
// imports anything inside it except renderer/createSceneRenderer.ts, through one dynamic
// import(), so removing the fallback is removing this directory and that import.
//
// What it shares with the WebGPU path, it shares by using the same pure modules: the gather
// (render/gather.ts), the byte layouts (render/*Format.ts), the draw-order merge, the opacity
// split, the stroker, the shaper, and the whole scene graph. What it does not share is
// anything that touches an API. There is deliberately no device abstraction between them -
// building one would mean shaping the permanent path around the temporary one.
//
// WHERE IT IS VISIBLY DIFFERENT. No MSAA, so mesh edges are aliased (MSDF text will not be -
// it antialiases in the fragment shader). And it targets tens of thousands of objects rather
// than hundreds of thousands: without storage buffers the per-object records go through a
// float texture, which is a slower road to the same architecture.
//
// All four lanes - mesh, text, image and shadow - are implemented. What is missing relative to
// WebGPU is MSAA, and nothing else.

import { CanvasResizer } from '../systems/CanvasResizer'
import type { CreateSceneRendererOptions, SceneRendererHandle } from '../renderer/SceneRendererHandle'
import type { Camera2D } from '../camera/Camera2D'
import type { TransformableNode } from '../shapes/Group'
import { createGl2Context } from './Gl2Context'
import { GlFontBook } from './FontBook'
import { glImageFactory } from './ImageTexture'
import { GlSceneRenderer } from './SceneRenderer'

export { GlImageTexture } from './ImageTexture'

const GL_ERRORS: Record<number, string> = {
  0x0500: 'INVALID_ENUM',
  0x0501: 'INVALID_VALUE',
  0x0502: 'INVALID_OPERATION',
  0x0505: 'OUT_OF_MEMORY',
  0x0506: 'INVALID_FRAMEBUFFER_OPERATION',
  0x9242: 'CONTEXT_LOST_WEBGL',
}

/**
 * The GPU behind this context, when the browser will say.
 *
 * WEBGL_debug_renderer_info is not always exposed - it is fingerprinting surface, and some
 * browsers withhold it - so this is best effort. It exists because the failures this path is
 * most likely to hit are per-driver, and "it is black on my phone" is a much harder report to
 * act on than the same sentence with an Adreno or Mali string attached to it.
 */
function describeRenderer(gl: WebGL2RenderingContext): string {
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    if (info) return String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
  } catch {
    // Withheld; the version string below is always available and still narrows it down.
  }
  return String(gl.getParameter(gl.VERSION))
}

/**
 * Composition root for the WebGL2 path. Applications call createSceneRenderer()
 * (renderer/createSceneRenderer.ts), which comes here only when WebGPU is unavailable or when
 * `backend: 'webgl2'` asks for it deliberately.
 */
export async function createWebGl2SceneRenderer(
  canvas: HTMLCanvasElement,
  options: CreateSceneRendererOptions = {},
): Promise<SceneRendererHandle> {
  const context = createGl2Context(canvas)
  const { gl } = context

  // WebGL has no uncapturederror and no error scopes. What it does have is a context-loss
  // event, which is the one failure that turns a working canvas into a permanently blank one,
  // so it is worth reporting even though nothing here can recover from it.
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    const message = 'The WebGL2 context was lost.'
    console.error(message)
    options.onDeviceError?.(message)
  })

  // Load the MSDF atlases before building the renderer, so the text lane has its texture ready
  // for the first frame rather than showing a page of nothing on the way to showing text.
  const fonts = await GlFontBook.load(gl)

  let scene: GlSceneRenderer
  try {
    // Program links are where a shader/format mismatch shows up, and they happen in here.
    scene = new GlSceneRenderer(context, fonts, options.camera)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    options.onDeviceError?.(message)
    throw cause
  }

  const images = glImageFactory(gl, context.maxTextureSize)

  const resizer = new CanvasResizer(canvas)
  let running = true
  let rafId = 0
  let lastTime = performance.now()

  // One message, however many frames the problem lasts: a per-frame report would bury the
  // first (and only useful) one under sixty a second.
  let reported = false
  const reportOnce = (message: string): void => {
    if (reported) return
    reported = true
    options.onDeviceError?.(message)
  }

  // WebGL has no uncapturederror and no error scopes: an illegal call sets a flag and returns,
  // and the canvas quietly comes out blank. Polling getError() every frame would stall the
  // pipeline, so it is checked exactly ONCE, after the first frame - which is where a device
  // that cannot do something this renderer needs will fail, and where the difference between
  // "black screen" and a sentence naming the problem is worth one synchronous call.
  let checkedFirstFrame = false
  const checkFirstFrame = (): void => {
    if (checkedFirstFrame) return
    checkedFirstFrame = true
    const code = gl.getError()
    if (code === gl.NO_ERROR) return
    const name = GL_ERRORS[code] ?? `0x${code.toString(16)}`
    const renderer = describeRenderer(gl)
    console.error(`WebGL2: the first frame reported ${name} on ${renderer}`)
    reportOnce(`WebGL2 error on the first frame: ${name} (${renderer}).`)
  }

  // The frame loop, which on this path is all there is to a frame: no command encoder to open,
  // no MSAA target to allocate and resolve, and the depth buffer belongs to the drawing buffer
  // the browser already made. Resizing the canvas resizes that buffer with it.
  //
  // The next frame is scheduled BEFORE the work, not after it. Scheduling last means a single
  // throw - on one device, in one lane, on the first frame - ends the loop for good, and a
  // canvas that is never written composites as transparent, which on a dark page is a black
  // screen with nothing in the console to say why. That failure is unacceptable precisely
  // because it is silent, so anything thrown here is caught, reported through onDeviceError
  // (the application shows it) and the loop then stopped deliberately rather than by accident.
  const tick = (now: number): void => {
    if (!running) return
    rafId = requestAnimationFrame(tick)

    const dt = (now - lastTime) / 1000
    lastTime = now
    try {
      resizer.update()
      options.onFrame?.(dt)
      // Baking binds its own framebuffer, so it happens before the frame rather than inside
      // it - the same ordering the WebGPU path gets from its prepass hook.
      scene.prepareShadows()
      scene.draw(resizer.width, resizer.height)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      console.error('WebGL2 render error:', cause)
      reportOnce(`WebGL2 render error: ${message}`)
      running = false
      cancelAnimationFrame(rafId)
      return
    }
    checkFirstFrame()
  }
  rafId = requestAnimationFrame(tick)

  return {
    path: 'webgl2',
    images,
    scene: scene.scene,
    // A getter, not a captured reference: setCamera can replace it, and a handle holding the
    // camera from construction would keep handing back the old one.
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
    nodesInBox(from, to, marqueeOptions) {
      return scene.nodesInBox(from, to, marqueeOptions)
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
      running = false
      cancelAnimationFrame(rafId)
      scene.destroy()
      resizer.dispose()
    },
  }
}
