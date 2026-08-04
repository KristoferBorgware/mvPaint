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

import { describeAdapter, type GpuPowerPreference, type RendererAdapter } from '../systems/adapter'

/** What the fallback's lanes are handed: the context, and the canvas it belongs to. */
export interface Gl2Context {
  gl: WebGL2RenderingContext
  canvas: HTMLCanvasElement
  /** Which GPU the browser gave us, and what was asked for - see systems/adapter.ts. */
  adapter: RendererAdapter
  /** gl.MAX_TEXTURE_SIZE - the ceiling on the object data texture and any atlas. */
  maxTextureSize: number
  /**
   * How many samples the drawing buffer actually got. 1 means the request for MSAA was not
   * honoured and mesh edges will be aliased - worth reporting rather than guessing at, since
   * `antialias: true` is a hint and some configurations ignore it.
   */
  sampleCount: number
}

export interface Gl2ContextOptions {
  /** Which GPU to ask for. Default 'high-performance' - see systems/adapter.ts. */
  powerPreference?: GpuPowerPreference
}

export function createGl2Context(canvas: HTMLCanvasElement, options: Gl2ContextOptions = {}): Gl2Context {
  const powerPreference = options.powerPreference ?? 'high-performance'
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    // Left at the default, deliberately. The renderer clears to opaque white and every lane's
    // blend leaves the destination alpha at 1, so the drawing buffer is opaque either way and
    // the two settings are indistinguishable - which makes the default, far better trodden
    // through mobile compositors, the only sensible choice.
    // premultipliedAlpha: true
    //
    // MSAA, through the browser's own multisampled drawing buffer rather than a multisampled
    // FBO of our own. Both would give the same picture; this one is free of an extra
    // full-screen blit and an extra colour buffer every frame, because the resolve happens
    // where the compositor was going to touch the buffer anyway.
    //
    // What it costs is the ability to NAME a sample count - the implementation picks, and
    // reports it as gl.SAMPLES. In practice that is 4 everywhere this path runs; a device that
    // offers less gets less rather than nothing, which is the right way round for a fallback.
    // See sampleCount below, which says what was actually granted rather than what was hoped
    // for.
    antialias: true,
    depth: true,
    stencil: false,
    // The frame is redrawn from scratch every tick, so nothing is read back out of the
    // previous one. Letting the browser discard it is free.
    preserveDrawingBuffer: false,
    // NOT desynchronized. The low-latency present path is worth nothing to a renderer that
    // draws on rAF anyway, and on several Android devices it composites a blank canvas - a
    // failure that costs a black screen and shows up nowhere in the console.
    //
    // Which GPU to ask for, on a machine that has more than one - the only lever there is,
    // and the reason the default is not the platform's. See systems/adapter.ts.
    powerPreference,
  })

  if (!gl) {
    throw new Error('WebGL2 is not supported in this browser.')
  }

  const adapter = readAdapter(gl, powerPreference)
  if (adapter.fallback) {
    console.warn(`WebGL2 is running on a software renderer (${describeAdapter(adapter)}).`)
  }

  return {
    gl,
    canvas,
    adapter,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    // Read once, after the context exists: this is what the browser granted, not what was asked
    // for. A context created with antialias: true can still come back single-sampled.
    sampleCount: (gl.getParameter(gl.SAMPLES) as number) || 1,
  }
}

/**
 * What the browser will say about the GPU behind this context.
 *
 * WEBGL_debug_renderer_info is the only way to ask, and it is not always exposed - it is
 * fingerprinting surface, and some browsers withhold it - so this is best effort. When it IS
 * exposed it gives the raw driver string, which is more specific than anything WebGPU will
 * say: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0, D3D11)'.
 *
 * That string is also the only way to spot a software renderer here, since WebGL has no
 * isFallbackAdapter. Matching on the three names that matter is crude, but the alternative is
 * not noticing at all, and a scene drawing correctly at 12fps on SwiftShader looks exactly
 * like a bug in the renderer until somebody thinks to check.
 */
function readAdapter(gl: WebGL2RenderingContext, powerPreference: GpuPowerPreference): RendererAdapter {
  let description = ''
  let vendor = ''
  try {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    if (debugInfo) {
      description = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '')
      vendor = String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) ?? '')
    }
  } catch {
    // Withheld. The masked strings below are always available and still narrow it down.
  }
  if (description.length === 0) description = String(gl.getParameter(gl.RENDERER) ?? '')
  if (vendor.length === 0) vendor = String(gl.getParameter(gl.VENDOR) ?? '')

  const haystack = `${description} ${vendor}`.toLowerCase()
  const fallback = ['swiftshader', 'llvmpipe', 'software', 'microsoft basic'].some((name) =>
    haystack.includes(name),
  )

  return { powerPreference, vendor, architecture: '', device: '', description, fallback }
}
