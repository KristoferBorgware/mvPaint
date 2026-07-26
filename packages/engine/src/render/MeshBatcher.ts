// MeshBatcher - owns the shared vertex/index buffers, the per-object storage buffer
// (transform + fill/gradient material), and the group(1) bind group. Shapes tessellate
// into it once (rebuild); each object's transform and material are refreshed every
// frame (updateObjects) without touching geometry, so animating a position, rotation,
// or gradient parameter never requires a rebuild. One lane = one drawIndexed. Geometry
// buffers are recreated on rebuild (rebuilds are rare); per-slice incremental updates
// and capacity pooling are a later optimization.

import type { Shape } from '../scene/Shape'
import {
  FILL_TYPE_CODE,
  MAX_GRADIENT_STOPS,
  MESH_FILL_BIT,
  MESH_VERTEX_FLOATS,
  MESH_VERTEX_STRIDE,
  OBJECT_DEPTH_OFFSET,
  OBJECT_FILL_TYPE_OFFSET,
  OBJECT_GRADIENT_END_OFFSET,
  OBJECT_GRADIENT_END_RADIUS_OFFSET,
  OBJECT_GRADIENT_START_OFFSET,
  OBJECT_GRADIENT_START_RADIUS_OFFSET,
  OBJECT_STOP_COLORS_OFFSET,
  OBJECT_STOP_COUNT_OFFSET,
  OBJECT_STOP_POSITIONS_OFFSET,
  OBJECT_STRIDE,
  type MeshSink,
} from './meshFormat'

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
    const packedIds: number[] = [] // 1 per vertex: object index, top bit = isFill
    const indices: number[] = []
    let vertexCount = 0

    shapes.forEach((shape, objectId) => {
      if (!shape.visible) return
      const start = vertexCount
      const sink: MeshSink = {
        vertex: (x, y, color, isFill) => {
          posColor.push(x, y, color[0], color[1], color[2], color[3])
          packedIds.push(isFill ? objectId | MESH_FILL_BIT : objectId)
          return vertexCount++ - start
        },
        triangle: (a, b, c) => {
          indices.push(start + a, start + b, start + c)
        },
      }
      shape.tessellate(sink)
    })

    // Pack the interleaved vertex buffer (floats for pos/color, u32 bits for packedId).
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
      u32[b + 6] = packedIds[i]
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

  /**
   * Refresh every object's transform, fill/gradient material, and depth into the
   * storage buffer (cheap, per frame). Each object's record is OBJECT_STRIDE bytes;
   * f32/u32 views share one ArrayBuffer so integer fields (fillType, stopCount) can be
   * written alongside the float fields (matrix, gradient points/radii, stops, depth) at
   * their exact byte offsets. `depths` maps each shape to its zIndex-derived NDC depth
   * (see scene/picking.ts's collectZOrder/depthForRank) - shared across both lanes so a
   * shape and a Text can interleave correctly regardless of draw order.
   */
  updateObjects(shapes: readonly Shape[], depths: ReadonlyMap<Shape, number>): void {
    if (!this.objectBuffer || this.objectCount === 0) return
    const n = Math.min(this.objectCount, shapes.length)
    const buf = new ArrayBuffer(this.objectCount * OBJECT_STRIDE)
    const f32 = new Float32Array(buf)
    const u32 = new Uint32Array(buf)

    for (let i = 0; i < n; i++) {
      const shape = shapes[i]
      const floatBase = (i * OBJECT_STRIDE) / 4

      f32.set(shape.worldMatrix().toGPU(), floatBase)
      f32[floatBase + OBJECT_DEPTH_OFFSET / 4] = depths.get(shape) ?? 0.5

      u32[floatBase + OBJECT_FILL_TYPE_OFFSET / 4] = FILL_TYPE_CODE[shape.fillPriority]

      const stops =
        shape.fillPriority === 'linear-gradient'
          ? shape.fillLinearGradientColorStops
          : shape.fillPriority === 'radial-gradient'
            ? shape.fillRadialGradientColorStops
            : []
      const stopCount = Math.min(stops.length, MAX_GRADIENT_STOPS)
      u32[floatBase + OBJECT_STOP_COUNT_OFFSET / 4] = stopCount

      if (shape.fillPriority === 'linear-gradient') {
        f32[floatBase + OBJECT_GRADIENT_START_OFFSET / 4] = shape.fillLinearGradientStartPoint.x
        f32[floatBase + OBJECT_GRADIENT_START_OFFSET / 4 + 1] = shape.fillLinearGradientStartPoint.y
        f32[floatBase + OBJECT_GRADIENT_END_OFFSET / 4] = shape.fillLinearGradientEndPoint.x
        f32[floatBase + OBJECT_GRADIENT_END_OFFSET / 4 + 1] = shape.fillLinearGradientEndPoint.y
      } else if (shape.fillPriority === 'radial-gradient') {
        f32[floatBase + OBJECT_GRADIENT_START_OFFSET / 4] = shape.fillRadialGradientStartPoint.x
        f32[floatBase + OBJECT_GRADIENT_START_OFFSET / 4 + 1] = shape.fillRadialGradientStartPoint.y
        f32[floatBase + OBJECT_GRADIENT_START_RADIUS_OFFSET / 4] = shape.fillRadialGradientStartRadius
        f32[floatBase + OBJECT_GRADIENT_END_OFFSET / 4] = shape.fillRadialGradientEndPoint.x
        f32[floatBase + OBJECT_GRADIENT_END_OFFSET / 4 + 1] = shape.fillRadialGradientEndPoint.y
        f32[floatBase + OBJECT_GRADIENT_END_RADIUS_OFFSET / 4] = shape.fillRadialGradientEndRadius
      }

      for (let s = 0; s < stopCount; s++) {
        f32[floatBase + OBJECT_STOP_POSITIONS_OFFSET / 4 + s] = stops[s].offset
        const [r, g, bch, a] = stops[s].color
        const colorBase = floatBase + OBJECT_STOP_COLORS_OFFSET / 4 + s * 4
        f32[colorBase + 0] = r
        f32[colorBase + 1] = g
        f32[colorBase + 2] = bch
        f32[colorBase + 3] = a
      }
    }

    this.device.queue.writeBuffer(this.objectBuffer, 0, buf)
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
