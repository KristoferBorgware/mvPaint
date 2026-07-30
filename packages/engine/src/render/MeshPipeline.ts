// The mesh-lane render pipeline: one shared vertex layout, alpha blending, no culling,
// a depth test (so zIndex-based stacking order resolves correctly against the text lane
// regardless of draw order - see scene/picking.ts), and MSAA. Built from an explicit
// pipeline layout so its group(0)/group(1) bind groups are shared with any future lane.
//
// Three variants come out of the same shader and layout, differing only in what they do
// with depth - see the options below, and webgpu/SceneRenderer's two-pass draw().

import { meshShaderCode } from './mesh.wgsl'
import { MESH_VERTEX_LAYOUT } from './meshFormat'
import { DEPTH_COMPARE, DEPTH_FORMAT } from './depthFormat'

export interface MeshPipelineOptions {
  /**
   * Build the always-on-top overlay variant: depth is neither tested nor written, so
   * editor furniture (selection frames, handles, rubber bands) draws over everything
   * while leaving the depth buffer untouched. Without this a translucent overlay would
   * write depth and reject whatever draws after it - notably the whole text lane behind
   * it - since alpha blending and the depth test know nothing about each other.
   */
  overlay?: boolean
  /**
   * Build the translucent-pass variant: depth is still TESTED - an opaque shape drawn in
   * the first pass must still hide whatever is behind it - but never WRITTEN. Translucent
   * fragments have no business rejecting each other: they are drawn back to front, so each
   * one has to land on what is already there rather than replace it.
   */
  translucent?: boolean
}

export function createMeshPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  sampleCount: number,
  layout: GPUPipelineLayout,
  options: MeshPipelineOptions = {},
): GPURenderPipeline {
  const module = device.createShaderModule({ code: meshShaderCode })

  return device.createRenderPipeline({
    // Named after which of the three passes it belongs to - device validation errors quote
    // the label, and all three are built from the same shader and layout.
    label: options.overlay ? 'mesh-overlay' : options.translucent ? 'mesh-translucent' : 'mesh-opaque',
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
      depthWriteEnabled: !options.overlay && !options.translucent,
      depthCompare: options.overlay ? 'always' : DEPTH_COMPARE,
    },
    multisample: {
      count: sampleCount,
    },
  })
}
