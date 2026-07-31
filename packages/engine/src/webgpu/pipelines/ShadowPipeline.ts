// The shadow lane's render pipeline. Straight-alpha blending like the other lanes, but
// depth is TESTED and not WRITTEN - which is exactly what lets shadows stack against other
// shapes.
//
// Testing means a shadow is hidden wherever something nearer has already been drawn (its
// own caster included, so a shadow never shows through the shape casting it). Not writing
// means a shadow never occludes anything drawn later, and two overlapping shadows blend
// instead of one punching a hole in the other. Combined with drawing the lane AFTER the
// mesh and text lanes, that gives the right answer without sorting: a shadow lands on top
// of every shape it is in front of, and behind every shape it is behind.

import { DEPTH_COMPARE, DEPTH_FORMAT } from '../depthFormat'
import { SHADOW_VERTEX_LAYOUT } from '../vertexLayouts'
import { shadowQuadShaderCode } from '../shaders/shadowQuad.wgsl'

export function createShadowPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  sampleCount: number,
  layout: GPUPipelineLayout,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: shadowQuadShaderCode })

  return device.createRenderPipeline({
    label: 'shadow',
    layout,
    vertex: { module, entryPoint: 'vs_main', buffers: [SHADOW_VERTEX_LAYOUT] },
    fragment: {
      module,
      entryPoint: 'fs_main',
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: false,
      depthCompare: DEPTH_COMPARE,
    },
    multisample: { count: sampleCount },
  })
}
