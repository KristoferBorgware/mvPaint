// System component: WebGPU device + canvas context setup. Owns all context-related
// operations (adapter/device request, canvas configuration, preferred format). Not
// specific to any scene - the renderer and systems build on top of this.

export interface GpuContext {
  device: GPUDevice
  context: GPUCanvasContext
  format: GPUTextureFormat
  canvas: HTMLCanvasElement
}

/**
 * Requests a GPU adapter/device and configures the given canvas for rendering.
 * Throws with a human-readable message if WebGPU is unavailable at any step.
 */
export async function createGpuContext(canvas: HTMLCanvasElement): Promise<GpuContext> {
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

  return { device, context, format, canvas }
}
