// The image lane's shader, GLSL ES 300 - the twin of webgpu/shaders/image.wgsl.ts.
//
// Sample the bound texture at the interpolated coordinate and multiply by the object's tint.
// That is the whole of it: which part of the image shows was resolved into the corner UVs on
// the CPU (see image/imageUv.ts), and wrapping and filtering are sampler state, so there is
// nothing left here to branch on.
//
// The same departures as the other lanes: the object record is a texture, and the injected
// depth is remapped from WebGPU's [0,1] clip range into GL's [-1,1]. This record has no
// integer fields at all - a transform, a tint and a depth - so the float-versus-bits question
// the other two lanes have does not arise.

import {
  IMAGE_OBJECT_DEPTH_OFFSET,
  IMAGE_OBJECT_OPACITY_OFFSET,
  IMAGE_OBJECT_STRIDE,
  IMAGE_OBJECT_TINT_OFFSET,
} from '../../render/imageFormat'

const COMPONENT = ['x', 'y', 'z', 'w'] as const
const field = (byteOffset: number): string => `obj(id, ${byteOffset >> 4}).${COMPONENT[(byteOffset >> 2) & 3]}`

const OBJECT_ACCESS = /* glsl */ `
const int OBJ_TEXELS = ${IMAGE_OBJECT_STRIDE / 16};

uniform highp sampler2D u_objects;
uniform int u_objectsWidth;

vec4 obj(uint objectId, int i) {
  int t = int(objectId) * OBJ_TEXELS + i;
  return texelFetch(u_objects, ivec2(t % u_objectsWidth, t / u_objectsWidth), 0);
}
`

export const imageVertexGlsl = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${OBJECT_ACCESS}
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in uint a_objectId;

uniform mat4 u_viewProjection;

out vec2 v_uv;
flat out uint v_objectId;

void main() {
  uint id = a_objectId;
  mat4 model = mat4(obj(id, 0), obj(id, 1), obj(id, 2), obj(id, 3));
  vec4 clip = u_viewProjection * model * vec4(a_position, 0.0, 1.0);
  // An image sits at local z = 0 like every other lane's geometry; its stacking order comes
  // from its zIndex rank, injected here so a shape or a run of text can sit in front of it.
  clip.z = (${field(IMAGE_OBJECT_DEPTH_OFFSET)} * 2.0 - 1.0) * clip.w;
  gl_Position = clip;
  v_uv = a_uv;
  v_objectId = a_objectId;
}
`

export const imageFragmentGlsl = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${OBJECT_ACCESS}
in vec2 v_uv;
flat in uint v_objectId;

uniform sampler2D u_image;

out vec4 fragColor;

void main() {
  uint id = v_objectId;
  // Straight-alpha throughout: the texture is uploaded unpremultiplied and the tint is a
  // straight-alpha multiply, which is what the lane's blend factors expect.
  vec4 color = texture(u_image, v_uv) * obj(id, ${IMAGE_OBJECT_TINT_OFFSET / 16});

  // A hole in the source texture, or a tint that has faded the image out entirely: blending
  // The object's own transparency, applied last and to the alpha only - these lanes blend
  // straight (non-premultiplied) alpha, so scaling rgb would darken rather than fade.
  color.a *= ${field(IMAGE_OBJECT_OPACITY_OFFSET)};

  // at alpha 0 leaves the destination exactly as it was, so discarding skips the blend.
  if (color.a <= 0.0) discard;
  fragColor = color;
}
`
