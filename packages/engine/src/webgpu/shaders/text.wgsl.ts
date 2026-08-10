// text-lane shader (MSDF). Each vertex carries a local position, an atlas UV, a color, and a
// packed id (object/material index + an "is glyph" flag). Glyph fragments recover coverage
// from the multi-channel signed distance field (median of RGB) and anti-alias it in screen
// space via the field's screen-pixel range (derived with fwidth, so it stays crisp as the
// camera zooms in, and fades out once the text is smaller than the field can describe - see
// fieldPxRange); an optional per-letter outline widens that coverage. Non-glyph fragments
// (underline, strikethrough, highlight) return their flat color or per-run gradient with no
// MSDF sampling, and so keep drawing at any size.
export const textShaderCode = /* wgsl */ `
const MAX_STOPS: u32 = 8u;
const GLYPH_BIT: u32 = 0x80000000u;
const OBJECT_ID_MASK: u32 = 0x7fffffffu;
const FILL_COLOR: u32 = 0u;
const FILL_LINEAR: u32 = 1u;
const FILL_RADIAL: u32 = 2u;

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
  // Byte 132, in what WGSL would otherwise pad before stopColors' 16-byte alignment.
  opacity : f32,
  stopColors : array<vec4<f32>, MAX_STOPS>,
  strokeColor : vec4<f32>,
  strokeWidth : f32,
  hasStroke : u32,
  distanceRange : f32,
  dilate : f32,
  atlasLayer : u32,
};

@group(0) @binding(0) var<uniform> frame : Frame;
@group(1) @binding(0) var<storage, read> objects : array<ObjectData>;
// All four Inter styles in one texture, one layer each - so a paragraph that mixes them is
// still a single draw. Which layer a glyph reads is a per-run value in its object record; see
// webgpu/MSDFFontBook.ts.
@group(2) @binding(0) var atlasTex : texture_2d_array<f32>;
@group(2) @binding(1) var atlasSampler : sampler;

struct VertexInput {
  @location(0) position : vec2<f32>,
  @location(1) uv : vec2<f32>,
  @location(2) color : vec4<f32>,
  @location(3) packedId : u32,
};

struct VertexOutput {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec4<f32>,
  @location(2) localPos : vec2<f32>,
  @location(3) @interpolate(flat) packedId : u32,
};

@vertex
fn vs_main(input : VertexInput) -> VertexOutput {
  let objectId = input.packedId & OBJECT_ID_MASK;
  let model = objects[objectId].model;
  var out : VertexOutput;
  out.clip = frame.viewProjection * model * vec4<f32>(input.position, 0.0, 1.0);
  // MSDFText sits at local/world z=0 like every mesh-lane shape - its stacking order (from
  // its zIndex, see scene/picking.ts) is injected here the same way, so a shape can sit
  // in front of text (or vice versa) instead of the text lane always winning.
  out.clip.z = objects[objectId].depth * out.clip.w;
  out.uv = input.uv;
  out.color = input.color;
  out.localPos = input.position;
  out.packedId = input.packedId;
  return out;
}

fn linearGradientT(p : vec2<f32>, start : vec2<f32>, end : vec2<f32>) -> f32 {
  let axis = end - start;
  let axisLenSq = dot(axis, axis);
  if (axisLenSq < 1e-8) {
    return 0.0;
  }
  return dot(p - start, axis) / axisLenSq;
}

fn radialGradientT(p : vec2<f32>, c0 : vec2<f32>, r0 : f32, c1 : vec2<f32>, r1 : f32) -> f32 {
  let dc = c1 - c0;
  let dr = r1 - r0;
  let pc = p - c0;
  let a = dot(dc, dc) - dr * dr;
  let b = -2.0 * (dot(pc, dc) + r0 * dr);
  let c = dot(pc, pc) - r0 * r0;

  if (abs(a) < 1e-6) {
    if (abs(b) < 1e-6) {
      return 0.0;
    }
    return -c / b;
  }

  let disc = b * b - 4.0 * a * c;
  if (disc < 0.0) {
    return 1.0;
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

fn median(v : vec3<f32>) -> f32 {
  return max(min(v.r, v.g), min(max(v.r, v.g), v.b));
}

// Base fill for both glyph body and solid decoration: the per-vertex color, or the object's
// per-run gradient evaluated at the fragment's local position.
fn baseColor(obj : ObjectData, vertexColor : vec4<f32>, localPos : vec2<f32>) -> vec4<f32> {
  if (obj.fillType == FILL_LINEAR) {
    let t = clamp(linearGradientT(localPos, obj.gradientStart, obj.gradientEnd), 0.0, 1.0);
    return sampleGradient(obj, t);
  }
  if (obj.fillType == FILL_RADIAL) {
    let t = clamp(
      radialGradientT(localPos, obj.gradientStart, obj.gradientStartRadius, obj.gradientEnd, obj.gradientEndRadius),
      0.0, 1.0,
    );
    return sampleGradient(obj, t);
  }
  return vertexColor;
}

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  let obj = objects[input.packedId & OBJECT_ID_MASK];

  // Derivative-based quantities (texture sample + fwidth) must run in uniform control flow, so
  // they are evaluated before any branch on the per-fragment glyph flag.
  let msd = textureSample(atlasTex, atlasSampler, input.uv, obj.atlasLayer).rgb;
  let uvDeriv = fwidth(input.uv);
  let localDeriv = fwidth(input.localPos);

  var color : vec4<f32>;
  if ((input.packedId & GLYPH_BIT) == 0u) {
    // Solid text decoration (underline / strikethrough / highlight): its own flat color, no MSDF.
    color = input.color;
  } else {
    // Glyph body: the run's flat color, or its per-run gradient evaluated in local space.
    let base = baseColor(obj, input.color, input.localPos);

    // World-px widths (stroke, dilation) are converted to screen px via the local derivative, so
    // they scale with the text under camera zoom.
    let screenPerWorld = 2.0 / max(abs(localDeriv.x) + abs(localDeriv.y), 1e-5);

    // Glyph coverage from the median distance, anti-aliased over the field's screen-px range.
    // The dilate term widens coverage (faux bold, and the spread of glow/shadow copies).
    let sd = median(msd);
    // textureDimensions of an array texture is one LAYER's size, which is exactly what the uvs
    // are measured against too (see text/msdfMetrics.ts) - so packing a smaller font image into
    // a larger shared layer scales uvDeriv down and unitRange up by the same factor, and the
    // screen-pixel range below comes out unchanged.
    let unitRange = vec2<f32>(obj.distanceRange) / vec2<f32>(textureDimensions(atlasTex));
    let screenTexSize = vec2<f32>(1.0) / uvDeriv;
    let fieldPxRange = 0.5 * dot(unitRange, screenTexSize);
    let screenPxRange = max(fieldPxRange, 1.0);
    let screenPxDist = screenPxRange * (sd - 0.5) + obj.dilate * screenPerWorld;
    let fillAlpha = clamp(screenPxDist + 0.5, 0.0, 1.0);

    if (obj.hasStroke == 0u) {
      color = vec4<f32>(base.rgb, base.a * fillAlpha);
    } else {
      // Outline: widen coverage further by the stroke width, in the stroke color under the body.
      let strokePx = obj.strokeWidth * screenPerWorld;
      let outlineAlpha = clamp(screenPxDist + 0.5 + strokePx, 0.0, 1.0);
      let rgb = mix(obj.strokeColor.rgb, base.rgb, fillAlpha);
      let a = outlineAlpha * mix(obj.strokeColor.a, base.a, fillAlpha);
      color = vec4<f32>(rgb, a);
    }

    // SHRINKING PAST THE FIELD. The clamp above is what keeps the ramp from inverting once a
    // screen pixel is wider than the whole distance field, and the price of it is that the ramp
    // stops narrowing: at that size the coverage IS the raw distance, which fades from 1 at the
    // glyph's centre to 0 at the far edge of the field, and the letters wear a soft fringe the
    // full width of that field. Below one field-width per pixel the text is smaller than it can
    // be drawn, so it is faded out over that last stretch rather than left as a smudge. On the
    // atlases here (a 4-texel field on a 42-texel em) the fade begins at about ten screen pixels
    // per em and reaches nothing at one.
    color.a = color.a * clamp(fieldPxRange, 0.0, 1.0);
  }

  // The object's own transparency, applied last and to the alpha only - these lanes blend
  // straight (non-premultiplied) alpha, so scaling rgb would darken rather than fade.
  color.a = color.a * obj.opacity;

  // A fully transparent fragment - most commonly a glyph quad's margin outside the actual
  // glyph ink, where MSDF coverage alpha is 0 - contributes nothing: blending at alpha 0
  // leaves the destination exactly as it was. Discarding skips that blend instead of
  // performing it. Nothing behind the quad depends on it: text is drawn entirely in the
  // translucent pass and never writes depth at all (see webgpu/pipelines/TextPipeline.ts).
  if (color.a <= 0.0) {
    discard;
  }
  return color;
}
`
