// FrameUniforms - owns the group(0) uniform buffer + bind group (camera view-projection
// and viewport resolution). Written once per frame by the renderer.

import { FRAME_RESOLUTION_OFFSET, FRAME_UNIFORM_SIZE } from './meshFormat'

export class FrameUniforms {
  readonly bindGroup: GPUBindGroup

  private readonly device: GPUDevice
  private readonly buffer: GPUBuffer
  private readonly resolution = new Float32Array(2)

  constructor(device: GPUDevice, layout: GPUBindGroupLayout) {
    this.device = device
    this.buffer = device.createBuffer({
      size: FRAME_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.bindGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: this.buffer } }],
    })
  }

  /** `viewProjection` is column-major (Matrix4x4.toGPU()); size is the backing-store px. */
  write(viewProjection: Float32Array, width: number, height: number): void {
    this.device.queue.writeBuffer(this.buffer, 0, viewProjection as BufferSource)
    this.resolution[0] = width
    this.resolution[1] = height
    this.device.queue.writeBuffer(this.buffer, FRAME_RESOLUTION_OFFSET, this.resolution as BufferSource)
  }

  destroy(): void {
    this.buffer.destroy()
  }
}
