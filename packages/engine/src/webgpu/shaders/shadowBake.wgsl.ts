// Shaders that BAKE a shape's blurred silhouette into the shadow atlas (see ShadowAtlas.ts).
// These run only when a shape's geometry or shadowBlur changes - never per frame - so the
// atlas is a cache, not a render target the frame loop depends on.
//
// The silhouette pass rasterizes the shape's own local-space triangles as flat coverage
// into a single-channel target: a shadow is a stencil of the shape, so only "is this texel
// covered" matters, not any fill/gradient/stroke color. `project` maps local space into the
// region's clip space; it is the one place the shape's local bounds and the blur padding
// meet, and it deliberately involves nothing from the shape's transform.

/** Rasterizes local-space triangles as flat coverage. Target is single-channel (r8unorm). */
export const shadowSilhouetteShaderCode = /* wgsl */ `
struct Project {
  // ndc = position * scale + offset - an orthographic map from the shape's local space
  // onto the region's clip space, with the blur padding already folded in.
  scale : vec2<f32>,
  offset : vec2<f32>,
};

@group(0) @binding(0) var<uniform> project : Project;

@vertex
fn vs_main(@location(0) position : vec2<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(position * project.scale + project.offset, 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
`

// One axis of a separable morphological dilate/erode - the shadowSpread extension, run on
// the raw silhouette BEFORE the Gaussian so the blur softens the already-grown edge (the
// CSS box-shadow order).
//
// A positive radius takes the maximum over the window (growing coverage outward), a
// negative one the minimum (eroding it inward). Running it once per axis makes the
// structuring element a SQUARE rather than a disc, so a spread corner is squared off rather
// than rounded - the same simplification SVG's feMorphology makes, and for the same reason:
// a true circular offset needs a distance transform, which costs far more than the effect
// is worth here. Any blur applied afterwards rounds the corners back off, so the difference
// only really shows on a large spread with little or no blur.
export const shadowMorphologyShaderCode = /* wgsl */ `
struct MorphParams {
  step : vec2<f32>,
  sourceScale : vec2<f32>,
  // Signed: > 0 dilates, < 0 erodes, 0 passes through.
  radius : f32,
  pad : f32,
};

@group(0) @binding(0) var<uniform> params : MorphParams;
@group(1) @binding(0) var srcTex : texture_2d<f32>;
@group(1) @binding(1) var srcSampler : sampler;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_fullscreen(@builtin(vertex_index) i : u32) -> VOut {
  let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(i & 2u) * 2.0 - 1.0;
  var out : VOut;
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}

const MAX_TAPS : i32 = 128;

@fragment
fn fs_morphology(in : VOut) -> @location(0) vec4<f32> {
  let base = in.uv * params.sourceScale;
  let r = min(i32(abs(params.radius)), MAX_TAPS);
  if (r <= 0) {
    return textureSample(srcTex, srcSampler, base);
  }
  let dilate = params.radius > 0.0;

  var acc = textureSample(srcTex, srcSampler, base).r;
  for (var i = 1; i <= r; i = i + 1) {
    let delta = params.step * f32(i);
    let a = textureSample(srcTex, srcSampler, base + delta).r;
    let b = textureSample(srcTex, srcSampler, base - delta).r;
    if (dilate) {
      acc = max(acc, max(a, b));
    } else {
      acc = min(acc, min(a, b));
    }
  }
  return vec4<f32>(acc, 0.0, 0.0, 1.0);
}
`

// One axis of a separable Gaussian. Canvas 2D defines shadowBlur as a Gaussian of
// sigma = shadowBlur/2 (see shadowMath.ts), and a 2D Gaussian is separable, so running
// this once horizontally and once vertically costs 2*(2R+1) taps instead of (2R+1)^2 -
// which is what keeps a large blur radius affordable even though it is only ever paid on a
// cache miss.
//
// Both passes read a sub-rectangle of a scratch texture rather than a tightly-sized one:
// `sourceScale` maps the pass's 0..1 viewport coordinates onto just the region's slice of
// it, so one pair of scratch textures serves every shadow regardless of its size.
export const shadowBlurShaderCode = /* wgsl */ `
struct BlurParams {
  // Texel step along the axis being blurred, in SOURCE texture uv units.
  step : vec2<f32>,
  // Region size as a fraction of the scratch texture, so uv 0..1 covers the region only.
  sourceScale : vec2<f32>,
  sigma : f32,
  radius : f32,
};

@group(0) @binding(0) var<uniform> params : BlurParams;
@group(1) @binding(0) var srcTex : texture_2d<f32>;
@group(1) @binding(1) var srcSampler : sampler;

struct VOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_fullscreen(@builtin(vertex_index) i : u32) -> VOut {
  // A single oversized triangle covering the viewport, built from the vertex index alone -
  // no vertex buffer, and uv comes out as 0..1 across the VIEWPORT (not the framebuffer),
  // which is what lets the same shader write into an arbitrary sub-rect of the atlas.
  let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(i & 2u) * 2.0 - 1.0;
  var out : VOut;
  out.pos = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}

const MAX_TAPS : i32 = 128;

@fragment
fn fs_blur(in : VOut) -> @location(0) vec4<f32> {
  let base = in.uv * params.sourceScale;
  let r = min(i32(params.radius), MAX_TAPS);
  if (r <= 0) {
    return textureSample(srcTex, srcSampler, base);
  }

  let twoSigmaSq = 2.0 * params.sigma * params.sigma;
  // The centre tap, weight exp(0) = 1, then symmetric pairs - halving the tap count by
  // reusing each weight for +i and -i.
  var sum = textureSample(srcTex, srcSampler, base).r;
  var weightSum = 1.0;
  for (var i = 1; i <= r; i = i + 1) {
    let fi = f32(i);
    let w = exp(-(fi * fi) / twoSigmaSq);
    let delta = params.step * fi;
    sum = sum + w * textureSample(srcTex, srcSampler, base + delta).r;
    sum = sum + w * textureSample(srcTex, srcSampler, base - delta).r;
    weightSum = weightSum + 2.0 * w;
  }
  return vec4<f32>(sum / weightSum, 0.0, 0.0, 1.0);
}
`
