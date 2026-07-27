// Formats for the shadow lane: a quad vertex (a unit-square corner + object id) and a
// per-object record (world matrix + tint + atlas slot + depth).
//
// The vertex carries a CORNER, not a position: the quad's actual local-space bounds and its
// atlas uv rect live in the per-object record instead, because both are derived from the
// shape's atlas slot, and a slot can be re-baked into a different rectangle at any time
// (see ShadowAtlas). Anything derived from the atlas therefore has to be per-frame data
// like the transform and tint - baking it into the vertex buffer would make the geometry a
// cache of the atlas layout with no way to notice it had gone stale.

// Interleaved vertex: corner (vec2 f32, each component 0 or 1) + objectId (u32).
// Unlike the mesh and text lanes there is no flag packed into the id: every shadow vertex
// is the same kind of thing, so the whole 32 bits are the object index.
export const SHADOW_VERTEX_STRIDE = 12 // bytes
export const SHADOW_VERTEX_FLOATS = 3 // 32-bit slots per vertex (2 + 1)

export const SHADOW_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: SHADOW_VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' }, // corner (0..1 in each axis)
    { shaderLocation: 1, offset: 8, format: 'uint32' }, //    objectId
  ],
}

// Per-object record, in bytes:
//   0   model: mat4x4<f32>  (64) - the shape's world matrix, with the shadow offset applied
//   64  color: vec4<f32>    (16) - straight (non-premultiplied) rgba, alpha * shadowOpacity
//   80  quad: vec4<f32>     (16) - local-space bounds x0,y0,x1,y1 of the atlas slot
//   96  uv: vec4<f32>       (16) - atlas uv rect u0,v0,u1,v1
//   112 depth: f32                - NDC z, just behind the casting shape's own depth
//   116 (12 bytes padding to the struct's 16-byte alignment)
//   128 end
export const SHADOW_OBJECT_COLOR_OFFSET = 64
export const SHADOW_OBJECT_QUAD_OFFSET = 80
export const SHADOW_OBJECT_UV_OFFSET = 96
export const SHADOW_OBJECT_DEPTH_OFFSET = 112
export const SHADOW_OBJECT_STRIDE = 128 // bytes
