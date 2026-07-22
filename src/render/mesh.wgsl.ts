// Mesh-lane shader. Every 2D shape flows through this: per-vertex position (local),
// per-vertex color, and an objectId that indexes the per-object world matrix. The
// fragment is trivial - just the interpolated color - because fill/stroke are carried
// as geometry + vertex color, not shader tricks.
export const meshShaderCode = /* wgsl */ `
struct Frame {
  viewProjection : mat4x4<f32>,
  resolution : vec2<f32>,
};

struct ObjectData {
  model : mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> frame : Frame;
@group(1) @binding(0) var<storage, read> objects : array<ObjectData>;

struct VertexInput {
  @location(0) position : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) objectId : u32,
};

struct VertexOutput {
  @builtin(position) clip : vec4<f32>,
  @location(0) color : vec4<f32>,
};

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  let model = objects[input.objectId].model;
  var out : VertexOutput;
  out.clip = frame.viewProjection * model * vec4<f32>(input.position, 0.0, 1.0);
  out.color = input.color;
  return out;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
`
