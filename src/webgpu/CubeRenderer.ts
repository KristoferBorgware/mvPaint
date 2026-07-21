import { cubeShaderCode } from './cube.wgsl'
import { multiply, perspective, rotationX, rotationY, translation } from './mat4'

// 8 cube corners, each with its own RGB color -> smoothly interpolated (vertex coloring).
// Layout per vertex: x, y, z, r, g, b
// prettier-ignore
const vertexData = new Float32Array([
  // position           // color
  -1, -1, -1,           0, 0, 0,
   1, -1, -1,           1, 0, 0,
   1,  1, -1,           1, 1, 0,
  -1,  1, -1,           0, 1, 0,
  -1, -1,  1,           0, 0, 1,
   1, -1,  1,           1, 0, 1,
   1,  1,  1,           1, 1, 1,
  -1,  1,  1,           0, 1, 1,
])

// 12 triangles (36 indices), CCW winding.
// prettier-ignore
const indexData = new Uint16Array([
  // back face (z = -1)
  0, 2, 1,  0, 3, 2,
  // front face (z = +1)
  4, 5, 6,  4, 6, 7,
  // left face (x = -1)
  0, 4, 7,  0, 7, 3,
  // right face (x = +1)
  1, 2, 6,  1, 6, 5,
  // bottom face (y = -1)
  0, 1, 5,  0, 5, 4,
  // top face (y = +1)
  3, 7, 6,  3, 6, 2,
])

export interface CubeRendererHandle {
  setSpeed: (speed: number) => void
  destroy: () => void
}

/**
 * Initializes WebGPU on the given canvas and renders a spinning, vertex-colored cube.
 * Returns a handle to control spin speed and to tear everything down.
 * Throws if WebGPU is unavailable.
 */
export async function createCubeRenderer(canvas: HTMLCanvasElement): Promise<CubeRendererHandle> {
  if (!navigator.gpu) {
    throw new Error('WebGPU is not supported in this browser.')
  }

  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) {
    throw new Error('Failed to get a GPU adapter.')
  }
  const device = await adapter.requestDevice()

  const context = canvas.getContext('webgpu')
  if (!context) {
    throw new Error('Failed to get a WebGPU canvas context.')
  }

  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({
    device,
    format,
    alphaMode: 'premultiplied',
  })

  // --- Buffers ---
  const vertexBuffer = device.createBuffer({
    size: vertexData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(vertexBuffer, 0, vertexData)

  const indexBuffer = device.createBuffer({
    size: indexData.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(indexBuffer, 0, indexData)

  const uniformBuffer = device.createBuffer({
    size: 16 * 4, // one mat4x4<f32>
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  // --- Pipeline ---
  const shaderModule = device.createShaderModule({ code: cubeShaderCode })

  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: 6 * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
            { shaderLocation: 1, offset: 3 * 4, format: 'float32x3' }, // color
          ],
        },
      ],
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
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less',
    },
  })

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  })

  // --- Depth texture (recreated on resize) ---
  let depthTexture: GPUTexture | null = null

  function ensureDepthTexture(width: number, height: number) {
    if (depthTexture && depthTexture.width === width && depthTexture.height === height) {
      return
    }
    depthTexture?.destroy()
    depthTexture = device.createTexture({
      size: [width, height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
  }

  // --- Resize handling ---
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr))
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    ensureDepthTexture(canvas.width, canvas.height)
  }

  const resizeObserver = new ResizeObserver(() => resize())
  resizeObserver.observe(canvas)
  resize()

  // --- Animation state ---
  let speed = 1 // radians per second multiplier
  let angle = 0
  let lastTime = performance.now()
  let rafId = 0
  let disposed = false

  function frame(now: number) {
    if (disposed) return
    const dt = (now - lastTime) / 1000
    lastTime = now
    angle += dt * speed

    resize()

    const aspect = canvas.width / canvas.height
    const proj = perspective((60 * Math.PI) / 180, aspect, 0.1, 100)
    const view = translation(0, 0, -6)
    const model = multiply(rotationY(angle), rotationX(angle * 0.6))
    const mvp = multiply(proj, multiply(view, model))
    device.queue.writeBuffer(uniformBuffer, 0, mvp as BufferSource)

    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context!.getCurrentTexture().createView(),
          clearValue: { r: 0.07, g: 0.07, b: 0.07, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthTexture!.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    })

    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.setVertexBuffer(0, vertexBuffer)
    pass.setIndexBuffer(indexBuffer, 'uint16')
    pass.drawIndexed(indexData.length)
    pass.end()

    device.queue.submit([encoder.finish()])
    rafId = requestAnimationFrame(frame)
  }

  rafId = requestAnimationFrame(frame)

  return {
    setSpeed(next: number) {
      speed = next
    },
    destroy() {
      disposed = true
      cancelAnimationFrame(rafId)
      resizeObserver.disconnect()
      depthTexture?.destroy()
      vertexBuffer.destroy()
      indexBuffer.destroy()
      uniformBuffer.destroy()
      device.destroy()
    },
  }
}
