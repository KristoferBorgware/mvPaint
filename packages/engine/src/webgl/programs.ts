// Compiling programs, and the pipeline state that comes with them.
//
// WebGPU hands you an immutable pipeline object: shaders, blending and the depth test are
// decided once and selected with a single call. WebGL has none of that - it has a program, and
// a pile of global switches you have to set yourself, in the right order, every time.
//
// So a GlProgram carries its state block with it and `use()` applies it. That gets the
// WebGPU-shaped call site back (bind this pipeline, draw) without pretending WebGL has
// pipelines. The state is DIFFED against what is currently set, because the translucent pass
// switches program on every lane change and re-issuing four or five identical GL calls per
// switch is exactly the kind of cost this path can least afford.
//
// Compile errors are reported rather than swallowed. A WebGL program that fails to link does
// not throw - it just draws nothing - which is the same silent-blank-canvas failure the
// WebGPU path uses error scopes to avoid.

/** Everything a draw needs set that is not the program itself. */
export interface GlState {
  /** Straight-alpha blending, as every lane in this engine uses. Off means "replace". */
  blend: boolean
  depthTest: boolean
  depthWrite: boolean
  /** gl.LEQUAL, or gl.ALWAYS for the overlay pass. */
  depthFunc: number
}

export interface GlProgramOptions {
  label: string
  vertex: string
  fragment: string
  state: GlState
}

/** Applies GL state, skipping whatever already matches. One per context. */
export class GlStateCache {
  private readonly gl: WebGL2RenderingContext
  private current: GlState | null = null
  private currentProgram: WebGLProgram | null = null

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
  }

  /** Forget everything - after any code that sets GL state behind this cache's back. */
  invalidate(): void {
    this.current = null
    this.currentProgram = null
  }

  useProgram(program: WebGLProgram): void {
    if (this.currentProgram === program) return
    this.gl.useProgram(program)
    this.currentProgram = program
  }

  apply(next: GlState): void {
    const gl = this.gl
    const now = this.current

    if (!now || now.blend !== next.blend) {
      if (next.blend) {
        gl.enable(gl.BLEND)
        // Straight (non-premultiplied) alpha, matching every WebGPU pipeline in this engine:
        // colour src-alpha / one-minus-src-alpha, alpha one / one-minus-src-alpha.
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        gl.blendEquation(gl.FUNC_ADD)
      } else {
        gl.disable(gl.BLEND)
      }
    }
    if (!now || now.depthTest !== next.depthTest) {
      if (next.depthTest) gl.enable(gl.DEPTH_TEST)
      else gl.disable(gl.DEPTH_TEST)
    }
    if (!now || now.depthWrite !== next.depthWrite) gl.depthMask(next.depthWrite)
    if (!now || now.depthFunc !== next.depthFunc) gl.depthFunc(next.depthFunc)

    this.current = { ...next }
  }
}

export class GlProgram {
  readonly program: WebGLProgram
  readonly state: GlState

  private readonly gl: WebGL2RenderingContext
  private readonly cache: GlStateCache
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>()

  constructor(gl: WebGL2RenderingContext, cache: GlStateCache, options: GlProgramOptions) {
    this.gl = gl
    this.cache = cache
    this.state = options.state
    this.program = link(gl, options)
  }

  /** Cached because getUniformLocation is a string lookup and this runs per draw. */
  uniform(name: string): WebGLUniformLocation | null {
    const known = this.uniforms.get(name)
    if (known !== undefined) return known
    const location = this.gl.getUniformLocation(this.program, name)
    this.uniforms.set(name, location)
    return location
  }

  /** Bind this program and its state block, skipping whatever is already current. */
  use(): void {
    this.cache.useProgram(this.program)
    this.cache.apply(this.state)
  }

  destroy(): void {
    this.gl.deleteProgram(this.program)
  }
}

function link(gl: WebGL2RenderingContext, options: GlProgramOptions): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, options.vertex, `${options.label}:vertex`)
  const fs = compile(gl, gl.FRAGMENT_SHADER, options.fragment, `${options.label}:fragment`)
  const program = gl.createProgram()
  if (!program) throw new Error(`${options.label}: could not create a program`)
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  // Safe to drop once linked: the program holds its own reference to the compiled code.
  gl.deleteShader(vs)
  gl.deleteShader(fs)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? '(no log)'
    gl.deleteProgram(program)
    throw new Error(`${options.label}: program did not link - ${log}`)
  }
  return program
}

function compile(gl: WebGL2RenderingContext, type: number, source: string, label: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error(`${label}: could not create a shader`)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '(no log)'
    gl.deleteShader(shader)
    // The line numbers in the log refer to the generated source, so hand it over with the
    // source attached - these shaders are assembled from format constants and there is no
    // file on disk to go and look at.
    throw new Error(`${label}: did not compile - ${log}\n${numbered(source)}`)
  }
  return shader
}

function numbered(source: string): string {
  return source
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
    .join('\n')
}
