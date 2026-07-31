// The mesh lane's shader, GLSL ES 300 - the twin of render/mesh.wgsl.ts.
//
// Same maths, same record, two differences that are both forced by the API:
//
//   1. THE OBJECT ARRAY IS A TEXTURE. No storage buffers in WebGL2 (see ObjectTexture.ts), so
//      `objects[id].field` becomes a texelFetch at a computed coordinate. Everything below
//      named OBJ_* is that arithmetic, and every one of those numbers is INTERPOLATED FROM
//      render/meshFormat.ts rather than written out here. That is the whole reason this file
//      is a template string: the two shaders cannot drift apart, because there is only one
//      copy of the offsets and this reads it.
//
//   2. CLIP Z IS [-1, 1]. WebGPU's is [0, 1], and the depth in an object record is in that
//      convention (see scene/picking.ts's depthForRank). One `* 2 - 1` in the vertex shader
//      is the entire fix - the camera, the projection matrix and screenToWorld are all left
//      exactly as they are, so a pick and a draw still agree.
//
// The fragment shader early-outs on a solid fill. A gradient needs about a dozen dependent
// texel fetches - the parameters, eight stop positions, eight stop colours - and while that is
// affordable on a fallback, paying it for every flat-coloured rectangle in the scene would not
// be. A solid fill costs two fetches: the fill type, and the colour.

import {
  MAX_GRADIENT_STOPS,
  MESH_FILL_BIT,
  MESH_OBJECT_ID_MASK,
  OBJECT_DEPTH_OFFSET,
  OBJECT_FILL_COLOR_OFFSET,
  OBJECT_FILL_TYPE_OFFSET,
  OBJECT_GRADIENT_END_OFFSET,
  OBJECT_GRADIENT_END_RADIUS_OFFSET,
  OBJECT_GRADIENT_START_OFFSET,
  OBJECT_GRADIENT_START_RADIUS_OFFSET,
  OBJECT_STOP_COLORS_OFFSET,
  OBJECT_STOP_COUNT_OFFSET,
  OBJECT_STOP_POSITIONS_OFFSET,
  OBJECT_STRIDE,
  OBJECT_STROKE_COLOR_OFFSET,
} from '../../render/meshFormat'

/** Which texel of a record a byte offset lands in. */
export const texelOf = (byteOffset: number): number => byteOffset >> 4
/** Which component (x/y/z/w) of that texel a byte offset lands in. */
export const componentOf = (byteOffset: number): number => (byteOffset >> 2) & 3

const COMPONENT = ['x', 'y', 'z', 'w'] as const
/** A record field as a GLSL expression, e.g. `obj(id, 5).y`. */
const field = (byteOffset: number): string => `obj(id, ${texelOf(byteOffset)}).${COMPONENT[componentOf(byteOffset)]}`
/** A vec2 field. Every vec2 in these records is 8-byte aligned, so it never straddles a texel. */
const field2 = (byteOffset: number): string => {
  const c = componentOf(byteOffset)
  return `obj(id, ${texelOf(byteOffset)}).${COMPONENT[c]}${COMPONENT[c + 1]}`
}

/** Shared preamble: the record layout, and the fetch that reads it. */
const OBJECT_ACCESS = /* glsl */ `
const int OBJ_TEXELS = ${OBJECT_STRIDE / 16};
const uint FILL_BIT = ${MESH_FILL_BIT >>> 0}u;
const uint OBJECT_ID_MASK = ${MESH_OBJECT_ID_MASK >>> 0}u;
const int MAX_STOPS = ${MAX_GRADIENT_STOPS};

uniform highp sampler2D u_objects;
uniform int u_objectsWidth;

vec4 obj(uint objectId, int i) {
  int t = int(objectId) * OBJ_TEXELS + i;
  return texelFetch(u_objects, ivec2(t % u_objectsWidth, t / u_objectsWidth), 0);
}
`

export const meshVertexGlsl = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${OBJECT_ACCESS}
layout(location = 0) in vec2 a_position;
layout(location = 1) in uint a_packedId;

uniform mat4 u_viewProjection;

out vec2 v_localPos;
flat out uint v_packedId;

void main() {
  uint id = a_packedId & OBJECT_ID_MASK;
  // Texels 0..3 ARE the model matrix's four columns - Matrix4x4.toGPU() is column-major and
  // the record starts with it, so no unpacking is needed.
  mat4 model = mat4(obj(id, 0), obj(id, 1), obj(id, 2), obj(id, 3));
  vec4 clip = u_viewProjection * model * vec4(a_position, 0.0, 1.0);
  // Every 2D shape sits at local/world z = 0, so the projected z carries nothing. The object's
  // stacking order goes in instead - remapped from WebGPU's [0,1] clip range to GL's [-1,1],
  // and scaled by w so it survives the perspective divide intact.
  clip.z = (${field(OBJECT_DEPTH_OFFSET)} * 2.0 - 1.0) * clip.w;
  gl_Position = clip;
  v_localPos = a_position;
  v_packedId = a_packedId;
}
`

export const meshFragmentGlsl = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${OBJECT_ACCESS}
in vec2 v_localPos;
flat in uint v_packedId;

out vec4 fragColor;

// Interpolation factor along a linear gradient's axis, unclamped (the caller clamps).
float linearGradientT(vec2 p, vec2 start, vec2 end) {
  vec2 axis = end - start;
  float axisLenSq = dot(axis, axis);
  if (axisLenSq < 1e-8) return 0.0;
  return dot(p - start, axis) / axisLenSq;
}

// Canvas2D-style two-circle radial gradient: find t such that p lies on the circle
// interpolated between (c0,r0) and (c1,r1), preferring the largest t whose circle has a
// non-negative radius.
float radialGradientT(vec2 p, vec2 c0, float r0, vec2 c1, float r1) {
  vec2 dc = c1 - c0;
  float dr = r1 - r0;
  vec2 pc = p - c0;
  float a = dot(dc, dc) - dr * dr;
  float b = -2.0 * (dot(pc, dc) + r0 * dr);
  float c = dot(pc, pc) - r0 * r0;

  if (abs(a) < 1e-6) {
    if (abs(b) < 1e-6) return 0.0; // degenerate: identical zero-radius circles
    return -c / b;
  }

  float disc = b * b - 4.0 * a * c;
  if (disc < 0.0) return 1.0; // outside both circles' cone: clamp to the end colour
  float sq = sqrt(disc);
  float t0 = (-b + sq) / (2.0 * a);
  float t1 = (-b - sq) / (2.0 * a);
  float hi = max(t0, t1);
  float lo = min(t0, t1);
  return (r0 + hi * dr >= 0.0) ? hi : lo;
}

// A stop position is one float in a packed array, so it needs both a texel and a component.
// A stop COLOUR is a whole texel, because the array is 16-byte aligned - hence the asymmetry.
float stopPosition(uint id, int s) {
  int f = ${OBJECT_STOP_POSITIONS_OFFSET / 4} + s;
  return obj(id, f >> 2)[f & 3];
}
vec4 stopColor(uint id, int s) {
  return obj(id, ${OBJECT_STOP_COLORS_OFFSET / 16} + s);
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

void main() {
  bool isFill = (v_packedId & FILL_BIT) != 0u;
  uint id = v_packedId & OBJECT_ID_MASK;

  vec4 color;
  if (!isFill) {
    color = obj(id, ${OBJECT_STROKE_COLOR_OFFSET / 16});
  } else {
    // Stored as a float rather than reinterpreted u32 bits - see ObjectTexture.ts.
    float fillType = ${field(OBJECT_FILL_TYPE_OFFSET)};
    if (fillType < 0.5) {
      color = obj(id, ${OBJECT_FILL_COLOR_OFFSET / 16});
    } else {
      float t;
      if (fillType < 1.5) {
        t = linearGradientT(v_localPos, ${field2(OBJECT_GRADIENT_START_OFFSET)}, ${field2(OBJECT_GRADIENT_END_OFFSET)});
      } else {
        t = radialGradientT(
          v_localPos,
          ${field2(OBJECT_GRADIENT_START_OFFSET)}, ${field(OBJECT_GRADIENT_START_RADIUS_OFFSET)},
          ${field2(OBJECT_GRADIENT_END_OFFSET)}, ${field(OBJECT_GRADIENT_END_RADIUS_OFFSET)}
        );
      }
      color = sampleGradient(id, int(${field(OBJECT_STOP_COUNT_OFFSET)}), clamp(t, 0.0, 1.0));
    }
  }

  // A fully transparent fragment contributes nothing - straight-alpha blending at alpha 0
  // leaves the destination byte for byte as it was - so discarding skips the blend rather
  // than performing it.
  if (color.a <= 0.0) discard;
  fragColor = color;
}
`
