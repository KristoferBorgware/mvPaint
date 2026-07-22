// Geometry for a centered unit quad in the Z=0 plane, shared by all Rects. Corners
// span [-0.5, 0.5] on X and Y, so a Rect's transform (translate * rotate * scale(w,h))
// places its center at (x, y) and rotation pivots about that center.

// 4 corners, position only (x, y). Centered on the origin.
// prettier-ignore
const VERTEX_DATA = new Float32Array([
  -0.5, -0.5,
   0.5, -0.5,
   0.5,  0.5,
  -0.5,  0.5,
])

// Two triangles (0,1,2) and (0,2,3).
// prettier-ignore
const INDEX_DATA = new Uint16Array([
  0, 1, 2,
  0, 2, 3,
])

/** Vertex buffer layout matching VERTEX_DATA (a single vec2 position attribute). */
export const QUAD_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 2 * 4,
  attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
}

/** Owns the shared GPU vertex/index buffers for the unit quad. */
export class QuadGeometry {
  readonly vertexBuffer: GPUBuffer
  readonly indexBuffer: GPUBuffer
  readonly indexFormat: GPUIndexFormat = 'uint16'
  readonly indexCount = INDEX_DATA.length

  constructor(device: GPUDevice) {
    this.vertexBuffer = device.createBuffer({
      size: VERTEX_DATA.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(this.vertexBuffer, 0, VERTEX_DATA)

    this.indexBuffer = device.createBuffer({
      size: INDEX_DATA.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(this.indexBuffer, 0, INDEX_DATA)
  }

  bind(pass: GPURenderPassEncoder): void {
    pass.setVertexBuffer(0, this.vertexBuffer)
    pass.setIndexBuffer(this.indexBuffer, this.indexFormat)
  }

  destroy(): void {
    this.vertexBuffer.destroy()
    this.indexBuffer.destroy()
  }
}
