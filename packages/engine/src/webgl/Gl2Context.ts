// Getting a WebGL2 context, and saying clearly what is missing when there isn't one.
//
// This is the fallback's counterpart to systems/GpuContext.ts, and the shape of the two is
// deliberately similar: acquire, check, or throw a sentence a person can act on. A renderer
// that half-starts and then draws nothing is the failure mode both are written to avoid.
//
// WebGL2 specifically, never WebGL1. The whole design rests on looking a per-object record up
// by an integer carried in the vertex stream, and WebGL1 has no integer vertex attributes, no
// texelFetch and no array textures - it could not draw this scene without being a third,
// different renderer. A machine with neither WebGPU nor WebGL2 gets the honest answer.

/** What the fallback's lanes are handed: the context, and the canvas it belongs to. */
export interface Gl2Context {
  gl: WebGL2RenderingContext
  canvas: HTMLCanvasElement
  /** gl.MAX_TEXTURE_SIZE - the ceiling on the object data texture and any atlas. */
  maxTextureSize: number
}

export function createGl2Context(canvas: HTMLCanvasElement): Gl2Context {
  const gl = canvas.getContext('webgl2', {
    // The scene is composited over the page, and every lane blends straight-alpha, so the
    // drawing buffer holds straight alpha too.
    alpha: true,
    premultipliedAlpha: false,
    // MSAA is off on this path (see the module header in webgl/index.ts): asking the browser
    // for a multisampled drawing buffer would cost the memory and the resolve without the
    // renderer ever driving it.
    antialias: false,
    depth: true,
    stencil: false,
    // The frame is redrawn from scratch every tick, so nothing is ever read back out of the
    // previous one. Letting the browser discard it is free.
    preserveDrawingBuffer: false,
    desynchronized: true,
    powerPreference: 'high-performance',
  })

  if (!gl) {
    throw new Error('WebGL2 is not supported in this browser.')
  }

  return {
    gl,
    canvas,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
  }
}
