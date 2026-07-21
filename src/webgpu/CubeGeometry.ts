// Geometry data for a unit cube, decoupled from any renderer.
// Holds the raw vertex/index data and owns the GPU buffers created from it.

// 8 cube corners, each with its own RGB color -> smoothly interpolated (vertex coloring).
// Layout per vertex: x, y, z, r, g, b
// prettier-ignore
const VERTEX_DATA = new Float32Array([
  // position           // color
  -1, -1, -1,           0, 0, 0,
   1, -1, -1,           1, 0, 0,
   1,  1, -1,           1, 1, 0,
  -1,  1, -1,           0, 1, 0,
  -1, -1,  1,           0, 0, 1,
   1, -1,  1,           1, 0, 1,
   1,  1,  1,           1, 1, 1,
  -1,  1,  1,           0, 1, 1,
])

// 12 triangles (36 indices), CCW winding.
// prettier-ignore
const INDEX_DATA = new Uint16Array([
  // back face (z = -1)
  0, 2, 1,  0, 3, 2,
  // front face (z = +1)
  4, 5, 6,  4, 6, 7,
  // left face (x = -1)
  0, 4, 7,  0, 7, 3,
  // right face (x = +1)
  1, 2, 6,  1, 6, 5,
  // bottom face (y = -1)
  0, 1, 5,  0, 5, 4,
  // top face (y = +1)
  3, 7, 6,  3, 6, 2,
])

/** Vertex buffer layout matching VERTEX_DATA — shared by any pipeline that draws this geometry. */
export const CUBE_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 6 * 4,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
    { shaderLocation: 1, offset: 3 * 4, format: 'float32x3' }, // color
  ],
}

/**
 * Owns the GPU vertex/index buffers for a cube. A single instance can be shared
 * across many drawn cubes — only per-cube uniforms differ.
 */
export class CubeGeometry {
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

  /** Binds this geometry's vertex + index buffers onto the given render pass. */
  bind(pass: GPURenderPassEncoder): void {
    pass.setVertexBuffer(0, this.vertexBuffer)
    pass.setIndexBuffer(this.indexBuffer, this.indexFormat)
  }

  destroy(): void {
    this.vertexBuffer.destroy()
    this.indexBuffer.destroy()
  }
}
