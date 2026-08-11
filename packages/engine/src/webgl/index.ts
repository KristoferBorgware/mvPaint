// The WebGL2 fallback render path - its entry point, and its deletion boundary.
//
// Everything under src/webgl/ exists to draw the same scene on a machine without WebGPU, and
// is expected to be removed once such a machine is rare. Nothing outside this directory
// imports anything inside it except systems/createSceneRenderer.ts, through one dynamic
// import(), so removing the fallback is removing this directory and that import.
//
// What it shares with the WebGPU path, it shares by using the same pure modules: the gather
// (render/gather.ts), the byte layouts (render/*Format.ts), the draw-order merge, the opacity
// split, the stroker, the shaper, and the whole scene graph. What it does not share is
// anything that touches an API. There is deliberately no device abstraction between them -
// building one would mean shaping the permanent path around the temporary one.
//
// WHERE IT IS DIFFERENT. Not in edge quality: this path antialiases with 4x MSAA as well,
// taken from the browser's own multisampled drawing buffer (antialias: true - see Gl2Context)
// rather than from a multisampled target driven here. The difference is SCALE - it targets tens
// of thousands of objects rather than hundreds of thousands, because without storage buffers
// the per-object records go through a float texture, which is a slower road to the same
// architecture.
//
// All four lanes - mesh, text, image and shadow - are implemented, and nothing is missing
// relative to WebGPU but headroom.
//
// NAMING. Every class in this directory is prefixed Gl - GlSceneRenderer, GlMeshBatcher,
// GlShadowAtlas, GlObjectTexture - while its WebGPU counterpart wears the bare name, and every
// FILE is named for the class it holds. The two paths are deliberate near-copies with the same
// shapes, so a symbol on its own - in an import list, a stack trace, a profile, an editor's
// open-files list - has to say which half of the engine it belongs to. The prefix is that, and
// it is also what lets a test import both at once.
//
// One file, one class, same name, is the rest of it: GlProgram.ts also holds GlStateCache,
// which exists only to serve GlProgram.use() and would be a file of thirty lines on its own.
// Module-private types (Entry, DrawRange) stay bare - they cannot be confused with anything,
// because they cannot be reached. The shader modules are named for their lane and their
// language (mesh.glsl.ts), which is what they are; there is no class in them to be named for.

import { CanvasResizer } from '../systems/CanvasResizer'
import { blobToDataURL, encodeCanvas, pixelsToCanvas, resolveCapture } from '../render/capture'
import { parseColor, type ColorInput } from '../render/color'
import type { CaptureOptions, CreateSceneRendererOptions, SceneRendererHandle } from '../systems/SceneRendererHandle'
import { engineOwnsCanvas, resolveCanvas, type CanvasTarget } from '../systems/canvasTarget'
import { createFrameListeners } from '../systems/frameListeners'
import { attachSceneInput, type SceneInput } from '../input/sceneInput'
import type { Camera2D } from '../camera/Camera2D'
import type { TransformableNode } from '../shapes/Group'
import { createGl2Context } from './Gl2Context'
import { describeAdapter } from '../systems/adapter'
import { GlMSDFFontLibrary } from './GlMSDFFontLibrary'
import { glImageFactory } from './GlImageTexture'
import { cachingImageFactory } from '../resources/cachingImageFactory'
import { ResourceCache } from '../resources/ResourceCache'
import { GlSceneRenderer } from './GlSceneRenderer'

export { GlImageTexture } from './GlImageTexture'

const GL_ERRORS: Record<number, string> = {
  0x0500: 'INVALID_ENUM',
  0x0501: 'INVALID_VALUE',
  0x0502: 'INVALID_OPERATION',
  0x0505: 'OUT_OF_MEMORY',
  0x0506: 'INVALID_FRAMEBUFFER_OPERATION',
  0x9242: 'CONTEXT_LOST_WEBGL',
}

/**
 * Composition root for the WebGL2 path. Applications call createSceneRenderer()
 * (systems/createSceneRenderer.ts), which comes here only when WebGPU is unavailable or when
 * `backend: 'webgl2'` asks for it deliberately.
 */
export async function createWebGl2SceneRenderer(
  target?: CanvasTarget,
  options: CreateSceneRendererOptions = {},
): Promise<SceneRendererHandle> {
  // A no-op when the caller already has the element, which is what createSceneRenderer passes
  // down - so nothing is ever queried, or created, twice.
  const canvas = resolveCanvas(target)
  const context = createGl2Context(canvas, { powerPreference: options.powerPreference })
  const { gl } = context

  // WebGL has no uncapturederror and no error scopes. What it does have is a context-loss
  // event, which is the one failure that turns a working canvas into a permanently blank one,
  // so it is worth reporting even though nothing here can recover from it.
  // Named rather than inline, so destroy() can take it off again. An anonymous one outlives
  // the renderer on a canvas the CALLER supplied - which the engine never removes - so an
  // application that builds and tears down renderers over the same element (switching render
  // path, remounting a component) accumulates one dead listener, and the closure behind it,
  // per cycle.
  const onContextLost = (event: Event): void => {
    event.preventDefault()
    const message = 'The WebGL2 context was lost.'
    console.error(message)
    options.onDeviceError?.(message)
  }
  canvas.addEventListener('webglcontextlost', onContextLost)

  // From the font registry, exactly as the WebGPU path takes them - so a scene draws with the
  // same faces either way, and neither path is told about fonts when it is created.
  const fonts = await GlMSDFFontLibrary.load(gl)

  let scene: GlSceneRenderer
  try {
    // Program links are where a shader/format mismatch shows up, and they happen in here.
    scene = new GlSceneRenderer(context, fonts, options.camera)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    options.onDeviceError?.(message)
    throw cause
  }
  if (options.clearColor) scene.setClearColor(parseColor(options.clearColor))

  // Cached in front, so a picture two nodes want is fetched, decoded and uploaded once. The
  // cache belongs to this renderer because its textures belong to this context.
  const images = cachingImageFactory(glImageFactory(gl, context.maxTextureSize), new ResourceCache())

  const resizer = new CanvasResizer(canvas)
  let running = true
  let rafId = 0
  let lastTime = performance.now()
  // Backed by a closure variable so the frame loop reads whatever is currently set, and a
  // caller can attach, replace or clear it at any point after construction.
  let onFrame: ((dt: number) => void) | null = null
  // The application's slot, then the engine's own per-frame work (the selection frame refits
  // from whatever the animation above just moved). See systems/frameListeners.ts.
  const frames = createFrameListeners()

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
    const renderer = describeAdapter(context.adapter)
    console.error(`WebGL2: the first frame reported ${name} on ${renderer}`)
    reportOnce(`WebGL2 error on the first frame: ${name} (${renderer}).`)
  }

  // The frame loop, which on this path is all there is to a frame: no command encoder to open,
  // no MSAA target to allocate and resolve by hand - the drawing buffer is multisampled and the
  // browser resolves it at composite time - and the depth buffer belongs to that same buffer.
  // Resizing the canvas resizes all of it together.
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
      onFrame?.(dt)
      frames.run(dt)
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

  // A free function rather than a method, so toDataURL/toBlob can call it without reaching
  // through `this` - the handle is a plain object literal and has no useful one.
  const captureToCanvas = async (captureOptions?: CaptureOptions): Promise<HTMLCanvasElement> => {
    const plan = resolveCapture(captureOptions ?? {}, scene.camera, {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    })
    // Baked before the capture for the same reason the frame loop does it: baking binds its own
    // framebuffer, so it cannot happen inside one that is being drawn into.
    scene.prepareShadows()
    const pixels = scene.capture(plan)
    return pixelsToCanvas(pixels, plan.pixelWidth, plan.pixelHeight)
  }

  // Assigned once the handle exists, because the bindings are built ON it - see below.
  let input: SceneInput | null = null

  const handle: SceneRendererHandle = {
    path: 'webgl2',
    adapter: context.adapter,
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
    setClearColor(color: ColorInput) {
      scene.setClearColor(parseColor(color))
    },
    getClearColor() {
      return scene.getClearColor()
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
    nodesInBox(from, to, marqueeOptions) {
      return scene.nodesInBox(from, to, marqueeOptions)
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
      running = false
      cancelAnimationFrame(rafId)
      canvas.removeEventListener('webglcontextlost', onContextLost)
      scene.destroy()
      resizer.dispose()
      // A canvas the ENGINE built has no other reference anywhere - the caller never asked
      // for it and cannot clean it up - so leaving it behind would strand an element, and a
      // dead GL context, per renderer. One the caller supplied is left exactly as it was.
      if (engineOwnsCanvas(canvas)) canvas.remove()
    },
  }

  // Last, and only if asked for: the pointer/keyboard bindings need the finished handle to
  // pick, project and measure through. Nothing at all is listened for without the option.
  input = attachSceneInput(handle, canvas, options.input)

  return handle
}
