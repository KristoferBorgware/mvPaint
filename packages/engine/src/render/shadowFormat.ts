// Formats for the shadow lane: a quad vertex (local position + atlas uv + object id) and a
// small per-object record (world matrix + tint + depth). Deliberately much leaner than the
// mesh/text object records - a shadow has no gradient, no stroke and no fill mode, only a
// flat tint over the coverage baked into the atlas.

// Interleaved vertex: position (vec2 f32) + uv (vec2 f32) + objectId (u32).
// Unlike the mesh and text lanes there is no flag packed into the id: every shadow vertex
// is the same kind of thing, so the whole 32 bits are the object index.
export const SHADOW_VERTEX_STRIDE = 20 // bytes
export const SHADOW_VERTEX_FLOATS = 5 // 32-bit slots per vertex (2 + 2 + 1)

export const SHADOW_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: SHADOW_VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position (shape-local)
    { shaderLocation: 1, offset: 8, format: 'float32x2' }, // uv (atlas)
    { shaderLocation: 2, offset: 16, format: 'uint32' }, //   objectId
  ],
}

// Per-object record, in bytes:
//   0  model: mat4x4<f32>  (64) - the shape's world matrix, with the shadow offset applied
//   64 color: vec4<f32>    (16) - straight (non-premultiplied) rgba, alpha * shadowOpacity
//   80 depth: f32               - NDC z, just behind the casting shape's own depth
//   84 (12 bytes padding to the struct's 16-byte alignment)
//   96 end
export const SHADOW_OBJECT_COLOR_OFFSET = 64
export const SHADOW_OBJECT_DEPTH_OFFSET = 80
export const SHADOW_OBJECT_STRIDE = 96 // bytes
