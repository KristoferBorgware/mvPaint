// Explicit, shared bind-group layouts for the renderer's frequency model. Sharing the
// layouts (rather than `layout: 'auto'`) lets group(0)/group(1) be set once and reused
// across every pipeline/lane we add later.

/** group(0): per-frame globals (camera view-projection + resolution). */
export function createFrameBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'frame',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ],
  })
}

/**
 * group(1): per-batch object data (transform + fill/gradient material). Read by BOTH
 * shader stages - the vertex shader uses each object's model matrix, and the fragment
 * shader reads its fillType and gradient parameters to evaluate gradient fills - so the
 * binding must be visible to both.
 */
export function createObjectBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'objects',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'read-only-storage' },
      },
    ],
  })
}

export function createMeshPipelineLayout(
  device: GPUDevice,
  frameLayout: GPUBindGroupLayout,
  objectLayout: GPUBindGroupLayout,
): GPUPipelineLayout {
  return device.createPipelineLayout({ bindGroupLayouts: [frameLayout, objectLayout] })
}
