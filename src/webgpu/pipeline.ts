// Reusable render pipeline + per-object bind group creation for cube rendering.

import { cubeShaderCode } from './cube.wgsl'
import { CUBE_VERTEX_LAYOUT } from './CubeGeometry'

/** Depth buffer format shared by the pipeline and the scene's depth texture. */
export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus'

/** Size in bytes of the per-cube uniform block (one mat4x4<f32> MVP matrix). */
export const UNIFORM_SIZE = 16 * 4

/**
 * Builds the render pipeline used to draw the vertex-colored cube geometry.
 * The pipeline is independent of how many cubes are drawn — each cube supplies
 * its own bind group (see {@link createCubeBindGroup}).
 */
export function createCubePipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
  const shaderModule = device.createShaderModule({ code: cubeShaderCode })

  return device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vs_main',
      buffers: [CUBE_VERTEX_LAYOUT],
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fs_main',
      targets: [{ format }],
    },
    primitive: {
      topology: 'triangle-list',
      cullMode: 'back',
      frontFace: 'ccw',
    },
    depthStencil: {
      format: DEPTH_FORMAT,
      depthWriteEnabled: true,
      depthCompare: 'less',
    },
  })
}

/** Creates a bind group wiring a single uniform buffer to group(0) of the pipeline. */
export function createCubeBindGroup(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  uniformBuffer: GPUBuffer,
): GPUBindGroup {
  return device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  })
}
