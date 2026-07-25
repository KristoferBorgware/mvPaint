// The mesh-lane render pipeline: one shared vertex layout, alpha blending, no culling,
// a depth test (so zIndex-based stacking order resolves correctly against the text lane
// regardless of draw order - see scene/picking.ts), and MSAA. Built from an explicit
// pipeline layout so its group(0)/group(1) bind groups are shared with any future lane.

import { meshShaderCode } from './mesh.wgsl'
import { MESH_VERTEX_LAYOUT } from './meshFormat'
import { DEPTH_COMPARE, DEPTH_FORMAT } from './depthFormat'

export function createMeshPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  sampleCount: number,
  layout: GPUPipelineLayout,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: meshShaderCode })

  return device.createRenderPipeline({
    layout,
    vertex: {
      module,
      entryPoint: 'vs_main',
      buffers: [MESH_VERTEX_LAYOUT],
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
      depthWriteEnabled: true,
      depthCompare: DEPTH_COMPARE,
    },
    multisample: {
      count: sampleCount,
    },
  })
}
