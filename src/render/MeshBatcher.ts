// MeshBatcher - owns the shared vertex/index buffers, the per-object transform storage
// buffer, and the group(1) bind group. Shapes tessellate into it once (rebuild); their
// world matrices are refreshed every frame (updateTransforms) without touching geometry.
// One lane = one drawIndexed. Geometry buffers are recreated on rebuild (rebuilds are
// rare); per-slice incremental updates and capacity pooling are a later optimization.

import type { Shape } from '../scene/Shape'
import type { MeshSink } from './meshFormat'
import { MESH_VERTEX_FLOATS, MESH_VERTEX_STRIDE, OBJECT_FLOATS, OBJECT_STRIDE } from './meshFormat'

export class MeshBatcher {
  private readonly device: GPUDevice
  private readonly objectLayout: GPUBindGroupLayout

  private vertexBuffer: GPUBuffer | null = null
  private indexBuffer: GPUBuffer | null = null
  private objectBuffer: GPUBuffer | null = null
  private objectBindGroup: GPUBindGroup | null = null

  private indexCount = 0
  private objectCount = 0

  constructor(device: GPUDevice, objectLayout: GPUBindGroupLayout) {
    this.device = device
    this.objectLayout = objectLayout
  }

  /** Re-tessellate all shapes (objectId = index) into the shared buffers and upload. */
  rebuild(shapes: readonly Shape[]): void {
    const posColor: number[] = [] // 6 per vertex: x,y,r,g,b,a
    const objectIds: number[] = [] // 1 per vertex
    const indices: number[] = []
    let vertexCount = 0

    shapes.forEach((shape, objectId) => {
      if (!shape.visible) return
      const start = vertexCount
      const sink: MeshSink = {
        vertex: (x, y, color) => {
          posColor.push(x, y, color[0], color[1], color[2], color[3])
          objectIds.push(objectId)
          return vertexCount++ - start
        },
        triangle: (a, b, c) => {
          indices.push(start + a, start + b, start + c)
        },
      }
      shape.tessellate(sink)
    })

    // Pack the interleaved vertex buffer (floats for pos/color, u32 bits for objectId).
    const vtx = new ArrayBuffer(vertexCount * MESH_VERTEX_STRIDE)
    const f32 = new Float32Array(vtx)
    const u32 = new Uint32Array(vtx)
    for (let i = 0; i < vertexCount; i++) {
      const b = i * MESH_VERTEX_FLOATS
      f32[b + 0] = posColor[i * 6 + 0]
      f32[b + 1] = posColor[i * 6 + 1]
      f32[b + 2] = posColor[i * 6 + 2]
      f32[b + 3] = posColor[i * 6 + 3]
      f32[b + 4] = posColor[i * 6 + 4]
      f32[b + 5] = posColor[i * 6 + 5]
      u32[b + 6] = objectIds[i]
    }
    const idx = new Uint32Array(indices)

    this.indexCount = idx.length
    this.objectCount = shapes.length

    this.vertexBuffer?.destroy()
    this.vertexBuffer = null
    if (vtx.byteLength > 0) {
      this.vertexBuffer = this.device.createBuffer({
        size: vtx.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(this.vertexBuffer, 0, vtx)
    }

    this.indexBuffer?.destroy()
    this.indexBuffer = null
    if (idx.byteLength > 0) {
      this.indexBuffer = this.device.createBuffer({
        size: idx.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(this.indexBuffer, 0, idx)
    }

    // Object storage buffer (min one slot so the binding is never zero-sized).
    this.objectBuffer?.destroy()
    this.objectBuffer = this.device.createBuffer({
      size: Math.max(1, this.objectCount) * OBJECT_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this.objectBindGroup = this.device.createBindGroup({
      layout: this.objectLayout,
      entries: [{ binding: 0, resource: { buffer: this.objectBuffer } }],
    })
  }

  /** Refresh each shape's world matrix into the object buffer (cheap, per frame). */
  updateTransforms(shapes: readonly Shape[]): void {
    if (!this.objectBuffer || this.objectCount === 0) return
    const data = new Float32Array(this.objectCount * OBJECT_FLOATS)
    const n = Math.min(this.objectCount, shapes.length)
    for (let i = 0; i < n; i++) {
      data.set(shapes[i].worldMatrix().toGPU(), i * OBJECT_FLOATS)
    }
    this.device.queue.writeBuffer(this.objectBuffer, 0, data as BufferSource)
  }

  draw(pass: GPURenderPassEncoder, frameBindGroup: GPUBindGroup): void {
    if (!this.vertexBuffer || !this.indexBuffer || !this.objectBindGroup || this.indexCount === 0) {
      return
    }
    pass.setBindGroup(0, frameBindGroup)
    pass.setBindGroup(1, this.objectBindGroup)
    pass.setVertexBuffer(0, this.vertexBuffer)
    pass.setIndexBuffer(this.indexBuffer, 'uint32')
    pass.drawIndexed(this.indexCount)
  }

  destroy(): void {
    this.vertexBuffer?.destroy()
    this.indexBuffer?.destroy()
    this.objectBuffer?.destroy()
  }
}
