// ShadowBatcher - packs every visible shadow into one vertex/index buffer of quads plus one
// per-object storage buffer, so N shadows cost ONE draw call with one atlas bound,
// regardless of N.
//
// The geometry is deliberately contentless: four unit-square corners per shadow, carrying
// nothing but an object id. Everything that describes a particular shadow - world matrix,
// tint, depth, and its ATLAS SLOT (the local-space bounds and uv rect) - lives in the
// per-object record, rewritten every frame.
//
// Keeping the slot out of the vertex buffer is the point. A slot is re-baked into a
// different rectangle whenever a shape's blur, spread or geometry changes, and the set of
// casting shapes does not change when that happens - so geometry holding a uv rect would
// have no reliable moment to notice it had gone stale, and would keep sampling a rectangle
// the atlas had since handed to a different shape. Reading the slot per frame removes the
// possibility rather than adding a second thing to remember to invalidate.

import type { Shape } from '../shapes/Shape'
import type { ShadowAtlas } from './ShadowAtlas'
import { shadowWorldOffset, worldAxisScale } from './shadowMath'
import {
  SHADOW_OBJECT_COLOR_OFFSET,
  SHADOW_OBJECT_DEPTH_OFFSET,
  SHADOW_OBJECT_QUAD_OFFSET,
  SHADOW_OBJECT_STRIDE,
  SHADOW_OBJECT_UV_OFFSET,
  SHADOW_VERTEX_FLOATS,
  SHADOW_VERTEX_STRIDE,
} from './shadowFormat'

/** The four corners of a unit square, in the winding the index buffer below expects. */
const CORNERS: readonly [number, number][] = [
  [0, 1],
  [1, 1],
  [1, 0],
  [0, 0],
]

export class ShadowBatcher {
  private readonly device: GPUDevice
  private readonly objectLayout: GPUBindGroupLayout

  private vertexBuffer: GPUBuffer | null = null
  private indexBuffer: GPUBuffer | null = null
  private objectBuffer: GPUBuffer | null = null
  private objectBindGroup: GPUBindGroup | null = null

  private indexCount = 0
  private casters: Shape[] = []

  constructor(device: GPUDevice, objectLayout: GPUBindGroupLayout) {
    this.device = device
    this.objectLayout = objectLayout
  }

  /** The shapes currently packed - the renderer compares this to detect a stale build. */
  get packed(): readonly Shape[] {
    return this.casters
  }

  /**
   * Packs one unit quad per shadow-casting shape. Deliberately does NOT consult the atlas:
   * a shape whose slot is missing (nothing to cast from, or the atlas was full) still gets
   * a quad, which updateObjects collapses to zero size for that frame - so a slot appearing
   * or moving later needs no rebuild at all.
   */
  rebuild(shapes: readonly Shape[]): void {
    const corners: number[] = []
    const objectIds: number[] = []
    const indices: number[] = []
    this.casters = []

    for (const shape of shapes) {
      if (!shape.visible || !shape.hasShadow()) continue
      const objectId = this.casters.length
      this.casters.push(shape)

      const base = objectIds.length
      for (const [cx, cy] of CORNERS) {
        corners.push(cx, cy)
        objectIds.push(objectId)
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }

    const vertexCount = objectIds.length
    const vtx = new ArrayBuffer(vertexCount * SHADOW_VERTEX_STRIDE)
    const f32 = new Float32Array(vtx)
    const u32 = new Uint32Array(vtx)
    for (let i = 0; i < vertexCount; i++) {
      const b = i * SHADOW_VERTEX_FLOATS
      f32[b + 0] = corners[i * 2 + 0]
      f32[b + 1] = corners[i * 2 + 1]
      u32[b + 2] = objectIds[i]
    }
    const idx = new Uint32Array(indices)
    this.indexCount = idx.length

    this.vertexBuffer?.destroy()
    this.vertexBuffer = null
    if (vtx.byteLength > 0) {
      this.vertexBuffer = this.device.createBuffer({
        label: 'shadow-vertices',
        size: vtx.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(this.vertexBuffer, 0, vtx)
    }

    this.indexBuffer?.destroy()
    this.indexBuffer = null
    if (idx.byteLength > 0) {
      this.indexBuffer = this.device.createBuffer({
        label: 'shadow-indices',
        size: idx.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(this.indexBuffer, 0, idx)
    }

    this.objectBuffer?.destroy()
    this.objectBuffer = this.device.createBuffer({
      label: 'shadow-objects',
      size: Math.max(1, this.casters.length) * SHADOW_OBJECT_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this.objectBindGroup = this.device.createBindGroup({
      layout: this.objectLayout,
      entries: [{ binding: 0, resource: { buffer: this.objectBuffer } }],
    })
  }

  /**
   * Refreshes each shadow's transform, tint, atlas slot and depth (cheap, per frame).
   * `depths` maps a shape to its own NDC depth; the shadow is placed just BEHIND that by
   * `depthNudge`, so it sits under its caster while still resolving correctly against
   * everything else. Re-reading the slot here is what keeps a re-baked shadow correct
   * without any geometry rebuild.
   */
  updateObjects(atlas: ShadowAtlas, depths: ReadonlyMap<Shape, number>, depthNudge: number): void {
    if (!this.objectBuffer || this.casters.length === 0) return
    const buf = new ArrayBuffer(this.casters.length * SHADOW_OBJECT_STRIDE)
    const f32 = new Float32Array(buf)

    this.casters.forEach((shape, i) => {
      const base = (i * SHADOW_OBJECT_STRIDE) / 4
      const world = shape.worldMatrix().toGPU()

      // Canvas shadow offset: scaled by the shape's absolute scale, but applied
      // along WORLD axes rather than the shape's own - so a rotated shape's shadow still
      // falls in the direction the (notional) light comes from. Prepending it to the world
      // matrix's translation column is the same as multiplying by a world translation.
      const scale = worldAxisScale(world)
      const offset = shadowWorldOffset(shape.shadowOffsetX, shape.shadowOffsetY, scale.x, scale.y)
      f32.set(world, base)
      f32[base + 12] = world[12] + offset.x
      f32[base + 13] = world[13] + offset.y

      const c = shape.shadowColor
      const colorBase = base + SHADOW_OBJECT_COLOR_OFFSET / 4
      f32[colorBase + 0] = c[0]
      f32[colorBase + 1] = c[1]
      f32[colorBase + 2] = c[2]
      f32[colorBase + 3] = c[3] * shape.shadowOpacity

      // The slot, read fresh: a shape still waiting on its first bake (or one the atlas had
      // no room for) gets a zero-size quad, which rasterizes nothing, rather than sampling
      // whatever happens to sit at uv 0.
      const slot = atlas.slotFor(shape)
      const quadBase = base + SHADOW_OBJECT_QUAD_OFFSET / 4
      const uvBase = base + SHADOW_OBJECT_UV_OFFSET / 4
      if (slot) {
        f32[quadBase + 0] = slot.x0
        f32[quadBase + 1] = slot.y0
        f32[quadBase + 2] = slot.x1
        f32[quadBase + 3] = slot.y1
        f32[uvBase + 0] = slot.u0
        f32[uvBase + 1] = slot.v0
        f32[uvBase + 2] = slot.u1
        f32[uvBase + 3] = slot.v1
      }

      f32[base + SHADOW_OBJECT_DEPTH_OFFSET / 4] = (depths.get(shape) ?? 0.5) + depthNudge
    })

    this.device.queue.writeBuffer(this.objectBuffer, 0, buf)
  }

  /** One indexed draw covering every shadow, with the atlas bound as group(2). */
  draw(pass: GPURenderPassEncoder, frameBindGroup: GPUBindGroup, atlas: ShadowAtlas): void {
    this.drawRange(pass, frameBindGroup, atlas, 0, this.casters.length)
  }

  /**
   * Draw only the shadows of casters [from, to) of the last rebuild. Every caster packs
   * exactly one quad - six indices, in caster order - so the span is arithmetic rather
   * than a lookup, and one bind group covers the whole atlas either way.
   */
  drawRange(
    pass: GPURenderPassEncoder,
    frameBindGroup: GPUBindGroup,
    atlas: ShadowAtlas,
    from: number,
    to: number,
  ): void {
    const atlasBindGroup = atlas.bindGroup
    if (!this.vertexBuffer || !this.indexBuffer || !this.objectBindGroup || !atlasBindGroup || this.indexCount === 0) {
      return
    }
    const first = Math.max(0, from) * 6
    const count = Math.min(to, this.casters.length) * 6 - first
    if (count <= 0) return

    pass.setBindGroup(0, frameBindGroup)
    pass.setBindGroup(1, this.objectBindGroup)
    pass.setBindGroup(2, atlasBindGroup)
    pass.setVertexBuffer(0, this.vertexBuffer)
    pass.setIndexBuffer(this.indexBuffer, 'uint32')
    pass.drawIndexed(count, 1, first)
  }

  destroy(): void {
    this.vertexBuffer?.destroy()
    this.indexBuffer?.destroy()
    this.objectBuffer?.destroy()
  }
}
