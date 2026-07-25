// Shared formats for the mesh lane: the interleaved vertex layout, the per-object
// storage layout (transform + fill/gradient material), the frame uniform layout, and
// the CPU-facing MeshSink interface that shapes tessellate into. All geometry (rects,
// polygons, future paths) flows through this one layout so it can share a single
// pipeline and buffer set.

export type RGBA = readonly [number, number, number, number]
export type Point2 = { x: number; y: number }

/** Which fill mechanism a shape's fill triangles use. */
export type FillPriority = 'color' | 'linear-gradient' | 'radial-gradient'

/** A single gradient color stop: `offset` in [0,1], `color` in straight RGBA. */
export interface GradientStop {
  offset: number
  color: RGBA
}

/** Fixed cap on gradient stops per object (bounds the per-object storage record size). */
export const MAX_GRADIENT_STOPS = 8

/**
 * Sink a Shape tessellates its geometry into. Positions are in the shape's LOCAL space
 * (the per-object transform is applied in the vertex shader). `isFill` marks vertices
 * that belong to the shape's fill (eligible for a gradient fill) as opposed to its
 * stroke (always a flat color). `vertex` returns an index local to this shape (0-based);
 * `triangle` references those local indices. The batcher rebases them into the shared
 * buffers and injects the object id.
 */
export interface MeshSink {
  vertex(x: number, y: number, color: RGBA, isFill: boolean): number
  triangle(a: number, b: number, c: number): void
}

// Interleaved vertex: position (vec2 f32) + color (vec4 f32) + packedId (u32).
// packedId's low 31 bits are the object index; the top bit is the "is fill" flag
// (stroke vertices always render their flat color, never a gradient).
export const MESH_VERTEX_STRIDE = 28 // bytes
export const MESH_VERTEX_FLOATS = 7 // 32-bit slots per vertex (2 + 4 + 1)
export const MESH_FILL_BIT = 0x80000000
export const MESH_OBJECT_ID_MASK = 0x7fffffff

export const MESH_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: MESH_VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position
    { shaderLocation: 1, offset: 8, format: 'float32x4' }, // color (rgba)
    { shaderLocation: 2, offset: 24, format: 'uint32' }, //   packedId
  ],
}

// Per-object storage record, in bytes:
//   0   model: mat4x4<f32>                    (64)
//   64  fillType: u32 (0=color, 1=linear, 2=radial)
//   68  stopCount: u32
//   72  gradientStart: vec2<f32>               (8)
//   80  gradientStartRadius: f32
//   84  (4 bytes padding, vec2 alignment)
//   88  gradientEnd: vec2<f32>                 (8)
//   96  gradientEndRadius: f32
//   100 stopPositions: array<f32, MAX_GRADIENT_STOPS>       (32)
//   132 (12 bytes padding, vec4 alignment)
//   144 stopColors: array<vec4<f32>, MAX_GRADIENT_STOPS>    (128)
//   272 end
export const OBJECT_FLOATS = 16 // floats spanning just the model matrix
export const OBJECT_FILL_TYPE_OFFSET = 64
export const OBJECT_STOP_COUNT_OFFSET = 68
export const OBJECT_GRADIENT_START_OFFSET = 72
export const OBJECT_GRADIENT_START_RADIUS_OFFSET = 80
export const OBJECT_GRADIENT_END_OFFSET = 88
export const OBJECT_GRADIENT_END_RADIUS_OFFSET = 96
export const OBJECT_STOP_POSITIONS_OFFSET = 100
export const OBJECT_STOP_COLORS_OFFSET = 144
export const OBJECT_STRIDE = 272 // bytes

export const FILL_TYPE_CODE: Record<FillPriority, number> = {
  color: 0,
  'linear-gradient': 1,
  'radial-gradient': 2,
}

// Frame uniform: mat4x4<f32> viewProjection (64) + vec2<f32> resolution (8), padded to 16.
export const FRAME_UNIFORM_SIZE = 80
export const FRAME_RESOLUTION_OFFSET = 64
