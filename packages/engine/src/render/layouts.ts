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

/**
 * group(2): the MSDF font atlas - a sampled texture + its sampler - read by the text lane's
 * fragment shader only. The mesh lane never binds group(2); it belongs solely to text.
 */
export function createAtlasBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'atlas',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      },
    ],
  })
}

/** Text-lane pipeline layout: shared frame + per-object material (groups 0/1) plus the atlas. */
export function createTextPipelineLayout(
  device: GPUDevice,
  frameLayout: GPUBindGroupLayout,
  objectLayout: GPUBindGroupLayout,
  atlasLayout: GPUBindGroupLayout,
): GPUPipelineLayout {
  return device.createPipelineLayout({ bindGroupLayouts: [frameLayout, objectLayout, atlasLayout] })
}


/**
 * group(0) for a shadow-atlas bake pass: one small uniform (the local->clip projection for
 * the silhouette pass, or the kernel parameters for a blur pass). Both are a single
 * fragment/vertex-visible uniform buffer, so they share one layout.
 */
export function createShadowBakeProjectLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'shadow-bake-params',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ],
  })
}

/** group(1) for a shadow blur pass: the source texture it samples, plus its sampler. */
export function createFilterTextureBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'shadow-bake-source',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  })
}

/** Shadow-lane pipeline layout: shared frame + shadow objects (groups 0/1) plus the shadow atlas. */
export function createShadowPipelineLayout(
  device: GPUDevice,
  frameLayout: GPUBindGroupLayout,
  objectLayout: GPUBindGroupLayout,
  atlasLayout: GPUBindGroupLayout,
): GPUPipelineLayout {
  return device.createPipelineLayout({ bindGroupLayouts: [frameLayout, objectLayout, atlasLayout] })
}
