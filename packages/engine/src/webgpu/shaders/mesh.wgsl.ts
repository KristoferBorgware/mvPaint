// Mesh-lane shader. Every 2D shape flows through this: per-vertex position (local) and
// a packed id (object index + an "is fill" flag) that indexes the per-object world
// matrix and fill/gradient/stroke material - there is no per-vertex color at all. The
// fragment either returns the object's flat strokeColor/fillColor (stroke, and solid
// fill) or evaluates a linear/radial gradient analytically from the fragment's
// local-space position.
export const meshShaderCode = /* wgsl */ `
const MAX_STOPS: u32 = 8u;
const FILL_BIT: u32 = 0x80000000u;
const OBJECT_ID_MASK: u32 = 0x7fffffffu;
const FILL_COLOR: u32 = 0u;
const FILL_LINEAR: u32 = 1u;
const FILL_RADIAL: u32 = 2u;
// A shape with nothing to fill with. Its triangles still exist - picking needs them - and
// come out transparent. See FillPriority in render/meshFormat.ts.
const FILL_NONE: u32 = 3u;

struct Frame {
  viewProjection : mat4x4<f32>,
  resolution : vec2<f32>,
};

struct ObjectData {
  model : mat4x4<f32>,
  fillType : u32,
  stopCount : u32,
  gradientStart : vec2<f32>,
  gradientStartRadius : f32,
  depth : f32,
  gradientEnd : vec2<f32>,
  gradientEndRadius : f32,
  stopPositions : array<f32, MAX_STOPS>,
  // Lands at byte 132, in what WGSL would otherwise pad out before stopColors' 16-byte
  // alignment - so carrying it costs the record nothing. See render/meshFormat.ts.
  opacity : f32,
  stopColors : array<vec4<f32>, MAX_STOPS>,
  fillColor : vec4<f32>,
  strokeColor : vec4<f32>,
};

@group(0) @binding(0) var<uniform> frame : Frame;
@group(1) @binding(0) var<storage, read> objects : array<ObjectData>;

struct VertexInput {
  @location(0) position : vec2<f32>,
  @location(1) packedId : u32,
};

struct VertexOutput {
  @builtin(position) clip : vec4<f32>,
  @location(0) localPos : vec2<f32>,
  @location(1) @interpolate(flat) packedId : u32,
};

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  let objectId = input.packedId & OBJECT_ID_MASK;
  let model = objects[objectId].model;
  var out : VertexOutput;
  out.clip = frame.viewProjection * model * vec4<f32>(input.position, 0.0, 1.0);
  // Every 2D shape sits at local/world z=0, so the projected z above carries no useful
  // depth on its own - the object's stacking order (from its zIndex, see
  // scene/picking.ts) is injected here instead, scaled by w so it survives the GPU's
  // perspective divide intact (w is always 1 for this orthographic camera, but this
  // stays correct if that ever changes).
  out.clip.z = objects[objectId].depth * out.clip.w;
  out.localPos = input.position;
  out.packedId = input.packedId;
  return out;
}

// Interpolation factor along a linear gradient's axis, unclamped (the caller clamps).
fn linearGradientT(p : vec2<f32>, start : vec2<f32>, end : vec2<f32>) -> f32 {
  let axis = end - start;
  let axisLenSq = dot(axis, axis);
  if (axisLenSq < 1e-8) {
    return 0.0;
  }
  return dot(p - start, axis) / axisLenSq;
}

// Interpolation factor for a Canvas2D-style two-circle radial gradient: find t such
// that p lies on the circle interpolated between (c0,r0) and (c1,r1) - center(t) =
// lerp(c0,c1,t), radius(t) = lerp(r0,r1,t), |p - center(t)| = radius(t) - preferring
// the largest t whose circle has a non-negative radius.
fn radialGradientT(p : vec2<f32>, c0 : vec2<f32>, r0 : f32, c1 : vec2<f32>, r1 : f32) -> f32 {
  let dc = c1 - c0;
  let dr = r1 - r0;
  let pc = p - c0;
  let a = dot(dc, dc) - dr * dr;
  let b = -2.0 * (dot(pc, dc) + r0 * dr);
  let c = dot(pc, pc) - r0 * r0;

  if (abs(a) < 1e-6) {
    if (abs(b) < 1e-6) {
      return 0.0; // degenerate: identical zero-radius circles, no well-defined gradient
    }
    return -c / b;
  }

  let disc = b * b - 4.0 * a * c;
  if (disc < 0.0) {
    return 1.0; // outside both circles' cone: clamp to the end color
  }
  let sq = sqrt(disc);
  let t0 = (-b + sq) / (2.0 * a);
  let t1 = (-b - sq) / (2.0 * a);
  let hi = max(t0, t1);
  let lo = min(t0, t1);
  if (r0 + hi * dr >= 0.0) {
    return hi;
  }
  return lo;
}

fn sampleGradient(obj : ObjectData, t : f32) -> vec4<f32> {
  let n = obj.stopCount;
  if (n == 0u) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }
  if (n == 1u || t <= obj.stopPositions[0]) {
    return obj.stopColors[0];
  }
  if (t >= obj.stopPositions[n - 1u]) {
    return obj.stopColors[n - 1u];
  }
  for (var i = 0u; i < n - 1u; i = i + 1u) {
    let p0 = obj.stopPositions[i];
    let p1 = obj.stopPositions[i + 1u];
    if (t >= p0 && t <= p1) {
      var localT = 0.0;
      if (p1 > p0) {
        localT = (t - p0) / (p1 - p0);
      }
      return mix(obj.stopColors[i], obj.stopColors[i + 1u], localT);
    }
  }
  return obj.stopColors[n - 1u];
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let isFill = (input.packedId & FILL_BIT) != 0u;
  let obj = objects[input.packedId & OBJECT_ID_MASK];

  var color : vec4<f32>;
  if (!isFill) {
    color = obj.strokeColor;
  } else if (obj.fillType == FILL_NONE) {
    color = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  } else if (obj.fillType == FILL_COLOR) {
    color = obj.fillColor;
  } else {
    var t : f32;
    if (obj.fillType == FILL_LINEAR) {
      t = linearGradientT(input.localPos, obj.gradientStart, obj.gradientEnd);
    } else {
      t = radialGradientT(
        input.localPos, obj.gradientStart, obj.gradientStartRadius,
        obj.gradientEnd, obj.gradientEndRadius,
      );
    }
    t = clamp(t, 0.0, 1.0);
    color = sampleGradient(obj, t);
  }

  // The object's own transparency, applied last and to the alpha only - the pipeline blends
  // straight (non-premultiplied) alpha, so scaling rgb here would darken the shape instead of
  // fading it. See Shape.opacity, and render/opacity.ts for why anything below 1 keeps the
  // shape out of the opaque pass.
  color.a = color.a * obj.opacity;

  // A fully transparent fragment (e.g. a selection-highlight's invisible fill) contributes
  // nothing at all: straight-alpha blending at alpha 0 leaves the destination byte for byte
  // as it was. Discarding skips that blend instead of performing it.
  //
  // It decides nothing about depth any more. A shape that can paint a transparent fragment
  // is translucent by definition (see render/opacity.ts), and the translucent pass does not
  // write depth; the opaque pass, which does, is only ever given shapes that cannot get
  // here. See webgpu/SceneRenderer's draw() for the two passes.
  if (color.a <= 0.0) {
    discard;
  }
  return color;
}
`
