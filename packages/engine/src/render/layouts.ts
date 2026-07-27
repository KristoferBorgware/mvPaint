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
 * group(1) for the shadow caster (see render/ShadowRenderer.ts + shadowCaster.wgsl.ts):
 * one shape's shadow placement (model matrix) + flat tint color, as a uniform (not the
 * mesh lane's storage array) since the caster draws exactly one object per pass.
 */
export function createShadowObjectBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'shadow-object',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ],
  })
}

/** Shadow caster pipeline layout: shared frame (group 0) + the shadow object (group 1). */
export function createShadowCasterPipelineLayout(
  device: GPUDevice,
  frameLayout: GPUBindGroupLayout,
  shadowObjectLayout: GPUBindGroupLayout,
): GPUPipelineLayout {
  return device.createPipelineLayout({ bindGroupLayouts: [frameLayout, shadowObjectLayout] })
}

/** group(0) for a blur/dilate/composite filter pass: its radius/direction/texel-size uniform. */
export function createFilterParamsBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'filter-params',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ],
  })
}

/** group(1) for a filter pass: the source texture it samples, plus its sampler. */
export function createFilterTextureBindGroupLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: 'filter-texture',
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

/** Filter pipeline layout: the params uniform (group 0) + the source texture (group 1). */
export function createFilterPipelineLayout(
  device: GPUDevice,
  filterParamsLayout: GPUBindGroupLayout,
  filterTextureLayout: GPUBindGroupLayout,
): GPUPipelineLayout {
  return device.createPipelineLayout({ bindGroupLayouts: [filterParamsLayout, filterTextureLayout] })
}
