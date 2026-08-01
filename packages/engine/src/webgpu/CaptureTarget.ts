// An offscreen render target to take a screenshot into, on the WebGPU path.
//
// The swapchain is the wrong target for a capture twice over: it is the size of the canvas
// rather than the size that was asked for, and it holds what the user is currently looking at.
// So a capture renders somewhere else - and "somewhere else" here means three textures, not
// one, because the pipelines were built against the canvas's format and sample count and a
// render pass rejects attachments that disagree with them:
//
//   msaa     sampleCount 4, the format the pipelines expect - what is actually drawn into
//   resolve  sampleCount 1, same format, COPY_SRC - what MSAA resolves into and what is read
//   depth    sampleCount 4 - the scene resolves its stacking through depth, so a capture needs
//            one exactly as much as a live frame does
//
// Reading back is then a copy into a buffer and a map. Two details make that less trivial than
// it sounds, and both are handled here: WebGPU requires each row of a texture-to-buffer copy to
// start on a 256-byte boundary, so the buffer is padded and unpadded again; and the canvas's
// preferred format is usually bgra8unorm, so the bytes come back with red and blue the wrong
// way round for an ImageData.

import { paddedBytesPerRow, unpadRows, type CapturePlan } from '../render/capture'

/** Colour + resolve + depth, sized to one capture and reused across captures. */
export class GpuCaptureTarget {
  private msaaTexture: GPUTexture | null = null
  private resolveTexture: GPUTexture | null = null
  private depthTexture: GPUTexture | null = null
  private buffer: GPUBuffer | null = null
  private width = 0
  private height = 0

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly depthFormat: GPUTextureFormat,
    private readonly sampleCount: number,
  ) {}

  /** The colour attachment for a capture pass, allocating or resizing the target as needed. */
  colorAttachment(plan: CapturePlan): GPURenderPassColorAttachment {
    this.ensure(plan.pixelWidth, plan.pixelHeight)
    const [r, g, b, a] = plan.background
    const clearValue = { r, g, b, a }

    // Same shape as the live frame's: draw into the multisampled texture, resolve into the
    // single-sampled one. Without MSAA the resolve texture is the only one and is drawn into
    // directly.
    return this.msaaTexture
      ? {
          view: this.msaaTexture.createView(),
          resolveTarget: this.resolveTexture!.createView(),
          clearValue,
          loadOp: 'clear',
          storeOp: 'store',
        }
      : { view: this.resolveTexture!.createView(), clearValue, loadOp: 'clear', storeOp: 'store' }
  }

  /** The matching depth attachment. Must be on the same pass as the colour one. */
  depthAttachment(): GPURenderPassDepthStencilAttachment {
    return {
      view: this.depthTexture!.createView(),
      depthClearValue: 1.0,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
    }
  }

  /** Queues the texture-to-buffer copy. Call after the pass has ended, before submitting. */
  copyOut(encoder: GPUCommandEncoder): void {
    encoder.copyTextureToBuffer(
      { texture: this.resolveTexture! },
      { buffer: this.buffer!, bytesPerRow: paddedBytesPerRow(this.width) },
      { width: this.width, height: this.height },
    )
  }

  /**
   * Maps the copy buffer and returns straight RGBA8, top row first - ready for an ImageData
   * with no further work.
   *
   * No row flip: WebGPU's NDC +Y lands on a texture's FIRST texel row, which is already the top
   * of the picture. (The WebGL path reads bottom-up and flips - see render/capture.ts.)
   */
  async read(): Promise<Uint8ClampedArray> {
    const bytesPerRow = paddedBytesPerRow(this.width)
    await this.buffer!.mapAsync(GPUMapMode.READ)
    try {
      // Copied out of the mapped range before unmapping - the view the API hands back is only
      // valid while the mapping is, and this data outlives it.
      const padded = new Uint8Array(this.buffer!.getMappedRange().slice(0))
      const pixels = unpadRows(padded, this.width, this.height, bytesPerRow)
      return this.format.startsWith('bgra') ? swapRedBlue(pixels) : pixels
    } finally {
      this.buffer!.unmap()
    }
  }

  destroy(): void {
    this.msaaTexture?.destroy()
    this.resolveTexture?.destroy()
    this.depthTexture?.destroy()
    this.buffer?.destroy()
    this.msaaTexture = null
    this.resolveTexture = null
    this.depthTexture = null
    this.buffer = null
    this.width = 0
    this.height = 0
  }

  private ensure(width: number, height: number): void {
    if (this.resolveTexture && width === this.width && height === this.height) return
    this.destroy()
    this.width = width
    this.height = height

    this.resolveTexture = this.device.createTexture({
      size: [width, height],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
    if (this.sampleCount > 1) {
      this.msaaTexture = this.device.createTexture({
        size: [width, height],
        sampleCount: this.sampleCount,
        format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
    }
    this.depthTexture = this.device.createTexture({
      size: [width, height],
      sampleCount: this.sampleCount,
      format: this.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.buffer = this.device.createBuffer({
      size: paddedBytesPerRow(width) * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
  }
}

/**
 * bgra8unorm to rgba8unorm, in place.
 *
 * getPreferredCanvasFormat() returns bgra8unorm on most desktop platforms, and the pipelines
 * are built for whatever it says - so the capture texture has to use it too, and the bytes come
 * back with the first and third channels swapped relative to what an ImageData means by RGBA.
 */
function swapRedBlue(pixels: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < pixels.length; i += 4) {
    const b = pixels[i]
    pixels[i] = pixels[i + 2]
    pixels[i + 2] = b
  }
  return pixels
}
