// The per-frame render driver: owns the requestAnimationFrame loop, the frame delta
// clock, the (size-tracking) depth texture, and the command-encoder / render-pass
// boilerplate. It knows nothing about cubes or cameras - each frame it opens a render
// pass and hands it to an onFrame callback that records the scene's draw calls.

import type { CanvasResizer } from './CanvasResizer'
import type { GpuContext } from './GpuContext'

/** What a scene receives each frame to update and record its draws. */
export interface FrameContext {
  pass: GPURenderPassEncoder
  /** Seconds since the previous frame. */
  dt: number
  /** Backing-store size in physical pixels (e.g. for aspect ratio). */
  width: number
  height: number
}

export interface FrameRendererOptions {
  clearColor?: GPUColor
  /** Depth attachment format; omit for a color-only pass. Must match the pipeline's. */
  depthFormat?: GPUTextureFormat
}

export class FrameRenderer {
  private readonly gpu: GpuContext
  private readonly resizer: CanvasResizer
  private readonly onFrame: (frame: FrameContext) => void
  private readonly clearColor: GPUColor
  private readonly depthFormat?: GPUTextureFormat

  private depthTexture: GPUTexture | null = null
  private rafId = 0
  private lastTime = 0
  private running = false

  constructor(
    gpu: GpuContext,
    resizer: CanvasResizer,
    onFrame: (frame: FrameContext) => void,
    options: FrameRendererOptions = {},
  ) {
    this.gpu = gpu
    this.resizer = resizer
    this.onFrame = onFrame
    this.clearColor = options.clearColor ?? { r: 0.07, g: 0.07, b: 0.07, a: 1 }
    this.depthFormat = options.depthFormat
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.lastTime = performance.now()
    const loop = (now: number) => {
      if (!this.running) return
      const dt = (now - this.lastTime) / 1000
      this.lastTime = now
      this.renderFrame(dt)
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.rafId)
    this.depthTexture?.destroy()
    this.depthTexture = null
  }

  private ensureDepthTexture(width: number, height: number): void {
    if (!this.depthFormat) return
    if (this.depthTexture && this.depthTexture.width === width && this.depthTexture.height === height) {
      return
    }
    this.depthTexture?.destroy()
    this.depthTexture = this.gpu.device.createTexture({
      size: [width, height],
      format: this.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
  }

  private renderFrame(dt: number): void {
    this.resizer.update()
    const { width, height } = this.resizer
    this.ensureDepthTexture(width, height)

    const encoder = this.gpu.device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.gpu.context.getCurrentTexture().createView(),
          clearValue: this.clearColor,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: this.depthTexture
        ? {
            view: this.depthTexture.createView(),
            depthClearValue: 1.0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          }
        : undefined,
    })

    this.onFrame({ pass, dt, width, height })

    pass.end()
    this.gpu.device.queue.submit([encoder.finish()])
  }
}
