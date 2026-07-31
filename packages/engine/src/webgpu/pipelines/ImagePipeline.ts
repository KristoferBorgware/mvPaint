// The image-lane render pipeline: the image vertex layout (position + uv + packedId), the
// same straight-alpha blending, no culling, depth test and MSAA as the mesh and text lanes -
// the same depth buffer above all, so an image, a shape and a run of text interleave by
// zIndex instead of by which lane draws last (see scene/picking.ts).
//
// The pipeline layout is the text lane's: frame (0), objects (1), and a sampled texture (2).
// group(2)'s layout is shared with the font atlases because it describes the same thing - a
// float texture and a sampler - so one layout serves both.
//
// Images are drawn entirely in the translucent pass, so there is only ever this one variant
// and it does not write depth. What is in a texture is the application's business and is
// never read back, so nothing on the CPU can rule out an alpha channel - see
// render/opacity.ts - and an image quad must therefore never reject what is behind it.

import { imageShaderCode } from '../shaders/image.wgsl'
import { IMAGE_VERTEX_LAYOUT } from '../vertexLayouts'
import { DEPTH_COMPARE, DEPTH_FORMAT } from '../depthFormat'

export function createImagePipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  sampleCount: number,
  layout: GPUPipelineLayout,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: imageShaderCode })

  return device.createRenderPipeline({
    label: 'image',
    layout,
    vertex: {
      module,
      entryPoint: 'vs_main',
      buffers: [IMAGE_VERTEX_LAYOUT],
    },
    fragment: {
      module,
      entryPoint: 'fs_main',
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: 'src-alpha',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
            alpha: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
          },
        },
      ],
    },
    primitive: {
      topology: 'triangle-list',
      cullMode: 'none',
    },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: false,
      depthCompare: DEPTH_COMPARE,
    },
    multisample: {
      count: sampleCount,
    },
  })
}
