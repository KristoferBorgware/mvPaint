// Fullscreen filter shader shared by every step of shadow post-processing (see
// ShadowRenderer): a separable "spread" (morphological max-dilate) pass, a separable
// gaussian blur pass, and a plain composite (blend the source texture over whatever it's
// drawn onto). All three share one vertex shader (a fullscreen triangle, no vertex
// buffer - built from vertex_index alone) and one set of bindings; only the fragment
// entry point differs per pipeline.
//
// Both filters are separable (run once horizontally, once vertically): `direction` is a
// unit texel step (1,0) or (0,1), so a 2D NxN kernel becomes two 1D passes, same trick
// used for gaussian blur everywhere. The max-filter dilation approximates true outward
// silhouette growth (spread) - exact for the two axes tested, a rounded-square
// approximation for other directions rather than a perfect circular offset, which real
// polygon offsetting would need; acceptable softened-shadow fidelity for the cost.
export const blurFilterShaderCode = /* wgsl */ `
struct FilterParams {
  radius : f32,   // sampling radius, in source-texture texels (already rounded)
  direction : vec2<f32>, // (1,0) for the horizontal pass, (0,1) for the vertical pass
  texel : vec2<f32>,     // 1/textureWidth, 1/textureHeight
};

@group(0) @binding(0) var<uniform> params : FilterParams;
@group(1) @binding(0) var srcTex : texture_2d<f32>;
@group(1) @binding(1) var srcSampler : sampler;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_fullscreen(@builtin(vertex_index) i : u32) -> VOut {
  // Fullscreen triangle covering the viewport, generated from the vertex index alone -
  // no vertex buffer needed since every filter pass draws the same three vertices.
  let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(i & 2u) * 2.0 - 1.0;
  var out : VOut;
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}

const MAX_RADIUS : i32 = 64;

@fragment
fn fs_dilate(in : VOut) -> @location(0) vec4<f32> {
  let r = min(i32(round(params.radius)), MAX_RADIUS);
  if (r <= 0) {
    return textureSample(srcTex, srcSampler, in.uv);
  }
  var best = vec4<f32>(0.0);
  for (var i = -r; i <= r; i = i + 1) {
    let uv = in.uv + params.direction * params.texel * f32(i);
    let s = textureSample(srcTex, srcSampler, uv);
    if (s.a > best.a) {
      best = s;
    }
  }
  return best;
}

@fragment
fn fs_blur(in : VOut) -> @location(0) vec4<f32> {
  let r = min(i32(round(params.radius)), MAX_RADIUS);
  if (r <= 0) {
    return textureSample(srcTex, srcSampler, in.uv);
  }
  let sigma = f32(r) / 2.0;
  let twoSigmaSq = 2.0 * sigma * sigma;
  var sum = vec4<f32>(0.0);
  var weightSum = 0.0;
  for (var i = -r; i <= r; i = i + 1) {
    let fi = f32(i);
    let w = exp(-(fi * fi) / twoSigmaSq);
    let uv = in.uv + params.direction * params.texel * fi;
    sum = sum + textureSample(srcTex, srcSampler, uv) * w;
    weightSum = weightSum + w;
  }
  return sum / weightSum;
}

@fragment
fn fs_composite(in : VOut) -> @location(0) vec4<f32> {
  return textureSample(srcTex, srcSampler, in.uv);
}
`
