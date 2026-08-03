// ShadowAtlas - one shared texture holding every shape's pre-blurred shadow silhouette,
// so a scene with hundreds of shadows still draws them in a single call (see
// ShadowBatcher) and pays no per-frame GPU cost for any shadow that hasn't changed.
//
// Each shape gets a slot sized from things a transform CANNOT affect: its local-space
// silhouette bounds and its shadowBlur (see shadowMath.ts). Position, rotation, scale,
// skew, parenting, the shadow's own offset and the camera zoom are all applied afterwards
// to the quad that samples the slot - so dragging, spinning or zooming a shadowed shape
// never re-bakes anything. A slot is re-baked only when the shape's geometryVersion
// changes (markGeometryDirty), or its shadowBlur / shadowSpread / shadowForStrokeEnabled
// changes. A re-bake keeps the rectangle it already holds when the new one still fits, so a
// slider being dragged does not burn through the atlas a frame at a time.
//
// Nothing outside caches a slot: ShadowBatcher reads slotFor() every frame precisely because
// a re-bake can move a shape to a different rectangle without the set of shadow-casting
// shapes changing at all.
//
// Baking a slot is a handful of small passes: rasterize the silhouette as coverage into a
// scratch texture, optionally grow/shrink it (shadowSpread, two separable morphology
// passes), blur it horizontally into a second scratch, then blur it vertically straight
// into the slot's rectangle of the atlas. Every pass is bounded by the slot's size (at most
// MAX_REGION on a side), never the canvas - which is the whole difference from rendering
// each shadow through a full-screen pass.
//
// Coverage is single-channel (r8unorm): a shadow is a stencil, and its colour lives in the
// per-object record, so one byte per texel is all the atlas ever needs to store.

import type { Vector2Like } from '../math/Vector2'
import type { Shape } from '../shapes/Shape'
import type { MeshSink } from '../render/meshFormat'
import { createFilterTextureBindGroupLayout, createShadowBakeProjectLayout } from './layouts'
import { shadowBlurShaderCode, shadowMorphologyShaderCode, shadowSilhouetteShaderCode } from './shaders/shadowBake.wgsl'
import { shadowRegion, shadowSigma, shadowQuadBounds, slotBucket, type ShadowRegion } from '../render/shadowMath'

const ATLAS_FORMAT: GPUTextureFormat = 'r8unorm'
/** Cap on a single shadow's slot; bigger shapes bake at reduced resolution (see shadowRegion). */
export const MAX_REGION = 256
const INITIAL_ATLAS_SIZE = 1024
const PROJECT_UNIFORM_SIZE = 16 // vec2 scale + vec2 offset
const BLUR_UNIFORM_SIZE = 32 // vec2 step + vec2 sourceScale + f32 sigma + f32 radius (padded)
const MORPH_UNIFORM_SIZE = 32 // vec2 step + vec2 sourceScale + f32 radius + padding
/** Slots are padded apart so a neighbour's texels can never bleed in under linear filtering. */
const SLOT_GUTTER = 1

/** A shape's baked slot: where it lives in the atlas, and the local-space quad it maps to. */
export interface ShadowSlot {
  /** Atlas uv rect. */
  u0: number
  v0: number
  u1: number
  v1: number
  /** Local-space quad the slot covers (silhouette bounds grown by the blur margin). */
  x0: number
  y0: number
  x1: number
  y1: number
}

/** One shape's bake, decided during planning and recorded afterwards. */
interface PlannedBake {
  shape: Shape
  silhouette: NonNullable<ReturnType<typeof silhouetteOf>>
  region: ShadowRegion
  rect: Vector2Like
  alloc: { width: number; height: number }
}

interface Entry extends ShadowSlot {
  rectX: number
  rectY: number
  width: number
  height: number
  // The rectangle actually RESERVED, which can be larger than the region currently baked
  // into it - see the reuse rule in tryBake.
  allocWidth: number
  allocHeight: number
  // What the bake was keyed on - any change re-bakes.
  geometryVersion: number
  blur: number
  spread: number
  forStroke: boolean
}

/** Local-space silhouette triangles for a shape, honouring shadowForStrokeEnabled. */
/**
 * A shape's shadow-casting geometry in its own local space, or null if it has none.
 *
 * Exported because it is pure CPU - it tessellates through a MeshSink and names no GPU type -
 * and the WebGL fallback's atlas has to bake exactly the same silhouette. Shared rather than
 * copied: which triangles a shadow is made of (notably whether the stroke counts) is a
 * behaviour decision, and two of it would be two to keep in agreement.
 */
export function silhouetteOf(shape: Shape): { positions: number[]; indices: number[]; minX: number; minY: number; maxX: number; maxY: number } | null {
  const positions: number[] = []
  const isFill: boolean[] = []
  const indices: number[] = []
  const sink: MeshSink = {
    vertex: (x, y, fill) => {
      positions.push(x, y)
      isFill.push(fill)
      return positions.length / 2 - 1
    },
    triangle: (a, b, c) => {
      // Dropping stroke triangles here rather than at draw time is what makes
      // shadowForStrokeEnabled a property of the BAKED silhouette - the shadow is cast
      // from the fill outline alone, not merely tinted differently.
      if (!shape.shadowForStrokeEnabled && !(isFill[a] && isFill[b] && isFill[c])) return
      indices.push(a, b, c)
    },
  }
  shape.tessellate(sink)
  if (indices.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  // Only vertices actually referenced by a surviving triangle count toward the bounds -
  // otherwise skipping the stroke would still reserve room for it.
  for (const i of indices) {
    const x = positions[i * 2]
    const y = positions[i * 2 + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) return null
  return { positions, indices, minX, minY, maxX, maxY }
}

export class ShadowAtlas {
  private readonly device: GPUDevice
  private readonly sampler: GPUSampler
  private readonly maxAtlasSize: number

  private readonly projectLayout: GPUBindGroupLayout
  private readonly blurParamsLayout: GPUBindGroupLayout
  private readonly textureLayout: GPUBindGroupLayout
  private readonly silhouettePipeline: GPURenderPipeline
  private readonly blurPipeline: GPURenderPipeline
  private readonly morphologyPipeline: GPURenderPipeline

  private texture: GPUTexture | null = null
  private view: GPUTextureView | null = null
  private atlasSize = 0
  /** group(2) for the draw lane - rebuilt whenever the atlas texture is (re)created. */
  private bindGroupCache: GPUBindGroup | null = null

  private scratchA: GPUTexture | null = null
  private scratchB: GPUTexture | null = null

  private readonly entries = new Map<Shape, Entry>()
  // Shelf packer cursor: slots are laid out left-to-right in rows of uniform height.
  private shelfY = 0
  private shelfHeight = 0
  private cursorX = 0

  private scratchBuffers: GPUBuffer[] = []
  /** True once this frame's bakes are being recorded - see ensureTextures. */
  private recording = false

  constructor(device: GPUDevice) {
    this.device = device
    this.maxAtlasSize = Math.min(8192, device.limits.maxTextureDimension2D)
    this.sampler = device.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })

    this.projectLayout = createShadowBakeProjectLayout(device)
    this.blurParamsLayout = createShadowBakeProjectLayout(device)
    this.textureLayout = createFilterTextureBindGroupLayout(device)

    const silhouetteModule = device.createShaderModule({ code: shadowSilhouetteShaderCode })
    this.silhouettePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.projectLayout] }),
      vertex: {
        module: silhouetteModule,
        entryPoint: 'vs_main',
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
      },
      fragment: { module: silhouetteModule, entryPoint: 'fs_main', targets: [{ format: ATLAS_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    })

    const filterLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.blurParamsLayout, this.textureLayout],
    })
    const blurModule = device.createShaderModule({ code: shadowBlurShaderCode })
    this.blurPipeline = device.createRenderPipeline({
      layout: filterLayout,
      vertex: { module: blurModule, entryPoint: 'vs_fullscreen' },
      fragment: { module: blurModule, entryPoint: 'fs_blur', targets: [{ format: ATLAS_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    })
    const morphModule = device.createShaderModule({ code: shadowMorphologyShaderCode })
    this.morphologyPipeline = device.createRenderPipeline({
      layout: filterLayout,
      vertex: { module: morphModule, entryPoint: 'vs_fullscreen' },
      fragment: { module: morphModule, entryPoint: 'fs_morphology', targets: [{ format: ATLAS_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    })
  }

  /** group(2) for the shadow draw lane, or null before anything has been baked. */
  get bindGroup(): GPUBindGroup | null {
    return this.bindGroupCache
  }

  /** The baked slot for a shape, or null if it has no shadow / nothing to cast one from. */
  slotFor(shape: Shape): ShadowSlot | null {
    return this.entries.get(shape) ?? null
  }

  private ensureTextures(size: number): void {
    if (this.texture && this.atlasSize === size) return
    // Growing replaces the atlas, which DESTROYS the old texture. Any pass already recorded
    // into this frame's encoder still points at it, and the whole submit then fails with
    // "Destroyed texture used in a submit" - a device-level error that a lenient software
    // backend may never report, so it can survive testing and only break on real hardware.
    // Planning is ordered ahead of recording precisely to make that impossible; this asserts
    // the ordering rather than trusting it to survive future edits.
    if (this.texture && this.recording) {
      throw new Error('ShadowAtlas: the atlas cannot be resized once bakes have been recorded this frame')
    }
    this.texture?.destroy()
    this.atlasSize = size
    this.texture = this.device.createTexture({
      label: 'shadow-atlas',
      size: [size, size],
      format: ATLAS_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.view = this.texture.createView()
    this.bindGroupCache = this.device.createBindGroup({
      layout: this.textureLayout,
      entries: [
        { binding: 0, resource: this.view },
        { binding: 1, resource: this.sampler },
      ],
    })

    if (!this.scratchA) {
      const scratch = (label: string): GPUTexture =>
        this.device.createTexture({
          label,
          size: [MAX_REGION, MAX_REGION],
          format: ATLAS_FORMAT,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        })
      this.scratchA = scratch('shadow-scratch-a')
      this.scratchB = scratch('shadow-scratch-b')
    }
  }

  private resetPacker(): void {
    this.shelfY = 0
    this.shelfHeight = 0
    this.cursorX = 0
  }

  /** Reserves a slot rectangle, or null when the atlas is full at its current size. */
  private packSlot(width: number, height: number): Vector2Like | null {
    const w = width + SLOT_GUTTER
    const h = height + SLOT_GUTTER
    if (this.cursorX + w > this.atlasSize) {
      this.shelfY += this.shelfHeight
      this.shelfHeight = 0
      this.cursorX = 0
    }
    if (this.shelfY + h > this.atlasSize) return null
    const x = this.cursorX
    const y = this.shelfY
    this.cursorX += w
    this.shelfHeight = Math.max(this.shelfHeight, h)
    return { x, y }
  }

  private uniformBuffer(byteLength: number, fill: (f32: Float32Array) => void): GPUBuffer {
    const data = new ArrayBuffer(byteLength)
    fill(new Float32Array(data))
    const buffer = this.device.createBuffer({
      size: byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(buffer, 0, data)
    this.scratchBuffers.push(buffer)
    return buffer
  }

  /**
   * Re-bakes any shape whose cached silhouette is stale and drops entries for shapes that
   * no longer cast a shadow. Call once per frame from the pre-pass, before the main render
   * pass opens - baking needs render passes of its own, onto the atlas rather than the
   * canvas. Shapes that are already up to date cost nothing here.
   */
  update(encoder: GPUCommandEncoder, shapes: readonly Shape[]): void {
    for (const buffer of this.scratchBuffers) buffer.destroy()
    this.scratchBuffers = []

    const casters = shapes.filter((s) => s.visible && s.hasShadow())
    const live = new Set(casters)
    for (const shape of [...this.entries.keys()]) {
      if (!live.has(shape)) this.entries.delete(shape)
    }

    const stale = casters.filter((shape) => {
      const entry = this.entries.get(shape)
      return (
        !entry ||
        entry.geometryVersion !== shape.geometryVersion ||
        entry.blur !== shape.shadowBlur ||
        entry.spread !== shape.shadowSpread ||
        entry.forStroke !== shape.shadowForStrokeEnabled
      )
    })
    if (stale.length === 0) return

    this.ensureTextures(this.atlasSize || INITIAL_ATLAS_SIZE)

    // Decide the entire layout BEFORE recording a single pass. Planning is what may grow the
    // atlas, and growing replaces (and destroys) the texture - so anything already recorded
    // into this frame's encoder would then reference a destroyed texture and fail the whole
    // submit. Keeping every texture decision ahead of every draw makes that impossible by
    // construction rather than by careful ordering.
    const plan = this.planBakes(stale, casters)
    this.recording = true
    try {
      for (const item of plan) {
        this.bakeOne(encoder, item.shape, item.silhouette, item.region, item.rect, item.alloc)
      }
    } finally {
      this.recording = false
    }
  }

  /**
   * Works out where every stale shape's silhouette will go, growing and repacking the atlas
   * as needed. Pure bookkeeping plus texture (re)creation - it records no GPU commands.
   */
  private planBakes(stale: readonly Shape[], casters: readonly Shape[]): PlannedBake[] {
    // A stale entry's old rectangle isn't reclaimed individually (the shelf packer only ever
    // moves forward), so once the atlas fills up everything is repacked from scratch and
    // re-baked. Growing first keeps that from happening every frame on a busy scene.
    for (let attempt = 0; attempt < 8; attempt++) {
      const plan = this.tryPlan(attempt === 0 ? stale : casters, false)
      if (plan) return plan

      if (this.atlasSize >= this.maxAtlasSize) {
        // Out of room even at the largest supported atlas - plan what fits and leave the
        // rest without a slot, so they render no shadow rather than a corrupted one.
        this.entries.clear()
        this.resetPacker()
        return this.tryPlan(casters, true) ?? []
      }
      this.ensureTextures(Math.min(this.maxAtlasSize, this.atlasSize * 2))
      // Repack everything: the entries that were fine still hold rectangles in the old
      // layout, which the new atlas no longer matches - and its texture is gone besides.
      this.entries.clear()
      this.resetPacker()
    }
    return []
  }

  /**
   * Reserves a rectangle for each shape. Null when the atlas ran out of room, unless
   * `partial` is set, in which case it returns however much fitted.
   */
  private tryPlan(shapes: readonly Shape[], partial: boolean): PlannedBake[] | null {
    const plan: PlannedBake[] = []
    for (const shape of shapes) {
      const silhouette = silhouetteOf(shape)
      if (!silhouette) {
        this.entries.delete(shape)
        continue
      }
      const region = shadowRegion(
        silhouette.maxX - silhouette.minX,
        silhouette.maxY - silhouette.minY,
        shape.shadowBlur,
        shape.shadowSpread,
        MAX_REGION,
      )

      // Re-bake into the rectangle this shape already holds whenever the new region still
      // fits it. The shelf packer only ever moves forward, so without this every re-bake
      // would abandon its old rectangle - and a blur or spread slider re-bakes on EVERY
      // frame it is dragged, which would burn through the atlas and force a full repack
      // several times a second. Leftover texels outside the new region are simply never
      // sampled, since the uv rect is sized from the region rather than the allocation.
      //
      // Reservations are rounded up to a coarse grid (slotBucket) rather than fitted exactly
      // to the region. Region sizes wobble by a texel or two near the cap, so an exact fit
      // would make reuse turn on rounding noise - a slightly smaller blur could miss its own
      // rectangle by one texel and reallocate. On the grid, an allocation only ever grows,
      // so a slider swept back and forth settles instead of churning.
      const existing = this.entries.get(shape)
      const reusable = existing && existing.allocWidth >= region.width && existing.allocHeight >= region.height
      const alloc = reusable
        ? { width: existing.allocWidth, height: existing.allocHeight }
        : { width: slotBucket(region.width, MAX_REGION), height: slotBucket(region.height, MAX_REGION) }
      const rect = reusable ? { x: existing.rectX, y: existing.rectY } : this.packSlot(alloc.width, alloc.height)
      if (!rect) return partial ? plan : null

      plan.push({ shape, silhouette, region, rect, alloc })
    }
    return plan
  }

  private bakeOne(
    encoder: GPUCommandEncoder,
    shape: Shape,
    silhouette: { positions: number[]; indices: number[]; minX: number; minY: number },
    region: ShadowRegion,
    rect: Vector2Like,
    alloc: { width: number; height: number },
  ): void {
    const quad = shadowQuadBounds(silhouette.minX, silhouette.minY, region)
    const quadW = quad.x1 - quad.x0
    const quadH = quad.y1 - quad.y0

    // --- 1. silhouette -> scratchA -------------------------------------------------
    const positions = new Float32Array(silhouette.positions)
    const vertexBuffer = this.device.createBuffer({
      size: Math.max(positions.byteLength, 8),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(vertexBuffer, 0, positions)
    this.scratchBuffers.push(vertexBuffer)

    const indexData = new Uint32Array(silhouette.indices)
    const indexBuffer = this.device.createBuffer({
      size: Math.max(indexData.byteLength, 4),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(indexBuffer, 0, indexData)
    this.scratchBuffers.push(indexBuffer)

    // Local space -> the region's clip space. Clip y is up and so is the scene, so the
    // region's first texel row ends up holding the shape's TOP edge.
    const projectBuffer = this.uniformBuffer(PROJECT_UNIFORM_SIZE, (f32) => {
      f32[0] = 2 / quadW
      f32[1] = 2 / quadH
      f32[2] = -1 - (2 * quad.x0) / quadW
      f32[3] = -1 - (2 * quad.y0) / quadH
    })
    const projectBindGroup = this.device.createBindGroup({
      layout: this.projectLayout,
      entries: [{ binding: 0, resource: { buffer: projectBuffer } }],
    })

    const silhouettePass = encoder.beginRenderPass({
      colorAttachments: [
        { view: this.scratchA!.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
    })
    silhouettePass.setViewport(0, 0, region.width, region.height, 0, 1)
    silhouettePass.setPipeline(this.silhouettePipeline)
    silhouettePass.setBindGroup(0, projectBindGroup)
    silhouettePass.setVertexBuffer(0, vertexBuffer)
    silhouettePass.setIndexBuffer(indexBuffer, 'uint32')
    silhouettePass.drawIndexed(indexData.length)
    silhouettePass.end()

    // --- 2. spread, then blur: scratchA -> ... -> the atlas slot ---------------------
    const sigmaTexels = shadowSigma(shape.shadowBlur) * region.texelsPerUnit
    const blurRadius = Math.min(region.padTexels, Math.ceil(3 * sigmaTexels))
    const spreadRadius = Math.round(shape.shadowSpread * region.texelsPerUnit)
    const sourceScale: [number, number] = [region.width / MAX_REGION, region.height / MAX_REGION]

    // Every filter step is the same shape of pass - fullscreen triangle, viewport clipped to
    // the region, one uniform plus one source texture - so they share a runner and differ
    // only in pipeline and parameters.
    const filterPass = (
      pipeline: GPURenderPipeline,
      params: GPUBuffer,
      source: GPUTextureView,
      target: GPUTextureView,
      viewport: Vector2Like,
      load: GPULoadOp,
    ): void => {
      const paramsBindGroup = this.device.createBindGroup({
        layout: this.blurParamsLayout,
        entries: [{ binding: 0, resource: { buffer: params } }],
      })
      const textureBindGroup = this.device.createBindGroup({
        layout: this.textureLayout,
        entries: [
          { binding: 0, resource: source },
          { binding: 1, resource: this.sampler },
        ],
      })
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          load === 'clear'
            ? { view: target, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }
            : { view: target, loadOp: 'load', storeOp: 'store' },
        ],
      })
      pass.setViewport(viewport.x, viewport.y, region.width, region.height, 0, 1)
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, paramsBindGroup)
      pass.setBindGroup(1, textureBindGroup)
      pass.draw(3)
      pass.end()
    }

    const texel = 1 / MAX_REGION
    const ORIGIN = { x: 0, y: 0 }
    const viewA = this.scratchA!.createView()
    const viewB = this.scratchB!.createView()

    // Ping-pong between the two scratch textures; `source` tracks which one currently holds
    // the working image, so the number of steps can vary with the shadow's parameters.
    let source = viewA
    let target = viewB

    if (spreadRadius !== 0) {
      const morphParams = (step: [number, number]): GPUBuffer =>
        this.uniformBuffer(MORPH_UNIFORM_SIZE, (f32) => {
          f32[0] = step[0]
          f32[1] = step[1]
          f32[2] = sourceScale[0]
          f32[3] = sourceScale[1]
          f32[4] = spreadRadius
        })
      filterPass(this.morphologyPipeline, morphParams([texel, 0]), source, target, ORIGIN, 'clear')
      ;[source, target] = [target, source]
      filterPass(this.morphologyPipeline, morphParams([0, texel]), source, target, ORIGIN, 'clear')
      ;[source, target] = [target, source]
    }

    const blurParams = (step: [number, number]): GPUBuffer =>
      this.uniformBuffer(BLUR_UNIFORM_SIZE, (f32) => {
        f32[0] = step[0]
        f32[1] = step[1]
        f32[2] = sourceScale[0]
        f32[3] = sourceScale[1]
        f32[4] = Math.max(sigmaTexels, 1e-4)
        f32[5] = blurRadius
      })
    filterPass(this.blurPipeline, blurParams([texel, 0]), source, target, ORIGIN, 'clear')
    ;[source, target] = [target, source]
    // The vertical pass writes straight into the slot, so the atlas is loaded (not cleared)
    // to leave every other shape's baked texture intact.
    filterPass(this.blurPipeline, blurParams([0, texel]), source, this.view!, { x: rect.x, y: rect.y }, 'load')

    const size = this.atlasSize
    this.entries.set(shape, {
      rectX: rect.x,
      rectY: rect.y,
      width: region.width,
      height: region.height,
      allocWidth: alloc.width,
      allocHeight: alloc.height,
      geometryVersion: shape.geometryVersion,
      blur: shape.shadowBlur,
      spread: shape.shadowSpread,
      forStroke: shape.shadowForStrokeEnabled,
      u0: rect.x / size,
      v0: rect.y / size,
      u1: (rect.x + region.width) / size,
      v1: (rect.y + region.height) / size,
      x0: quad.x0,
      y0: quad.y0,
      x1: quad.x1,
      y1: quad.y1,
    })
  }

  destroy(): void {
    for (const buffer of this.scratchBuffers) buffer.destroy()
    this.scratchBuffers = []
    this.texture?.destroy()
    this.scratchA?.destroy()
    this.scratchB?.destroy()
  }
}
