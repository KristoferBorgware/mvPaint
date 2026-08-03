// An offscreen framebuffer to take a screenshot into, on the WebGL2 path.
//
// The drawing-buffer the browser gives the canvas is the wrong target for a capture twice
// over: it is the size of the canvas rather than the size that was asked for, and it holds
// what the user is currently looking at. So a capture renders somewhere else entirely.
//
// AND IT RENDERS WITH 4x MSAA, which the live frame on this path does not. Those two facts fit
// together rather than contradicting: the fallback skips MSAA because it costs on every frame
// on precisely the devices that ended up on the fallback, and a screenshot is taken once. The
// per-frame argument simply does not apply to it, and an exported PNG with stair-stepped edges
// is a poor thing to hand someone. It also brings the two paths' captures into line - the
// WebGPU one has always resolved 4x, being the same target shape as its live frame.
//
// That needs TWO framebuffers, because a multisampled buffer cannot be read directly:
//
//   msaa     multisampled colour + depth renderbuffers - what is drawn into
//   resolve  single-sample colour renderbuffer - what the msaa one is blitted into and what
//            readPixels then reads
//
// Both are kept between captures and resized only when the size changes, because an export
// button is usually pressed more than once and at the same size each time.

/** How many samples a capture asks for. Clamped to the driver's MAX_SAMPLES - see allocate. */
const WANTED_SAMPLES = 4

/** A multisampled render target plus its resolve buffer, sized to one capture and reused. */
export class GlCaptureTarget {
  private msaaFbo: WebGLFramebuffer | null = null
  private msaaColor: WebGLRenderbuffer | null = null
  private msaaDepth: WebGLRenderbuffer | null = null
  private resolveFbo: WebGLFramebuffer | null = null
  private resolveColor: WebGLRenderbuffer | null = null
  private width = 0
  private height = 0
  private samples = 1

  constructor(private readonly gl: WebGL2RenderingContext) {}

  /** How many samples the last bind() actually got, which may be below what it asked for. */
  get sampleCount(): number {
    return this.samples
  }

  /**
   * Binds the multisampled framebuffer at exactly this size, allocating or resizing as needed.
   * Everything drawn until resolve() lands in it rather than on the canvas.
   */
  bind(width: number, height: number): void {
    const { gl } = this
    if (width !== this.width || height !== this.height) {
      this.allocate(width, height)
      this.width = width
      this.height = height
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaaFbo)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      throw new Error(`Capture failed: the offscreen framebuffer is incomplete (0x${status.toString(16)}).`)
    }
  }

  /**
   * Resolves the multisampled colour into the single-sample buffer and reads it back as
   * straight RGBA8.
   *
   * The blit IS the resolve - averaging the samples down to one per pixel is what
   * blitFramebuffer does when the read framebuffer is multisampled and the draw one is not. It
   * has to be NEAREST: a multisample resolve rejects LINEAR, and there is no scaling here for a
   * filter to have an opinion about anyway.
   *
   * The rows come out BOTTOM first - GL reads from the lower-left corner up - and are turned
   * the right way up by the caller (see render/capture.ts's flipRows), which is the single
   * place this path's orientation differs from WebGPU's.
   */
  resolveAndRead(): Uint8Array {
    const { gl } = this
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaaFbo)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolveFbo)
    // Scissor is off (draw() disables it), so nothing clips the blit to less than the target.
    gl.blitFramebuffer(
      0, 0, this.width, this.height,
      0, 0, this.width, this.height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    )

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.resolveFbo)
    const pixels = new Uint8Array(this.width * this.height * 4)
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    return pixels
  }

  /** Back to the canvas, on every binding point. Always call this, including after a throw. */
  unbind(): void {
    const { gl } = this
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  destroy(): void {
    const { gl } = this
    if (this.msaaFbo) gl.deleteFramebuffer(this.msaaFbo)
    if (this.msaaColor) gl.deleteRenderbuffer(this.msaaColor)
    if (this.msaaDepth) gl.deleteRenderbuffer(this.msaaDepth)
    if (this.resolveFbo) gl.deleteFramebuffer(this.resolveFbo)
    if (this.resolveColor) gl.deleteRenderbuffer(this.resolveColor)
    this.msaaFbo = null
    this.msaaColor = null
    this.msaaDepth = null
    this.resolveFbo = null
    this.resolveColor = null
    this.width = 0
    this.height = 0
  }

  private allocate(width: number, height: number): void {
    const { gl } = this
    this.destroy()

    // Asked for, not assumed. MAX_SAMPLES is at least 4 on any conformant WebGL2
    // implementation, but a software rasterizer or a constrained driver can report less, and
    // renderbufferStorageMultisample fails outright rather than rounding down.
    this.samples = Math.max(1, Math.min(WANTED_SAMPLES, gl.getParameter(gl.MAX_SAMPLES) as number))

    // --- the multisampled target, which is what actually gets drawn into ---
    this.msaaFbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaaFbo)

    // RGBA8 rather than the canvas's format, so a capture always has an alpha channel to put a
    // transparent background in even when the canvas itself is opaque.
    this.msaaColor = gl.createRenderbuffer()
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msaaColor)
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.RGBA8, width, height)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.msaaColor)

    // The scene resolves its stacking through depth, so a capture needs one exactly as much as
    // the live frame does - without it the two passes would draw in the right order but reject
    // nothing, and an opaque shape would stop hiding what is behind it. Its sample count must
    // match the colour attachment's or the framebuffer is incomplete.
    this.msaaDepth = gl.createRenderbuffer()
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msaaDepth)
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT24, width, height)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.msaaDepth)

    // --- the single-sample buffer the resolve lands in, and the only one readPixels can read ---
    this.resolveFbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.resolveFbo)
    this.resolveColor = gl.createRenderbuffer()
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.resolveColor)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.resolveColor)

    gl.bindRenderbuffer(gl.RENDERBUFFER, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }
}
