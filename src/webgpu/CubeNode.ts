// CubeNode - a cube as a scene-graph node. Carries a Transform (its localMatrix()
// seam) and per-instance GPU resources (uniform buffer, bind group), sharing the
// geometry and pipeline with any other cubes. Rendering walks the Scene tree and draws
// each CubeNode using its worldMatrix() as the model matrix.

import type { CubeGeometry } from './CubeGeometry'
import { createCubeBindGroup, UNIFORM_SIZE } from './pipeline'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Transform } from '../math/Transform'
import { Vector3 } from '../math/Vector3'
import { Node } from '../scene/Node'

export interface CubeNodeOptions {
  name?: string
  /** World-space position of the cube's center. */
  position?: [number, number, number]
  /** Multiplier applied to this cube's spin, letting cubes rotate at different rates. */
  spinScale?: number
}

export class CubeNode extends Node {
  /** Local transform; its matrix is this node's localMatrix() seam. */
  readonly transform = new Transform()

  private readonly device: GPUDevice
  private readonly geometry: CubeGeometry
  private readonly uniformBuffer: GPUBuffer
  private readonly bindGroup: GPUBindGroup
  private readonly spinScale: number

  constructor(
    device: GPUDevice,
    pipeline: GPURenderPipeline,
    geometry: CubeGeometry,
    options: CubeNodeOptions = {},
  ) {
    super(options.name)
    this.device = device
    this.geometry = geometry
    this.spinScale = options.spinScale ?? 1
    const [x, y, z] = options.position ?? [0, 0, 0]
    this.transform.position = new Vector3(x, y, z)

    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.bindGroup = createCubeBindGroup(device, pipeline, this.uniformBuffer)
  }

  override localMatrix(): Matrix4x4 {
    return this.transform.toMatrix()
  }

  /** Set this cube's spin from a shared animation angle (scaled per cube). */
  setSpin(angle: number): void {
    const spin = angle * this.spinScale
    // "Rx first, then Ry" (a.mul(b) = a applied first): matches the previous
    // translation * rotationY * rotationX model matrix.
    this.transform.rotation = Quaternion.fromAxisAngle(Vector3.right(), spin * 0.6).mul(
      Quaternion.fromAxisAngle(Vector3.up(), spin),
    )
  }

  /**
   * Uploads this node's MVP uniform and records its draw call. `viewProjection` is the
   * shared camera matrix; the model matrix is this node's world matrix (composed
   * through any parents in the graph).
   */
  draw(pass: GPURenderPassEncoder, viewProjection: Matrix4x4): void {
    // Column-vector MVP (textbook order): projection*view * model. toGPU() is the
    // column-major buffer WGSL's `mvp * pos` shader consumes directly.
    const mvp = viewProjection.mul(this.worldMatrix())
    this.device.queue.writeBuffer(this.uniformBuffer, 0, mvp.toGPU() as BufferSource)

    pass.setBindGroup(0, this.bindGroup)
    this.geometry.bind(pass)
    pass.drawIndexed(this.geometry.indexCount)
  }

  destroy(): void {
    this.uniformBuffer.destroy()
  }
}
