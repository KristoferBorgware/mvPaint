// Filling an array texture's mip chain, for the MSDF atlas.
//
// WebGL2 has generateMipmap() and WebGPU deliberately has nothing of the kind: a mip chain is
// filled by rendering into it, and which filter is right is the application's business rather
// than the API's. So this is that render - a full-screen triangle per level, sampling the level
// above it, once per array layer.
//
// Built on demand and thrown away with the atlas that asked for it. It runs when a font book is
// created or replaced, which is a handful of times in a session, and holding a pipeline against
// that would keep a shader module alive for the life of the device to save microseconds.

import { atlasMipLevels } from '../text/msdfProvider'

const MIPMAP_SHADER = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

// One oversized triangle rather than two triangles of a quad: it covers the target with no seam
// down the diagonal, where a quad's two halves meet and interpolation has to agree exactly.
@vertex
fn vs_main(@builtin(vertex_index) index : u32) -> VertexOutput {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let corner = corners[index];
  var out : VertexOutput;
  out.position = vec4<f32>(corner, 0.0, 1.0);
  // Clip space is y-up and texture space is y-down, so v is flipped rather than scaled.
  out.uv = vec2<f32>((corner.x + 1.0) * 0.5, (1.0 - corner.y) * 0.5);
  return out;
}

@group(0) @binding(0) var source : texture_2d<f32>;
@group(0) @binding(1) var sourceSampler : sampler;

@fragment
fn fs_main(input : VertexOutput) -> @location(0) vec4<f32> {
  // A linear tap at the centre of each destination texel averages the four above it, which is
  // the box filter generateMipmap() would have applied.
  return textureSample(source, sourceSampler, input.uv);
}
`

/**
 * Fill every level below the first, for every layer, of a texture whose level 0 is already
 * written.
 *
 * The texture must carry RENDER_ATTACHMENT usage - it is drawn into here, not copied into - and
 * must have been created with the level count atlasMipLevels() gives, which is what the caller
 * allocated it with.
 *
 * Nothing happens for a single-level texture, which is the empty-atlas case.
 */
export function fillAtlasMipmaps(
  device: GPUDevice,
  texture: GPUTexture,
  layers: number,
): void {
  const levels = atlasMipLevels({ width: texture.width, height: texture.height })
  if (levels <= 1 || texture.mipLevelCount <= 1) return

  const module = device.createShaderModule({ label: 'atlas:mipmap', code: MIPMAP_SHADER })
  const pipeline = device.createRenderPipeline({
    label: 'atlas:mipmap',
    layout: 'auto',
    vertex: { module, entryPoint: 'vs_main' },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format: texture.format }] },
    primitive: { topology: 'triangle-list' },
  })
  const sampler = device.createSampler({
    label: 'atlas:mipmap',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  })

  const encoder = device.createCommandEncoder({ label: 'atlas:mipmap' })
  for (let layer = 0; layer < layers; layer++) {
    for (let level = 1; level < texture.mipLevelCount; level++) {
      // A 2d view of one layer at one level: the shader samples a plain 2d texture, so the layer
      // is chosen here rather than passed through as a uniform.
      const source = texture.createView({
        dimension: '2d',
        baseArrayLayer: layer,
        arrayLayerCount: 1,
        baseMipLevel: level - 1,
        mipLevelCount: 1,
      })
      const target = texture.createView({
        dimension: '2d',
        baseArrayLayer: layer,
        arrayLayerCount: 1,
        baseMipLevel: level,
        mipLevelCount: 1,
      })
      const pass = encoder.beginRenderPass({
        label: `atlas:mipmap L${layer}.${level}`,
        colorAttachments: [
          // Cleared rather than loaded: the triangle covers every texel of the target, so
          // whatever was there is about to be replaced anyway and clearing skips a read.
          { view: target, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        ],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: source },
            { binding: 1, resource: sampler },
          ],
        }),
      )
      pass.draw(3)
      pass.end()
    }
  }
  device.queue.submit([encoder.finish()])
}
