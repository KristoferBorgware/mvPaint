// A single drawable cube instance: its own transform, uniform buffer and bind group,
// sharing geometry and pipeline with any other cubes in the scene.

import type { CubeGeometry } from './CubeGeometry'
import { createCubeBindGroup, UNIFORM_SIZE } from './pipeline'
import { multiply, rotationX, rotationY, translation, type Mat4 } from './mat4'

export interface CubeOptions {
  /** World-space position of the cube's center. */
  position?: [number, number, number]
  /** Multiplier applied to this cube's spin, letting cubes rotate at different rates. */
  spinScale?: number
}

/**
 * Represents one cube in the scene. Owns per-instance GPU resources (uniform buffer,
 * bind group) but relies on shared {@link CubeGeometry} and pipeline for drawing.
 */
export class Cube {
  private readonly device: GPUDevice
  private readonly geometry: CubeGeometry
  private readonly uniformBuffer: GPUBuffer
  private readonly bindGroup: GPUBindGroup
  private readonly position: [number, number, number]
  private readonly spinScale: number

  constructor(
    device: GPUDevice,
    pipeline: GPURenderPipeline,
    geometry: CubeGeometry,
    options: CubeOptions = {},
  ) {
    this.device = device
    this.geometry = geometry
    this.position = options.position ?? [0, 0, 0]
    this.spinScale = options.spinScale ?? 1

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.bindGroup = createCubeBindGroup(device, pipeline, this.uniformBuffer)
  }

  /** Local model matrix for this cube at the given spin angle. */
  private modelMatrix(angle: number): Mat4 {
    const spin = angle * this.spinScale
    const rotation = multiply(rotationY(spin), rotationX(spin * 0.6))
    const [x, y, z] = this.position
    return multiply(translation(x, y, z), rotation)
  }

  /**
   * Uploads this cube's MVP uniform and records its draw call onto the pass.
   * `viewProjection` is the shared camera matrix; `angle` drives the spin.
   */
  draw(pass: GPURenderPassEncoder, viewProjection: Mat4, angle: number): void {
    const mvp = multiply(viewProjection, this.modelMatrix(angle))
    this.device.queue.writeBuffer(this.uniformBuffer, 0, mvp as BufferSource)

    pass.setBindGroup(0, this.bindGroup)
    this.geometry.bind(pass)
    pass.drawIndexed(this.geometry.indexCount)
  }

  destroy(): void {
    this.uniformBuffer.destroy()
  }
}
