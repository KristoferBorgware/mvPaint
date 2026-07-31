// The WebGL2 fallback render path - its entry point, and its deletion boundary.
//
// Everything under src/webgl/ exists to draw the same scene on a machine without WebGPU, and
// is expected to be removed once that machine is rare enough. Nothing outside this directory
// imports anything inside it except renderer/createSceneRenderer.ts, through one dynamic
// import(), so removing the fallback is removing this directory and that import.
//
// What it shares with the WebGPU path it shares by being handed the same pure modules: the
// gather (render/gather.ts), the byte layouts (render/*Format.ts), the draw-order merge, the
// opacity split, the stroker, the shadow maths, and the whole scene graph. What it does not
// share is anything that touches an API - buffers, programs, textures, passes - which is why
// there is no device abstraction anywhere in this engine and the WebGPU path is not built
// around one.
//
// NOT IMPLEMENTED YET. The path is landing lane by lane (mesh, then text, then images, then
// shadows); until the first of those arrives this reports the honest thing rather than
// pretending to draw.

import type { CreateSceneRendererOptions, SceneRendererHandle } from '../renderer/SceneRendererHandle'

export async function createWebGl2SceneRenderer(
  _canvas: HTMLCanvasElement,
  _options: CreateSceneRendererOptions = {},
): Promise<SceneRendererHandle> {
  throw new Error('The WebGL2 fallback is not implemented yet.')
}
