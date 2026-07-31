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
 * group(2): a sampled texture + its sampler, read by a fragment shader only. The mesh lane
 * never binds group(2); the text, image and shadow lanes each do, and share this one shape of
 * layout because a font atlas, a picture and a blurred silhouette are all just a float texture.
 *
 * `viewDimension` is where they part company. The text lane binds a '2d-array': all four Inter
 * styles live in one texture, one layer each, selected per glyph from the object record - which
 * is what lets a mixed-style paragraph draw in a single call instead of one per style (see
 * webgpu/FontBook.ts). The image and shadow lanes bind a plain '2d'.
 */
export function createAtlasBindGroupLayout(
  device: GPUDevice,
  viewDimension: GPUTextureViewDimension = '2d',
): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    label: viewDimension === '2d' ? 'atlas' : `atlas:${viewDimension}`,
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float', viewDimension },
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
