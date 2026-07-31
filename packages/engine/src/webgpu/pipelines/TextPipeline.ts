// The text-lane render pipeline: the text vertex layout (position + uv + color + packedId),
// the same alpha blending / no culling / depth test / MSAA as the mesh lane (the same
// depth buffer, so a shape can sit in front of text or vice versa - see
// scene/picking.ts), and a pipeline layout that adds the atlas bind group (group 2) to
// the shared frame/object groups.
//
// Text is drawn entirely in the translucent pass, so there is only ever this one variant
// and it does not write depth. An MSDF glyph's alpha IS its coverage - the shader turns
// the sampled distance into a soft edge - so every glyph outline is a ring of partial-alpha
// fragments however solid the run's colour is, and none of them may reject what is behind
// it. See render/opacity.ts for why that rules the whole lane out of the opaque pass, and
// webgpu/SceneRenderer's draw() for the two passes.

import { textShaderCode } from '../shaders/text.wgsl'
import { TEXT_VERTEX_LAYOUT } from '../vertexLayouts'
import { DEPTH_COMPARE, DEPTH_FORMAT } from '../depthFormat'

export function createTextPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  sampleCount: number,
  layout: GPUPipelineLayout,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: textShaderCode })

  return device.createRenderPipeline({
    label: 'text',
    layout,
    vertex: {
      module,
      entryPoint: 'vs_main',
      buffers: [TEXT_VERTEX_LAYOUT],
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
