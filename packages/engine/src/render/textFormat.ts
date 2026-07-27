// Formats for the text (MSDF) lane: its interleaved vertex layout (adds a UV into the atlas
// on top of the mesh lane's position+color), and a per-object material record that mirrors the
// mesh object record (transform + fill/gradient) and extends it with a per-letter stroke
// (outline color + width) and the atlas's distance range. Text glyph quads and solid text
// decorations (underline, strikethrough, highlight) all flow through this one layout.

import { MAX_GRADIENT_STOPS } from './meshFormat'

export { MAX_GRADIENT_STOPS }

// Interleaved vertex: position (vec2 f32) + uv (vec2 f32) + color (vec4 f32) + packedId (u32).
// packedId's low 31 bits are the object (material) index; the top bit is the "is glyph" flag
// (glyph quads sample the MSDF atlas; decoration/highlight quads render their flat color).
export const TEXT_VERTEX_STRIDE = 36 // bytes
export const TEXT_VERTEX_FLOATS = 9 // 32-bit slots per vertex (2 + 2 + 4 + 1)
export const TEXT_GLYPH_BIT = 0x80000000
export const TEXT_OBJECT_ID_MASK = 0x7fffffff

export const TEXT_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: TEXT_VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position (local)
    { shaderLocation: 1, offset: 8, format: 'float32x2' }, // uv (atlas)
    { shaderLocation: 2, offset: 16, format: 'float32x4' }, // color (rgba)
    { shaderLocation: 3, offset: 32, format: 'uint32' }, //    packedId
  ],
}

// Per-object material record, in bytes (std430-compatible):
//   0   model: mat4x4<f32>                                (64)
//   64  fillType: u32 (0=color, 1=linear, 2=radial)
//   68  stopCount: u32
//   72  gradientStart: vec2<f32>                           (8)
//   80  gradientStartRadius: f32
//   84  depth: f32 (NDC z in (0,1) - same zIndex-derived value as the mesh format; see meshFormat.ts)
//   88  gradientEnd: vec2<f32>                             (8)
//   96  gradientEndRadius: f32
//   100 stopPositions: array<f32, MAX_GRADIENT_STOPS>      (32)
//   132 (padding, vec4 alignment)
//   144 stopColors: array<vec4<f32>, MAX_GRADIENT_STOPS>   (128)
//   272 strokeColor: vec4<f32>                             (16)
//   288 strokeWidth: f32 (world px; 0 = no outline)
//   292 hasStroke: u32
//   296 distanceRange: f32 (atlas SDF spread in texels)
//   300 dilate: f32 (world px; widens glyph coverage - faux bold, glow/shadow spread)
//   304 blur: f32 (world px; widens the coverage edge's anti-alias ramp - glow/shadow blur)
//   308 (12 bytes padding, vec4 alignment - see meshFormat.ts's OBJECT_STRIDE for the same trick)
//   320 end
export const TEXT_OBJECT_FILL_TYPE_OFFSET = 64
export const TEXT_OBJECT_STOP_COUNT_OFFSET = 68
export const TEXT_OBJECT_GRADIENT_START_OFFSET = 72
export const TEXT_OBJECT_GRADIENT_START_RADIUS_OFFSET = 80
export const TEXT_OBJECT_DEPTH_OFFSET = 84
export const TEXT_OBJECT_GRADIENT_END_OFFSET = 88
export const TEXT_OBJECT_GRADIENT_END_RADIUS_OFFSET = 96
export const TEXT_OBJECT_STOP_POSITIONS_OFFSET = 100
export const TEXT_OBJECT_STOP_COLORS_OFFSET = 144
export const TEXT_OBJECT_STROKE_COLOR_OFFSET = 272
export const TEXT_OBJECT_STROKE_WIDTH_OFFSET = 288
export const TEXT_OBJECT_HAS_STROKE_OFFSET = 292
export const TEXT_OBJECT_DISTANCE_RANGE_OFFSET = 296
export const TEXT_OBJECT_DILATE_OFFSET = 300
export const TEXT_OBJECT_BLUR_OFFSET = 304
export const TEXT_OBJECT_STRIDE = 320 // bytes
