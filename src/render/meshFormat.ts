// Shared formats for the mesh lane: the interleaved vertex layout, the per-object
// storage stride, the frame uniform layout, and the CPU-facing MeshSink interface that
// shapes tessellate into. All geometry (rects, polygons, future paths) flows through
// this one layout so it can share a single pipeline and buffer set.

export type RGBA = readonly [number, number, number, number]

/**
 * Sink a Shape tessellates its geometry into. Positions are in the shape's LOCAL space
 * (the per-object transform is applied in the vertex shader). `vertex` returns an index
 * local to this shape (0-based); `triangle` references those local indices. The batcher
 * rebases them into the shared buffers and injects the object id.
 */
export interface MeshSink {
  vertex(x: number, y: number, color: RGBA): number
  triangle(a: number, b: number, c: number): void
}

// Interleaved vertex: position (vec2 f32) + color (vec4 f32) + objectId (u32).
export const MESH_VERTEX_STRIDE = 28 // bytes
export const MESH_VERTEX_FLOATS = 7 // 32-bit slots per vertex (2 + 4 + 1)

export const MESH_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: MESH_VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position
    { shaderLocation: 1, offset: 8, format: 'float32x4' }, // color (rgba)
    { shaderLocation: 2, offset: 24, format: 'uint32' }, //   objectId
  ],
}

// Per-object storage record: a single mat4x4<f32> world matrix (room for flags later).
export const OBJECT_STRIDE = 64 // bytes
export const OBJECT_FLOATS = 16

// Frame uniform: mat4x4<f32> viewProjection (64) + vec2<f32> resolution (8), padded to 16.
export const FRAME_UNIFORM_SIZE = 80
export const FRAME_RESOLUTION_OFFSET = 64
