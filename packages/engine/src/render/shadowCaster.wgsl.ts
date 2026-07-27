// Shadow-caster shader: renders ONE shape's shadow copy into an offscreen texture as a
// flat premultiplied color, ignoring fill/gradient entirely (a shadow is always a solid
// tint) - see ShadowRenderer. The vertex position is the shape's own local-space
// geometry (the same positions its mesh-lane tessellation emits); the model matrix is
// the shadow's own placement (Shape.shadowMatrix()), not the shape's normal one.
export const shadowCasterShaderCode = /* wgsl */ `
struct Frame {
  viewProjection : mat4x4<f32>,
  resolution : vec2<f32>,
};

struct ShadowObject {
  model : mat4x4<f32>,
  color : vec4<f32>, // premultiplied: rgb already multiplied by (alpha * opacity)
};

@group(0) @binding(0) var<uniform> frame : Frame;
@group(1) @binding(0) var<uniform> obj : ShadowObject;

@vertex
fn vs_main(@location(0) position : vec2<f32>) -> @builtin(position) vec4<f32> {
  return frame.viewProjection * obj.model * vec4<f32>(position, 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return obj.color;
}
`
