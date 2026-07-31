// Formats for the image lane: an interleaved vertex carrying a texture coordinate, and a
// per-object record that is only a transform, a tint and a depth.
//
// Deliberately far smaller than the text record. Everything about WHICH part of the image
// shows - the source rectangle, tiling, aspect fit, flipping - resolves to four corner UVs
// on the CPU (see imageUv.ts), so none of it needs a shader uniform or a branch. What is
// left per object is what genuinely varies per draw.
//
// The tint multiplies the sampled texel, so an opaque white tint is "draw it as it is", and
// its alpha is the node's opacity. That is one multiply in the fragment shader and saves a
// separate opacity field.

// Interleaved vertex: position (vec2 f32) + uv (vec2 f32) + packedId (u32).
// No per-vertex colour: an image's tint is per object, unlike a text run's.
export const IMAGE_VERTEX_STRIDE = 20 // bytes
export const IMAGE_VERTEX_FLOATS = 5 // 32-bit slots per vertex (2 + 2 + 1)


// Per-object record, in bytes (std430-compatible):
//   0   model: mat4x4<f32>   (64)
//   64  tint: vec4<f32>      (16)
//   80  depth: f32 (NDC z in (0,1) - the same zIndex-derived value the other lanes use)
//   84  (padding to a 16-byte multiple)
//   96  end
export const IMAGE_OBJECT_TINT_OFFSET = 64
export const IMAGE_OBJECT_DEPTH_OFFSET = 80
export const IMAGE_OBJECT_STRIDE = 96 // bytes
