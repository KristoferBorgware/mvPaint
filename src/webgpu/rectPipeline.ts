// Reusable render pipeline + per-shape bind group for 2D rects. No depth attachment
// (2D uses painter's order - draw order = z-order, like Konva), alpha blending on, and
// no back-face culling (quads can face either way after transforms).

import { quadShaderCode } from './quad.wgsl'
import { QUAD_VERTEX_LAYOUT } from './QuadGeometry'

/** Per-rect uniform block: mat4x4<f32> mvp (64) + vec4<f32> color (16). */
export const RECT_UNIFORM_SIZE = 16 * 4 + 4 * 4
/** Byte offset of the color within the uniform block (after the mat4). */
export const RECT_COLOR_OFFSET = 16 * 4

export function createRectPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
  const shaderModule = device.createShaderModule({ code: quadShaderCode })

  return device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vs_main',
      buffers: [QUAD_VERTEX_LAYOUT],
    },
    fragment: {
      module: shaderModule,
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
  })
}

export function createRectBindGroup(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  uniformBuffer: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  })
}
