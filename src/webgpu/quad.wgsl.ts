// WGSL shader for a solid-colored quad (Rect). The vertex is a 2D position in the
// Z=0 plane; the uniform carries the MVP matrix and a solid RGBA color.
export const quadShaderCode = /* wgsl */ `
struct Uniforms {
  mvp : mat4x4<f32>,
  color : vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms : Uniforms;

@vertex
fn vs_main(@location(0) position : vec2<f32>) -> @builtin(position) vec4<f32> {
  return uniforms.mvp * vec4<f32>(position, 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return uniforms.color;
}
`
