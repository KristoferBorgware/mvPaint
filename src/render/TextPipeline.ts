// The text-lane render pipeline: the text vertex layout (position + uv + color + packedId),
// the same alpha blending / no culling / no depth / MSAA as the mesh lane, and a pipeline
// layout that adds the atlas bind group (group 2) to the shared frame/object groups.

import { textShaderCode } from './text.wgsl'
import { TEXT_VERTEX_LAYOUT } from './textFormat'

export function createTextPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  sampleCount: number,
  layout: GPUPipelineLayout,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: textShaderCode })

  return device.createRenderPipeline({
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
    multisample: {
      count: sampleCount,
    },
  })
}
