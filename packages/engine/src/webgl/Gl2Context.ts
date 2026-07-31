// Getting a WebGL2 context, and saying clearly what is missing when there isn't one.
//
// This is the fallback's counterpart to webgpu/GpuContext.ts, and the shape of the two is
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
    alpha: true,
    // Left at the default, deliberately. The renderer clears to opaque white and every lane's
    // blend leaves the destination alpha at 1, so the drawing buffer is opaque either way and
    // the two settings are indistinguishable - which makes the default, far better trodden
    // through mobile compositors, the only sensible choice.
    // premultipliedAlpha: true
    //
    // MSAA is off on this path (see webgl/index.ts): asking the browser for a multisampled
    // drawing buffer would cost the memory and the resolve without the renderer driving it.
    antialias: false,
    depth: true,
    stencil: false,
    // The frame is redrawn from scratch every tick, so nothing is read back out of the
    // previous one. Letting the browser discard it is free.
    preserveDrawingBuffer: false,
    // NOT desynchronized. The low-latency present path is worth nothing to a renderer that
    // draws on rAF anyway, and on several Android devices it composites a blank canvas - a
    // failure that costs a black screen and shows up nowhere in the console.
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
