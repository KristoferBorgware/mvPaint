// Rect - a solid-colored rectangle shape (Konva-style). Positioned by its center (x, y)
// in the Z=0 plane, sized by width/height, optionally rotated about its center (Z axis).
// Owns its per-instance uniform (MVP + color) and bind group; shares the unit-quad
// geometry and rect pipeline.

import { Shape } from '../scene/Shape'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Vector3 } from '../math/Vector3'
import type { QuadGeometry } from '../webgpu/QuadGeometry'
import { createRectBindGroup, RECT_COLOR_OFFSET, RECT_UNIFORM_SIZE } from '../webgpu/rectPipeline'

export type RGBA = [number, number, number, number]

export interface RectOptions {
  name?: string
  /** Center position in world units. */
  x?: number
  y?: number
  width?: number
  height?: number
  /** Rotation about the center (radians, about +Z). */
  rotation?: number
  color?: RGBA
}

export class Rect extends Shape {
  x: number
  y: number
  width: number
  height: number
  rotation: number

  private readonly device: GPUDevice
  private readonly geometry: QuadGeometry
  private readonly uniformBuffer: GPUBuffer
  private readonly bindGroup: GPUBindGroup
  private readonly color: Float32Array

  constructor(
    device: GPUDevice,
    pipeline: GPURenderPipeline,
    geometry: QuadGeometry,
    options: RectOptions = {},
  ) {
    super(options.name)
    this.device = device
    this.geometry = geometry
    this.x = options.x ?? 0
    this.y = options.y ?? 0
    this.width = options.width ?? 1
    this.height = options.height ?? 1
    this.rotation = options.rotation ?? 0
    this.color = new Float32Array(options.color ?? [1, 1, 1, 1])

    this.uniformBuffer = device.createBuffer({
      size: RECT_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.bindGroup = createRectBindGroup(device, pipeline, this.uniformBuffer)
  }

  setColor(color: RGBA): void {
    this.color.set(color)
  }

  // Model matrix: translate(center) * rotateZ * scale(w, h) applied to the centered
  // unit quad. Column-vector, so it reads outermost-first (translate, then rotate, scale).
  override localMatrix(): Matrix4x4 {
    return Matrix4x4.translation(new Vector3(this.x, this.y, 0))
      .mul(Matrix4x4.rotationQuaternion(Quaternion.fromAxisAngle(Vector3.unitZ(), this.rotation)))
      .mul(Matrix4x4.scaling(new Vector3(this.width, this.height, 1)))
  }

  override draw(pass: GPURenderPassEncoder, viewProjection: Matrix4x4): void {
    if (!this.visible) return
    const mvp = viewProjection.mul(this.worldMatrix())
    this.device.queue.writeBuffer(this.uniformBuffer, 0, mvp.toGPU() as BufferSource)
    this.device.queue.writeBuffer(this.uniformBuffer, RECT_COLOR_OFFSET, this.color as BufferSource)

    pass.setBindGroup(0, this.bindGroup)
    this.geometry.bind(pass)
    pass.drawIndexed(this.geometry.indexCount)
  }

  override destroy(): void {
    this.uniformBuffer.destroy()
  }
}
