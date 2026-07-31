// The shadow lane's shaders, GLSL ES 300 - the twins of webgpu/shaders/shadowQuad.wgsl.ts and
// webgpu/shaders/shadowBake.wgsl.ts.
//
// A shadow is a blurred silhouette baked once into a shared atlas and then drawn as one
// textured quad. The bake is three kinds of pass - rasterize the silhouette as coverage, an
// optional separable morphological dilate/erode for spread, then a separable Gaussian - and
// every one of them is an ordinary render pass, which is why the whole thing ports to WebGL2
// without a compute shader anywhere.
//
// ONE THING GENUINELY DIFFERS, and it is the thing most likely to look wrong: render-to-texture
// orientation. WebGPU puts NDC y = +1 in a texture's FIRST texel row; GL puts it in the LAST.
// Sampling is the same on both. So a bake written for WebGPU and run unchanged here comes out
// vertically mirrored, and mirrored again on every filter pass.
//
// It is corrected in exactly two places, and they have to agree:
//
//   1. The silhouette projection's y is negated (see webgl/ShadowAtlas.ts), so the shape's TOP
//      edge lands in the region's first texel row - what the WebGPU bake produces, and what
//      the quad shader's uv mapping assumes.
//   2. The fullscreen vertex shader below maps uv.y straight through instead of flipping it,
//      which makes each filter pass read the source row it is writing - identity, not a flip.
//
// With those two, the atlas holds byte-for-byte the layout the WebGPU path produces, and the
// quad shader needs no adjustment at all.

import {
  SHADOW_OBJECT_COLOR_OFFSET,
  SHADOW_OBJECT_DEPTH_OFFSET,
  SHADOW_OBJECT_QUAD_OFFSET,
  SHADOW_OBJECT_STRIDE,
  SHADOW_OBJECT_UV_OFFSET,
} from '../../render/shadowFormat'

const COMPONENT = ['x', 'y', 'z', 'w'] as const
const field = (byteOffset: number): string => `obj(id, ${byteOffset >> 4}).${COMPONENT[(byteOffset >> 2) & 3]}`

const OBJECT_ACCESS = /* glsl */ `
const int OBJ_TEXELS = ${SHADOW_OBJECT_STRIDE / 16};

uniform highp sampler2D u_objects;
uniform int u_objectsWidth;

vec4 obj(uint objectId, int i) {
  int t = int(objectId) * OBJ_TEXELS + i;
  return texelFetch(u_objects, ivec2(t % u_objectsWidth, t / u_objectsWidth), 0);
}
`

// ---------------------------------------------------------------------------------------
// Drawing a baked shadow

export const shadowQuadVertexGlsl = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${OBJECT_ACCESS}
layout(location = 0) in vec2 a_corner;
layout(location = 1) in uint a_objectId;

uniform mat4 u_viewProjection;

out vec2 v_uv;
flat out uint v_objectId;

void main() {
  uint id = a_objectId;
  vec4 quad = obj(id, ${SHADOW_OBJECT_QUAD_OFFSET / 16});
  vec4 uvRect = obj(id, ${SHADOW_OBJECT_UV_OFFSET / 16});
  vec2 position = vec2(mix(quad.x, quad.z, a_corner.x), mix(quad.y, quad.w, a_corner.y));
  // The atlas's first texel row holds the quad's TOP edge, so v runs opposite to local y:
  // corner.y of 1 is the top, which is v0.
  v_uv = vec2(mix(uvRect.x, uvRect.z, a_corner.x), mix(uvRect.w, uvRect.y, a_corner.y));

  mat4 model = mat4(obj(id, 0), obj(id, 1), obj(id, 2), obj(id, 3));
  vec4 clip = u_viewProjection * model * vec4(position, 0.0, 1.0);
  clip.z = (${field(SHADOW_OBJECT_DEPTH_OFFSET)} * 2.0 - 1.0) * clip.w;
  gl_Position = clip;
  v_objectId = a_objectId;
}
`

export const shadowQuadFragmentGlsl = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${OBJECT_ACCESS}
in vec2 v_uv;
flat in uint v_objectId;

uniform sampler2D u_atlas;

out vec4 fragColor;

void main() {
  uint id = v_objectId;
  // The atlas holds coverage only (single channel); the tint lives in the object record, so
  // recolouring a shadow never touches the baked texture.
  vec4 color = obj(id, ${SHADOW_OBJECT_COLOR_OFFSET / 16});
  float coverage = texture(u_atlas, v_uv).r;
  float alpha = coverage * color.a;
  if (alpha <= 0.0) discard;
  fragColor = vec4(color.rgb, alpha);
}
`

// ---------------------------------------------------------------------------------------
// Baking one

/** Rasterizes local-space triangles as flat coverage into a single-channel target. */
export const shadowSilhouetteVertexGlsl = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;

// ndc = position * scale + offset - an orthographic map from the shape's local space onto the
// region's clip space, with the blur padding folded in, and with y already negated for GL's
// render-to-texture orientation (see this file's header).
uniform vec2 u_scale;
uniform vec2 u_offset;

void main() {
  gl_Position = vec4(a_position * u_scale + u_offset, 0.0, 1.0);
}
`

export const shadowSilhouetteFragmentGlsl = /* glsl */ `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(1.0, 0.0, 0.0, 1.0);
}
`

/**
 * A single oversized triangle covering the viewport, built from gl_VertexID alone - no vertex
 * buffer and no attributes - so uv comes out as 0..1 across the VIEWPORT rather than the
 * framebuffer, which is what lets one shader write into an arbitrary sub-rect of the atlas.
 *
 * uv.y is NOT flipped here, unlike the WGSL. See the header.
 */
const FULLSCREEN_VERTEX = /* glsl */ `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  float x = float((gl_VertexID << 1) & 2) * 2.0 - 1.0;
  float y = float(gl_VertexID & 2) * 2.0 - 1.0;
  gl_Position = vec4(x, y, 0.0, 1.0);
  v_uv = vec2((x + 1.0) * 0.5, (y + 1.0) * 0.5);
}
`

export const shadowFilterVertexGlsl = FULLSCREEN_VERTEX

/**
 * One axis of a separable morphological dilate/erode - the shadowSpread extension, run on the
 * raw silhouette BEFORE the Gaussian so the blur softens the already-grown edge (the CSS
 * box-shadow order). Running it once per axis makes the structuring element a SQUARE rather
 * than a disc, the same simplification SVG's feMorphology makes.
 */
export const shadowMorphologyFragmentGlsl = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_source;
// Texel step along the axis being worked, in SOURCE uv units.
uniform vec2 u_step;
// Region size as a fraction of the scratch texture, so uv 0..1 covers the region only.
uniform vec2 u_sourceScale;
// Signed: > 0 dilates, < 0 erodes, 0 passes through.
uniform float u_radius;

const int MAX_TAPS = 128;

void main() {
  vec2 base = v_uv * u_sourceScale;
  int r = min(int(abs(u_radius)), MAX_TAPS);
  if (r <= 0) {
    fragColor = texture(u_source, base);
    return;
  }
  bool dilate = u_radius > 0.0;
  float acc = texture(u_source, base).r;
  for (int i = 1; i <= MAX_TAPS; i++) {
    if (i > r) break;
    vec2 delta = u_step * float(i);
    float a = texture(u_source, base + delta).r;
    float b = texture(u_source, base - delta).r;
    acc = dilate ? max(acc, max(a, b)) : min(acc, min(a, b));
  }
  fragColor = vec4(acc, 0.0, 0.0, 1.0);
}
`

/**
 * One axis of a separable Gaussian. Canvas 2D defines shadowBlur as a Gaussian of
 * sigma = shadowBlur/2 (see render/shadowMath.ts), and a 2D Gaussian is separable, so running
 * this once horizontally and once vertically costs 2*(2R+1) taps instead of (2R+1)^2.
 */
export const shadowBlurFragmentGlsl = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_source;
uniform vec2 u_step;
uniform vec2 u_sourceScale;
uniform float u_sigma;
uniform float u_radius;

const int MAX_TAPS = 128;

void main() {
  vec2 base = v_uv * u_sourceScale;
  int r = min(int(u_radius), MAX_TAPS);
  if (r <= 0) {
    fragColor = texture(u_source, base);
    return;
  }
  float twoSigmaSq = 2.0 * u_sigma * u_sigma;
  // The centre tap, weight exp(0) = 1, then symmetric pairs - halving the tap count by
  // reusing each weight for +i and -i.
  float sum = texture(u_source, base).r;
  float weightSum = 1.0;
  for (int i = 1; i <= MAX_TAPS; i++) {
    if (i > r) break;
    float fi = float(i);
    float w = exp(-(fi * fi) / twoSigmaSq);
    vec2 delta = u_step * fi;
    sum += w * texture(u_source, base + delta).r;
    sum += w * texture(u_source, base - delta).r;
    weightSum += 2.0 * w;
  }
  fragColor = vec4(sum / weightSum, 0.0, 0.0, 1.0);
}
`
