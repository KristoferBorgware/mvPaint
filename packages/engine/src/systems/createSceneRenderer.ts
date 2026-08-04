// Which render path draws this canvas.
//
// WebGPU is the engine. WebGL2 is a fallback for machines that do not have it yet, and it is
// meant to go away again - so this file is the whole of the seam between them: one function
// with one branch. Deleting the fallback later is deleting src/webgl/ and the `catch` below.
//
// The fallback is reached through a dynamic import() and never a static one. That is not
// tidiness - it is what keeps a browser that has WebGPU from downloading, parsing or
// executing a single byte of a second renderer it will never use. A bundler splits it into
// its own chunk; the chunk is fetched only if the try block throws.
//
// 'webgl2' is offered as an explicit choice for one reason: a fallback nobody can reach on
// purpose is a fallback nobody tests. On a development machine, every one of which has
// WebGPU, forcing the flag is the only way to see what the other half of the world sees.

import type { CreateSceneRendererOptions, SceneRendererHandle } from './SceneRendererHandle'
import { resolveCanvas, type CanvasTarget } from './canvasTarget'
import { createWebGpuSceneRenderer } from '../webgpu'

/**
 * Creates a renderer for `target`, preferring WebGPU.
 *
 * The target is a canvas element, a CSS selector for one, an element to build one inside, or
 * nothing at all - see canvasTarget.ts. It is resolved HERE, once, before either path is
 * tried, so a fallback after a failed WebGPU attempt draws into the same canvas rather than
 * making a second one.
 *
 * `backend: 'auto'` (the default) tries WebGPU and falls back to WebGL2 if anything about it
 * is missing - no `navigator.gpu`, no adapter, no context. If both fail, the error names both
 * reasons, because "WebGL2 is unavailable" on its own would be a confusing thing to read on a
 * machine the caller expected to use WebGPU.
 *
 * Everything past this call is identical whichever path was taken: the handle is the same
 * interface, the scene graph is the same objects, and picking, culling and z-order give the
 * same answers, and both antialias with 4x MSAA. What differs is how much either will draw
 * before it slows down: the fallback targets tens of thousands of objects rather than hundreds
 * of thousands, since its per-object records go through a float texture rather than a storage
 * buffer.
 */
export async function createSceneRenderer(
  target?: CanvasTarget,
  options: CreateSceneRendererOptions = {},
): Promise<SceneRendererHandle> {
  const canvas = resolveCanvas(target)
  const choice = options.backend ?? 'auto'

  if (choice === 'webgl2') return createFallback(canvas, options)
  if (choice === 'webgpu') return createWebGpuSceneRenderer(canvas, options)

  try {
    return await createWebGpuSceneRenderer(canvas, options)
  } catch (webgpuError) {
    const why = webgpuError instanceof Error ? webgpuError.message : String(webgpuError)
    // Not an error the application needs to see: falling back is the designed behaviour, and
    // `handle.path` is how it can tell. A warning, because it does change what gets drawn.
    console.warn(`WebGPU unavailable (${why}) - falling back to WebGL2.`)
    try {
      return await createFallback(canvas, options)
    } catch (webglError) {
      const alsoWhy = webglError instanceof Error ? webglError.message : String(webglError)
      throw new Error(`This browser supports neither WebGPU (${why}) nor WebGL2 (${alsoWhy}).`)
    }
  }
}

/** The one import of the fallback anywhere in the engine. */
async function createFallback(
  canvas: HTMLCanvasElement,
  options: CreateSceneRendererOptions,
): Promise<SceneRendererHandle> {
  const { createWebGl2SceneRenderer } = await import('../webgl')
  return createWebGl2SceneRenderer(canvas, options)
}
