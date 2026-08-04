// System component: WebGPU device + canvas context setup. Owns all context-related
// operations (adapter/device request, canvas configuration, preferred format). Not
// specific to any scene - the renderer and systems build on top of this.

import { describeAdapter, type GpuPowerPreference, type RendererAdapter } from '../systems/adapter'

export interface GpuContext {
  device: GPUDevice
  context: GPUCanvasContext
  format: GPUTextureFormat
  canvas: HTMLCanvasElement
  /** Which GPU the browser gave us, and what was asked for - see systems/adapter.ts. */
  adapter: RendererAdapter
}

export interface GpuContextOptions {
  /** Which GPU to ask for. Default 'high-performance' - see systems/adapter.ts. */
  powerPreference?: GpuPowerPreference
}

/**
 * Requests a GPU adapter/device and configures the given canvas for rendering.
 * Throws with a human-readable message if WebGPU is unavailable at any step.
 */
export async function createGpuContext(
  canvas: HTMLCanvasElement,
  options: GpuContextOptions = {},
): Promise<GpuContext> {
  if (!navigator.gpu) {
    throw new Error('WebGPU is not supported in this browser.')
  }

  // The one lever there is for choosing a GPU, and the reason the default is not the
  // platform's - see systems/adapter.ts.
  const powerPreference = options.powerPreference ?? 'high-performance'
  const gpuAdapter = await navigator.gpu.requestAdapter({ powerPreference })
  if (!gpuAdapter) {
    throw new Error('Failed to get a GPU adapter.')
  }
  const device = await gpuAdapter.requestDevice()
  const adapter = readAdapter(gpuAdapter, powerPreference)
  if (adapter.fallback) {
    // Not an error: this draws the right picture, just slowly. Said once because it is
    // otherwise indistinguishable from the renderer being slow.
    console.warn(`WebGPU is running on a software adapter (${describeAdapter(adapter)}).`)
  }

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

  return { device, context, format, canvas, adapter }
}

/**
 * What the browser will say about the adapter it picked.
 *
 * `adapter.info` is a recent addition and every field on it is optional in practice - an
 * implementation that does not have it, or that redacts a field, gives an empty string rather
 * than an error. Read defensively for exactly that reason: nothing here is worth throwing over.
 */
function readAdapter(gpuAdapter: GPUAdapter, powerPreference: GpuPowerPreference): RendererAdapter {
  const info = (gpuAdapter.info ?? {}) as Partial<GPUAdapterInfo>
  return {
    powerPreference,
    vendor: info.vendor ?? '',
    architecture: info.architecture ?? '',
    device: info.device ?? '',
    description: info.description ?? '',
    fallback: info.isFallbackAdapter ?? false,
  }
}
