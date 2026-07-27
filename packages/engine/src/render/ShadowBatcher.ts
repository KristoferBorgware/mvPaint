// ShadowBatcher - packs every visible shadow into one vertex/index buffer of textured
// quads plus one per-object storage buffer, so N shadows cost ONE draw call with one atlas
// bound, regardless of N.
//
// Geometry here is trivial (four vertices per shadow, in the shape's local space) and is
// rebuilt only when the set of shadow-casting shapes or their atlas slots change. The
// per-object records - world matrix, tint, depth - refresh every frame like the mesh lane's
// do, so moving, recolouring or fading a shadow never touches geometry or the atlas.

import type { Shape } from '../shapes/Shape'
import type { ShadowAtlas } from './ShadowAtlas'
import { shadowWorldOffset, worldAxisScale } from './shadowMath'
import {
  SHADOW_OBJECT_COLOR_OFFSET,
  SHADOW_OBJECT_DEPTH_OFFSET,
  SHADOW_OBJECT_STRIDE,
  SHADOW_VERTEX_FLOATS,
  SHADOW_VERTEX_STRIDE,
} from './shadowFormat'

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
   * Packs a quad per shadow-casting shape that has a baked atlas slot. Shapes without a
   * slot (nothing to cast from, or the atlas was full) are skipped entirely rather than
   * drawn with garbage uvs.
   */
  rebuild(shapes: readonly Shape[], atlas: ShadowAtlas): void {
    const vertices: number[] = [] // x, y, u, v per vertex
    const objectIds: number[] = []
    const indices: number[] = []
    this.casters = []

    for (const shape of shapes) {
      if (!shape.visible || !shape.hasShadow()) continue
      const slot = atlas.slotFor(shape)
      if (!slot) continue

      const objectId = this.casters.length
      this.casters.push(shape)

      const base = objectIds.length
      const push = (x: number, y: number, u: number, v: number): void => {
        vertices.push(x, y, u, v)
        objectIds.push(objectId)
      }
      // The atlas's first texel row holds the quad's TOP edge (see ShadowAtlas.bakeOne),
      // so v runs with decreasing local y.
      push(slot.x0, slot.y1, slot.u0, slot.v0)
      push(slot.x1, slot.y1, slot.u1, slot.v0)
      push(slot.x1, slot.y0, slot.u1, slot.v1)
      push(slot.x0, slot.y0, slot.u0, slot.v1)
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }

    const vertexCount = objectIds.length
    const vtx = new ArrayBuffer(vertexCount * SHADOW_VERTEX_STRIDE)
    const f32 = new Float32Array(vtx)
    const u32 = new Uint32Array(vtx)
    for (let i = 0; i < vertexCount; i++) {
      const b = i * SHADOW_VERTEX_FLOATS
      f32[b + 0] = vertices[i * 4 + 0]
      f32[b + 1] = vertices[i * 4 + 1]
      f32[b + 2] = vertices[i * 4 + 2]
      f32[b + 3] = vertices[i * 4 + 3]
      u32[b + 4] = objectIds[i]
    }
    const idx = new Uint32Array(indices)
    this.indexCount = idx.length

    this.vertexBuffer?.destroy()
    this.vertexBuffer = null
    if (vtx.byteLength > 0) {
      this.vertexBuffer = this.device.createBuffer({
        size: vtx.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(this.vertexBuffer, 0, vtx)
    }

    this.indexBuffer?.destroy()
    this.indexBuffer = null
    if (idx.byteLength > 0) {
      this.indexBuffer = this.device.createBuffer({
        size: idx.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(this.indexBuffer, 0, idx)
    }

    this.objectBuffer?.destroy()
    this.objectBuffer = this.device.createBuffer({
      size: Math.max(1, this.casters.length) * SHADOW_OBJECT_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this.objectBindGroup = this.device.createBindGroup({
      layout: this.objectLayout,
      entries: [{ binding: 0, resource: { buffer: this.objectBuffer } }],
    })
  }

  /**
   * Refreshes each shadow's transform, tint and depth (cheap, per frame). `depths` maps a
   * shape to its own NDC depth; the shadow is placed just BEHIND that by `depthNudge`, so
   * it sits under its caster while still resolving correctly against everything else.
   */
  updateObjects(depths: ReadonlyMap<Shape, number>, depthNudge: number): void {
    if (!this.objectBuffer || this.casters.length === 0) return
    const buf = new ArrayBuffer(this.casters.length * SHADOW_OBJECT_STRIDE)
    const f32 = new Float32Array(buf)

    this.casters.forEach((shape, i) => {
      const base = (i * SHADOW_OBJECT_STRIDE) / 4
      const world = shape.worldMatrix().toGPU()

      // Canvas/Konva shadow offset: scaled by the shape's absolute scale, but applied
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

      f32[base + SHADOW_OBJECT_DEPTH_OFFSET / 4] = (depths.get(shape) ?? 0.5) + depthNudge
    })

    this.device.queue.writeBuffer(this.objectBuffer, 0, buf)
  }

  /** One indexed draw covering every shadow, with the atlas bound as group(2). */
  draw(pass: GPURenderPassEncoder, frameBindGroup: GPUBindGroup, atlas: ShadowAtlas): void {
    const atlasBindGroup = atlas.bindGroup
    if (!this.vertexBuffer || !this.indexBuffer || !this.objectBindGroup || !atlasBindGroup || this.indexCount === 0) {
      return
    }
    pass.setBindGroup(0, frameBindGroup)
    pass.setBindGroup(1, this.objectBindGroup)
    pass.setBindGroup(2, atlasBindGroup)
    pass.setVertexBuffer(0, this.vertexBuffer)
    pass.setIndexBuffer(this.indexBuffer, 'uint32')
    pass.drawIndexed(this.indexCount)
  }

  destroy(): void {
    this.vertexBuffer?.destroy()
    this.indexBuffer?.destroy()
    this.objectBuffer?.destroy()
  }
}
