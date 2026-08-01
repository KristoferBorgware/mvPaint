// An offscreen framebuffer to take a screenshot into, on the WebGL2 path.
//
// The drawing-buffer the browser gives the canvas is the wrong target for a capture twice
// over: it is the size of the canvas rather than the size that was asked for, and it holds
// what the user is currently looking at. So a capture renders somewhere else entirely - an
// RGBA8 texture plus a depth renderbuffer, which is the same pair the main frame has, only
// owned by us and sized to the request.
//
// It is kept between captures and resized only when the size changes, because an export
// button is usually pressed more than once and at the same size each time. Nothing else in the
// path allocates per-frame either.

/** A colour texture + depth buffer sized to one capture, reused across captures. */
export class GlCaptureTarget {
  private framebuffer: WebGLFramebuffer | null = null
  private colorTexture: WebGLTexture | null = null
  private depthBuffer: WebGLRenderbuffer | null = null
  private width = 0
  private height = 0

  constructor(private readonly gl: WebGL2RenderingContext) {}

  /**
   * Binds a framebuffer of exactly this size, allocating or resizing as needed. Everything
   * drawn until unbind() lands in it rather than on the canvas.
   */
  bind(width: number, height: number): void {
    const { gl } = this
    if (!this.framebuffer) this.framebuffer = gl.createFramebuffer()

    if (width !== this.width || height !== this.height) {
      this.allocate(width, height)
      this.width = width
      this.height = height
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      throw new Error(`Capture failed: the offscreen framebuffer is incomplete (0x${status.toString(16)}).`)
    }
  }

  /**
   * Reads the whole target back as straight RGBA8.
   *
   * The rows come out BOTTOM first - GL reads from the lower-left corner up - and are turned
   * the right way up by the caller (see render/capture.ts's flipRows), which is the single
   * place this path's orientation differs from WebGPU's.
   */
  read(): Uint8Array {
    const { gl } = this
    const pixels = new Uint8Array(this.width * this.height * 4)
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    return pixels
  }

  /** Back to the canvas. Always call this, including after a throw. */
  unbind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null)
  }

  destroy(): void {
    const { gl } = this
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer)
    if (this.colorTexture) gl.deleteTexture(this.colorTexture)
    if (this.depthBuffer) gl.deleteRenderbuffer(this.depthBuffer)
    this.framebuffer = null
    this.colorTexture = null
    this.depthBuffer = null
    this.width = 0
    this.height = 0
  }

  private allocate(width: number, height: number): void {
    const { gl } = this
    if (this.colorTexture) gl.deleteTexture(this.colorTexture)
    if (this.depthBuffer) gl.deleteRenderbuffer(this.depthBuffer)

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)

    // RGBA8 rather than the canvas's format, so a capture always has an alpha channel to put a
    // transparent background in even when the canvas itself is opaque.
    this.colorTexture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    // NEAREST and CLAMP purely for texture completeness - nothing ever samples this.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.colorTexture, 0)

    // The scene resolves its stacking through depth, so a capture needs one exactly as much as
    // the live frame does - without it the two passes would draw in the right order but reject
    // nothing, and an opaque shape would stop hiding what is behind it.
    this.depthBuffer = gl.createRenderbuffer()
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuffer)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthBuffer)

    gl.bindTexture(gl.TEXTURE_2D, null)
    gl.bindRenderbuffer(gl.RENDERBUFFER, null)
  }
}
