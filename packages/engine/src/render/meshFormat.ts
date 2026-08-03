// Shared formats for the mesh lane: the interleaved vertex layout, the per-object
// storage layout (transform + fill/gradient/stroke material), the frame uniform layout,
// and the CPU-facing MeshSink interface that shapes tessellate into. All geometry
// (rects, polygons, future paths) flows through this one layout so it can share a
// single pipeline and buffer set.

import type { Vector2Like } from '../math/Vector2'
// Defined next to the parser that produces it, and re-exported here because this is where the
// rest of the engine has always imported it from.
import type { RGBA } from './color'
export { isRGBA, parseColor, parseStops, type ColorInput, type ColorStopInput, type RGBA } from './color'

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
 * The styling half of a per-object record: everything the fragment shader reads to color
 * a triangle. A Shape structurally satisfies this with its own fill/stroke fields, which
 * is what makes the single-material case free (see Shape.materials()); a shape that needs
 * several - a text node whose runs each have their own color, gradient or outline - hands
 * back one of these per run instead. All of a shape's materials share its world matrix and
 * depth, so they are alternative paint for one object, not separately placed objects.
 */
export interface MeshMaterial {
  fillPriority: FillPriority
  fill: RGBA
  stroke: RGBA
  fillLinearGradientStartPoint: Vector2Like
  fillLinearGradientEndPoint: Vector2Like
  fillLinearGradientColorStops: readonly GradientStop[]
  fillRadialGradientStartPoint: Vector2Like
  fillRadialGradientStartRadius: number
  fillRadialGradientEndPoint: Vector2Like
  fillRadialGradientEndRadius: number
  fillRadialGradientColorStops: readonly GradientStop[]
}

/**
 * Sink a Shape tessellates its geometry into. Positions are in the shape's LOCAL space
 * (the per-object transform is applied in the vertex shader). `isFill` marks vertices
 * that belong to the shape's fill (eligible for a gradient fill) as opposed to its
 * stroke (always a flat color, from the object's strokeColor). `material` selects which
 * of the shape's materials paints the vertex (see MeshMaterial); it defaults to 0, which
 * is the only one an ordinary single-material shape has. `vertex` returns an index local
 * to this shape (0-based); `triangle` references those local indices. The batcher rebases
 * them into the shared buffers and injects the object id. There is no color here: a solid
 * fill/stroke color is read from the object's fillColor/strokeColor at fragment time,
 * exactly like a gradient is - so recoloring a shape (unlike resizing or restroking it)
 * never needs a geometry rebuild, only the per-frame object refresh.
 */
export interface MeshSink {
  vertex(x: number, y: number, isFill: boolean, material?: number): number
  triangle(a: number, b: number, c: number): void
}

// Interleaved vertex: position (vec2 f32) + packedId (u32). packedId's low 31 bits are
// the object index - a (shape, material) pair, since a shape may contribute more than one
// object record (see MeshMaterial); the top bit is the "is fill" flag (stroke vertices
// always render the object's flat strokeColor, never a gradient).
export const MESH_VERTEX_STRIDE = 12 // bytes
export const MESH_VERTEX_FLOATS = 3 // 32-bit slots per vertex (2 + 1)
export const MESH_FILL_BIT = 0x80000000
export const MESH_OBJECT_ID_MASK = 0x7fffffff


// Per-object storage record, in bytes:
//   0   model: mat4x4<f32>                    (64)
//   64  fillType: u32 (0=color, 1=linear, 2=radial)
//   68  stopCount: u32
//   72  gradientStart: vec2<f32>               (8)
//   80  gradientStartRadius: f32
//   84  depth: f32 (NDC z in (0,1); overrides the vertex shader's projected z - see below)
//   88  gradientEnd: vec2<f32>                 (8)
//   96  gradientEndRadius: f32
//   100 stopPositions: array<f32, MAX_GRADIENT_STOPS>       (32)
//   132 opacity: f32 (the object's own transparency - see Shape.opacity)
//   136 (8 bytes padding, vec4 alignment)
//   144 stopColors: array<vec4<f32>, MAX_GRADIENT_STOPS>    (128)
//   272 fillColor: vec4<f32>                   (16) - used when fillType == color
//   288 strokeColor: vec4<f32>                 (16)
//   304 end
//
// `depth` sits in what would otherwise be padding (4 bytes, needed anyway so gradientEnd
// lands on its 8-byte vec2 alignment) - it doesn't grow the record. It is NOT derived
// from the shape's own local/world Z (every 2D shape sits at z=0); it's assigned by the
// renderer each frame from the shape's zIndex rank across the whole scene (see
// scene/picking.ts's collectZOrder/depthForRank), so shapes and text can interleave
// correctly under the depth test regardless of which lane's draw call runs first.
export const OBJECT_FLOATS = 16 // floats spanning just the model matrix
export const OBJECT_FILL_TYPE_OFFSET = 64
export const OBJECT_STOP_COUNT_OFFSET = 68
export const OBJECT_GRADIENT_START_OFFSET = 72
export const OBJECT_GRADIENT_START_RADIUS_OFFSET = 80
export const OBJECT_DEPTH_OFFSET = 84
export const OBJECT_GRADIENT_END_OFFSET = 88
export const OBJECT_GRADIENT_END_RADIUS_OFFSET = 96
export const OBJECT_STOP_POSITIONS_OFFSET = 100
export const OBJECT_OPACITY_OFFSET = 132
export const OBJECT_STOP_COLORS_OFFSET = 144
export const OBJECT_FILL_COLOR_OFFSET = 272
export const OBJECT_STROKE_COLOR_OFFSET = 288
export const OBJECT_STRIDE = 304 // bytes

export const FILL_TYPE_CODE: Record<FillPriority, number> = {
  color: 0,
  'linear-gradient': 1,
  'radial-gradient': 2,
}

// Frame uniform: mat4x4<f32> viewProjection (64) + vec2<f32> resolution (8), padded to 16.
export const FRAME_UNIFORM_SIZE = 80
export const FRAME_RESOLUTION_OFFSET = 64
