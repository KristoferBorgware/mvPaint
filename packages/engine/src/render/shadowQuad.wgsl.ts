// The shadow lane's draw shader: one textured quad per shadow, all sampling the shared
// shadow atlas, so any number of shadows is a single draw call.
//
// The quad's vertices are in the SHAPE's own local space (the silhouette bounds grown by
// the blur margin), and the per-object model matrix is the shape's world matrix with the
// shadow's world-space offset prepended - so scale, rotation, skew, parenting and camera
// zoom are all applied here, to the quad, never baked into the cached texture.
//
// Depth comes from the object record rather than the projected z, exactly as in the mesh
// and text lanes (every 2D shape sits at z=0): a shadow is given a depth just behind its
// own shape, which is what lets shadows interleave correctly with other content instead of
// all collapsing into one flat layer.
export const shadowQuadShaderCode = /* wgsl */ `
struct Frame {
  viewProjection : mat4x4<f32>,
  resolution : vec2<f32>,
};

struct ShadowObject {
  model : mat4x4<f32>,
  color : vec4<f32>,
  depth : f32,
};

@group(0) @binding(0) var<uniform> frame : Frame;
@group(1) @binding(0) var<storage, read> objects : array<ShadowObject>;
@group(2) @binding(0) var atlasTex : texture_2d<f32>;
@group(2) @binding(1) var atlasSampler : sampler;

struct VertexInput {
  @location(0) position : vec2<f32>,
  @location(1) uv : vec2<f32>,
  @location(2) objectId : u32,
};

struct VertexOutput {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) objectId : u32,
};

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  let obj = objects[input.objectId];
  var out : VertexOutput;
  out.clip = frame.viewProjection * obj.model * vec4<f32>(input.position, 0.0, 1.0);
  out.clip.z = obj.depth * out.clip.w;
  out.uv = input.uv;
  out.objectId = input.objectId;
  return out;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let obj = objects[input.objectId];
  // The atlas holds coverage only (single channel); the tint lives in the object record,
  // so recolouring a shadow never touches the baked texture.
  let coverage = textureSample(atlasTex, atlasSampler, input.uv).r;
  let alpha = coverage * obj.color.a;
  if (alpha <= 0.0) {
    discard;
  }
  return vec4<f32>(obj.color.rgb, alpha);
}
`
