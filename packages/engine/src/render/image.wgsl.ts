// The image lane's shader: sample the bound texture at the interpolated coordinate and
// multiply by the object's tint. That is the whole of it - everything about which part of
// the image shows was resolved into the corner UVs on the CPU (see image/imageUv.ts), and
// wrapping and filtering are the sampler's job (see image/ImageTexture.ts), so there is
// nothing left here to branch on.
//
// The texture is sampled as-is and the result is multiplied by a straight-alpha tint, then
// blended straight-alpha by the pipeline. An image with premultiplied alpha would need the
// blend factors changed rather than anything here.

export const imageShaderCode = /* wgsl */ `
struct Frame {
  viewProjection : mat4x4<f32>,
  resolution : vec2<f32>,
  _pad : vec2<f32>,
};

struct ObjectData {
  model : mat4x4<f32>,
  tint : vec4<f32>,
  depth : f32,
  _pad0 : f32,
  _pad1 : f32,
  _pad2 : f32,
};

@group(0) @binding(0) var<uniform> frame : Frame;
@group(1) @binding(0) var<storage, read> objects : array<ObjectData>;
@group(2) @binding(0) var imageTex : texture_2d<f32>;
@group(2) @binding(1) var imageSampler : sampler;

struct VertexInput {
  @location(0) position : vec2<f32>,
  @location(1) uv : vec2<f32>,
  @location(2) packedId : u32,
};

struct VertexOutput {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) objectId : u32,
};

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  let model = objects[input.packedId].model;
  var out : VertexOutput;
  out.clip = frame.viewProjection * model * vec4<f32>(input.position, 0.0, 1.0);
  // An image sits at local z=0 like every other lane's geometry; its stacking order comes
  // from its zIndex rank (see scene/picking.ts), injected here so a shape or a run of text
  // can sit in front of an image rather than one lane always winning.
  out.clip.z = objects[input.packedId].depth * out.clip.w;
  out.uv = input.uv;
  out.objectId = input.packedId;
  return out;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let texel = textureSample(imageTex, imageSampler, input.uv);
  let color = texel * objects[input.objectId].tint;

  // A fully transparent fragment - a hole in the source texture, or a tint that has faded
  // the image out entirely - must not write depth. depthWriteEnabled doesn't look at alpha,
  // so without this the image's whole quad would occlude whatever draws after it at a
  // further depth, transparent texels and all: a sprite with holes in it would clip the
  // shadows behind it to its bounding box. The mesh and text lanes discard for the same
  // reason (see mesh.wgsl.ts and text.wgsl.ts).
  if (color.a <= 0.0) {
    discard;
  }
  return color;
}
`
