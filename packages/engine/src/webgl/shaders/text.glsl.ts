// The text lane's shader, GLSL ES 300 - the twin of render/text.wgsl.ts.
//
// Multi-channel signed distance fields: a glyph's coverage is the median of the sampled RGB,
// thresholded against a range measured in SCREEN pixels rather than texels, which is what
// keeps letterforms crisp at any camera zoom instead of blurring like a bitmap. Decorations -
// underline, strikethrough, highlight - travel in the same buffers with the glyph flag clear
// and take their flat colour with no sampling at all.
//
// Same three departures from the WGSL as the mesh lane, plus one of its own:
//
//   - the object array is a texture (see ObjectTexture.ts), so every OBJ_* number below is
//     interpolated from render/textFormat.ts rather than written out;
//   - clip z is remapped from WebGPU's [0,1] to GL's [-1,1];
//   - integer fields are read as floats, never as reinterpreted bits;
//   - and `textureDimensions` becomes `textureSize(...).xy`, which for an array texture is one
//     LAYER's size - exactly what the uvs are measured against too, so packing a smaller font
//     image into a larger shared layer scales the uv derivative down and the unit range up by
//     the same factor and the screen-pixel range comes out unchanged.
//
// The atlas sample and both fwidth() calls happen BEFORE any branch on the per-fragment glyph
// flag. Derivatives are only defined in uniform control flow, and a quad mixing glyph and
// decoration fragments would otherwise read them where they are undefined.

import { MAX_GRADIENT_STOPS } from '../../render/meshFormat'
import {
  TEXT_GLYPH_BIT,
  TEXT_OBJECT_ATLAS_LAYER_OFFSET,
  TEXT_OBJECT_DEPTH_OFFSET,
  TEXT_OBJECT_DILATE_OFFSET,
  TEXT_OBJECT_DISTANCE_RANGE_OFFSET,
  TEXT_OBJECT_FILL_TYPE_OFFSET,
  TEXT_OBJECT_GRADIENT_END_OFFSET,
  TEXT_OBJECT_GRADIENT_END_RADIUS_OFFSET,
  TEXT_OBJECT_GRADIENT_START_OFFSET,
  TEXT_OBJECT_GRADIENT_START_RADIUS_OFFSET,
  TEXT_OBJECT_HAS_STROKE_OFFSET,
  TEXT_OBJECT_ID_MASK,
  TEXT_OBJECT_STOP_COLORS_OFFSET,
  TEXT_OBJECT_STOP_COUNT_OFFSET,
  TEXT_OBJECT_STOP_POSITIONS_OFFSET,
  TEXT_OBJECT_STRIDE,
  TEXT_OBJECT_STROKE_COLOR_OFFSET,
  TEXT_OBJECT_STROKE_WIDTH_OFFSET,
} from '../../render/textFormat'

const COMPONENT = ['x', 'y', 'z', 'w'] as const
const field = (byteOffset: number): string =>
  `obj(id, ${byteOffset >> 4}).${COMPONENT[(byteOffset >> 2) & 3]}`
const field2 = (byteOffset: number): string => {
  const c = (byteOffset >> 2) & 3
  return `obj(id, ${byteOffset >> 4}).${COMPONENT[c]}${COMPONENT[c + 1]}`
}

const OBJECT_ACCESS = /* glsl */ `
const int OBJ_TEXELS = ${TEXT_OBJECT_STRIDE / 16};
const uint GLYPH_BIT = ${TEXT_GLYPH_BIT >>> 0}u;
const uint OBJECT_ID_MASK = ${TEXT_OBJECT_ID_MASK >>> 0}u;
const int MAX_STOPS = ${MAX_GRADIENT_STOPS};

uniform highp sampler2D u_objects;
uniform int u_objectsWidth;

vec4 obj(uint objectId, int i) {
  int t = int(objectId) * OBJ_TEXELS + i;
  return texelFetch(u_objects, ivec2(t % u_objectsWidth, t / u_objectsWidth), 0);
}
`

export const textVertexGlsl = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${OBJECT_ACCESS}
layout(location = 0) in vec2 a_position;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec4 a_color;
layout(location = 3) in uint a_packedId;

uniform mat4 u_viewProjection;

out vec2 v_uv;
out vec4 v_color;
out vec2 v_localPos;
flat out uint v_packedId;

void main() {
  uint id = a_packedId & OBJECT_ID_MASK;
  mat4 model = mat4(obj(id, 0), obj(id, 1), obj(id, 2), obj(id, 3));
  vec4 clip = u_viewProjection * model * vec4(a_position, 0.0, 1.0);
  // Text sits at local z = 0 like every other lane's geometry; its stacking order is injected
  // here so a shape can sit in front of text rather than one lane always winning.
  clip.z = (${field(TEXT_OBJECT_DEPTH_OFFSET)} * 2.0 - 1.0) * clip.w;
  gl_Position = clip;
  v_uv = a_uv;
  v_color = a_color;
  v_localPos = a_position;
  v_packedId = a_packedId;
}
`

export const textFragmentGlsl = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
${OBJECT_ACCESS}
in vec2 v_uv;
in vec4 v_color;
in vec2 v_localPos;
flat in uint v_packedId;

uniform sampler2DArray u_atlas;

out vec4 fragColor;

float linearGradientT(vec2 p, vec2 start, vec2 end) {
  vec2 axis = end - start;
  float axisLenSq = dot(axis, axis);
  if (axisLenSq < 1e-8) return 0.0;
  return dot(p - start, axis) / axisLenSq;
}

float radialGradientT(vec2 p, vec2 c0, float r0, vec2 c1, float r1) {
  vec2 dc = c1 - c0;
  float dr = r1 - r0;
  vec2 pc = p - c0;
  float a = dot(dc, dc) - dr * dr;
  float b = -2.0 * (dot(pc, dc) + r0 * dr);
  float c = dot(pc, pc) - r0 * r0;
  if (abs(a) < 1e-6) {
    if (abs(b) < 1e-6) return 0.0;
    return -c / b;
  }
  float disc = b * b - 4.0 * a * c;
  if (disc < 0.0) return 1.0;
  float sq = sqrt(disc);
  float t0 = (-b + sq) / (2.0 * a);
  float t1 = (-b - sq) / (2.0 * a);
  float hi = max(t0, t1);
  float lo = min(t0, t1);
  return (r0 + hi * dr >= 0.0) ? hi : lo;
}

float stopPosition(uint id, int s) {
  int f = ${TEXT_OBJECT_STOP_POSITIONS_OFFSET / 4} + s;
  return obj(id, f >> 2)[f & 3];
}
vec4 stopColor(uint id, int s) {
  return obj(id, ${TEXT_OBJECT_STOP_COLORS_OFFSET / 16} + s);
}

vec4 sampleGradient(uint id, int n, float t) {
  if (n == 0) return vec4(0.0);
  if (n == 1 || t <= stopPosition(id, 0)) return stopColor(id, 0);
  if (t >= stopPosition(id, n - 1)) return stopColor(id, n - 1);
  for (int i = 0; i < MAX_STOPS - 1; i++) {
    if (i >= n - 1) break;
    float p0 = stopPosition(id, i);
    float p1 = stopPosition(id, i + 1);
    if (t >= p0 && t <= p1) {
      float localT = p1 > p0 ? (t - p0) / (p1 - p0) : 0.0;
      return mix(stopColor(id, i), stopColor(id, i + 1), localT);
    }
  }
  return stopColor(id, n - 1);
}

float median(vec3 v) {
  return max(min(v.r, v.g), min(max(v.r, v.g), v.b));
}

// Base fill for both glyph body and solid decoration: the per-vertex colour, or the object's
// per-run gradient evaluated at the fragment's local position.
vec4 baseColor(uint id, vec4 vertexColor, vec2 localPos) {
  float fillType = ${field(TEXT_OBJECT_FILL_TYPE_OFFSET)};
  if (fillType < 0.5) return vertexColor;
  float t;
  if (fillType < 1.5) {
    t = linearGradientT(localPos, ${field2(TEXT_OBJECT_GRADIENT_START_OFFSET)}, ${field2(TEXT_OBJECT_GRADIENT_END_OFFSET)});
  } else {
    t = radialGradientT(
      localPos,
      ${field2(TEXT_OBJECT_GRADIENT_START_OFFSET)}, ${field(TEXT_OBJECT_GRADIENT_START_RADIUS_OFFSET)},
      ${field2(TEXT_OBJECT_GRADIENT_END_OFFSET)}, ${field(TEXT_OBJECT_GRADIENT_END_RADIUS_OFFSET)}
    );
  }
  return sampleGradient(id, int(${field(TEXT_OBJECT_STOP_COUNT_OFFSET)}), clamp(t, 0.0, 1.0));
}

void main() {
  uint id = v_packedId & OBJECT_ID_MASK;

  // Derivative-based quantities must run in uniform control flow, so they are evaluated before
  // any branch on the per-fragment glyph flag.
  vec3 msd = texture(u_atlas, vec3(v_uv, ${field(TEXT_OBJECT_ATLAS_LAYER_OFFSET)})).rgb;
  vec2 uvDeriv = fwidth(v_uv);
  vec2 localDeriv = fwidth(v_localPos);

  vec4 color;
  if ((v_packedId & GLYPH_BIT) == 0u) {
    // Solid decoration (underline / strikethrough / highlight): flat colour, no MSDF.
    color = v_color;
  } else {
    vec4 base = baseColor(id, v_color, v_localPos);

    // World-px widths (stroke, dilation) become screen px via the local derivative, so they
    // scale with the text under camera zoom.
    float screenPerWorld = 2.0 / max(abs(localDeriv.x) + abs(localDeriv.y), 1e-5);

    float sd = median(msd);
    vec2 unitRange = vec2(${field(TEXT_OBJECT_DISTANCE_RANGE_OFFSET)}) / vec2(textureSize(u_atlas, 0).xy);
    vec2 screenTexSize = vec2(1.0) / uvDeriv;
    float screenPxRange = max(0.5 * dot(unitRange, screenTexSize), 1.0);
    float screenPxDist = screenPxRange * (sd - 0.5) + ${field(TEXT_OBJECT_DILATE_OFFSET)} * screenPerWorld;
    float fillAlpha = clamp(screenPxDist + 0.5, 0.0, 1.0);

    if (${field(TEXT_OBJECT_HAS_STROKE_OFFSET)} < 0.5) {
      color = vec4(base.rgb, base.a * fillAlpha);
    } else {
      // Outline: widen coverage further by the stroke width, in the stroke colour under the body.
      vec4 strokeColor = obj(id, ${TEXT_OBJECT_STROKE_COLOR_OFFSET / 16});
      float strokePx = ${field(TEXT_OBJECT_STROKE_WIDTH_OFFSET)} * screenPerWorld;
      float outlineAlpha = clamp(screenPxDist + 0.5 + strokePx, 0.0, 1.0);
      vec3 rgb = mix(strokeColor.rgb, base.rgb, fillAlpha);
      float a = outlineAlpha * mix(strokeColor.a, base.a, fillAlpha);
      color = vec4(rgb, a);
    }
  }

  // Most commonly a glyph quad's margin outside the actual ink, where coverage alpha is 0.
  if (color.a <= 0.0) discard;
  fragColor = color;
}
`
