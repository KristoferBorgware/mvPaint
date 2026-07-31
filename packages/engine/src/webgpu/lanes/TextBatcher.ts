// TextBatcher - the text lane's counterpart to MeshBatcher. It shapes every Text node into
// glyph + decoration quads, packs them into shared vertex/index buffers, and records one
// material per run (transform + fill/gradient + per-letter stroke) in a per-object storage
// buffer. Materials (static) are separated from the per-frame transform refresh, so moving or
// animating a Text updates only the object buffer, never the geometry.
//
// Quads are emitted in painter order and drawn as ONE range, whatever styles they mix. Every
// Inter style shares a single texture_2d_array with a layer each, and a run's layer travels in
// its object record (see webgpu/FontBook.ts), so there is no per-atlas segmentation left to do:
// this lane binds group(2) exactly once and issues exactly one drawIndexed per span of nodes.

import type { Shape } from '../../shapes/Shape'
import type { Text } from '../../shapes/Text'
import type { FontBook } from '../FontBook'
import type { TextMaterial } from '../../text/layout'
import { quadCorner } from '../../text/textQuad'
import { FILL_TYPE_CODE, MAX_GRADIENT_STOPS } from '../../render/meshFormat'
import {
  TEXT_GLYPH_BIT,
  TEXT_OBJECT_ATLAS_LAYER_OFFSET,
  TEXT_OBJECT_DEPTH_OFFSET,
  TEXT_OBJECT_DILATE_OFFSET,
  TEXT_OBJECT_DISTANCE_RANGE_OFFSET,
  TEXT_OBJECT_FILL_TYPE_OFFSET,
  TEXT_OBJECT_GRADIENT_END_OFFSET,
  TEXT_OBJECT_GRADIENT_END_RADIUS_OFFSET,
  TEXT_OBJECT_GRADIENT_START_OFFSET,
  TEXT_OBJECT_GRADIENT_START_RADIUS_OFFSET,
  TEXT_OBJECT_HAS_STROKE_OFFSET,
  TEXT_OBJECT_STOP_COLORS_OFFSET,
  TEXT_OBJECT_STOP_COUNT_OFFSET,
  TEXT_OBJECT_STOP_POSITIONS_OFFSET,
  TEXT_OBJECT_STRIDE,
  TEXT_OBJECT_STROKE_COLOR_OFFSET,
  TEXT_OBJECT_STROKE_WIDTH_OFFSET,
  TEXT_VERTEX_FLOATS,
  TEXT_VERTEX_STRIDE,
} from '../../render/textFormat'

interface ObjectRecord {
  node: Text
  material: TextMaterial
}

export class TextBatcher {
  private readonly device: GPUDevice
  private readonly objectLayout: GPUBindGroupLayout

  private vertexBuffer: GPUBuffer | null = null
  private indexBuffer: GPUBuffer | null = null
  private objectBuffer: GPUBuffer | null = null
  private objectBindGroup: GPUBindGroup | null = null

  private indexCount = 0
  private objectRecords: ObjectRecord[] = []
  // Cumulative index count after each Text handed to rebuild(), aligned with that argument
  // by position (an invisible node contributes nothing but still takes a slot). This is what
  // lets any run of nodes be drawn on its own, which is how the renderer interleaves the
  // lanes back to front - see SceneRenderer's draw().
  private nodeIndexEnds: number[] = []

  constructor(device: GPUDevice, objectLayout: GPUBindGroupLayout) {
    this.device = device
    this.objectLayout = objectLayout
  }

  /** Shape all Text nodes into the shared buffers, one material (object) per run. */
  rebuild(texts: readonly Text[], fontBook: FontBook): void {
    const posUvColor: number[] = [] // 8 per vertex: x,y,u,v,r,g,b,a
    const packedIds: number[] = [] // 1 per vertex: object index, top bit = isGlyph
    const indices: number[] = []
    let vertexCount = 0
    let objectBase = 0
    this.objectRecords = []
    this.nodeIndexEnds = []

    for (const text of texts) {
      if (!text.visible) {
        this.nodeIndexEnds.push(indices.length)
        continue
      }
      const shaped = text.shaped(fontBook)
      for (const material of shaped.materials) {
        this.objectRecords.push({ node: text, material })
      }

      for (const q of shaped.quads) {
        const packed = (objectBase + q.material) | (q.isGlyph ? TEXT_GLYPH_BIT : 0)
        const b = vertexCount
        const push = (x: number, y: number, u: number, v: number): void => {
          // The corner's real position: the faux-italic shear, then the rotation that makes
          // text follow a curve. Both are identity for ordinary straight, upright text.
          const p = quadCorner(q, x, y)
          posUvColor.push(p.x, p.y, u, v, q.color[0], q.color[1], q.color[2], q.color[3])
          packedIds.push(packed)
          vertexCount++
        }
        // TL, TR, BR, BL (y-up: y1 is the top edge, y0 the bottom).
        push(q.x0, q.y1, q.u0, q.v0)
        push(q.x1, q.y1, q.u1, q.v0)
        push(q.x1, q.y0, q.u1, q.v1)
        push(q.x0, q.y0, q.u0, q.v1)

        indices.push(b, b + 1, b + 2, b, b + 2, b + 3)
      }
      objectBase += shaped.materials.length
      this.nodeIndexEnds.push(indices.length)
    }

    // Pack the interleaved vertex buffer (floats for pos/uv/color, u32 bits for packedId).
    const vtx = new ArrayBuffer(vertexCount * TEXT_VERTEX_STRIDE)
    const f32 = new Float32Array(vtx)
    const u32 = new Uint32Array(vtx)
    for (let i = 0; i < vertexCount; i++) {
      const b = i * TEXT_VERTEX_FLOATS
      for (let k = 0; k < 8; k++) f32[b + k] = posUvColor[i * 8 + k]
      u32[b + 8] = packedIds[i]
    }
    const idx = new Uint32Array(indices)

    this.indexCount = idx.length

    this.vertexBuffer?.destroy()
    this.vertexBuffer = null
    if (vtx.byteLength > 0) {
      this.vertexBuffer = this.device.createBuffer({
        label: 'text-vertices',
        size: vtx.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(this.vertexBuffer, 0, vtx)
    }

    this.indexBuffer?.destroy()
    this.indexBuffer = null
    if (idx.byteLength > 0) {
      this.indexBuffer = this.device.createBuffer({
        label: 'text-indices',
        size: idx.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(this.indexBuffer, 0, idx)
    }

    this.objectBuffer?.destroy()
    this.objectBuffer = this.device.createBuffer({
      label: 'text-objects',
      size: Math.max(1, this.objectRecords.length) * TEXT_OBJECT_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this.objectBindGroup = this.device.createBindGroup({
      layout: this.objectLayout,
      entries: [{ binding: 0, resource: { buffer: this.objectBuffer } }],
    })
  }

  /**
   * Refresh every material's transform, fill/gradient/stroke, and depth into the storage
   * buffer. `depths` maps each Text node to its zIndex-derived NDC depth (see
   * scene/picking.ts's collectZOrder/depthForRank) - every material (run) of a node
   * shares that one depth, same as the mesh lane.
   */
  updateObjects(depths: ReadonlyMap<Shape, number>): void {
    if (!this.objectBuffer || this.objectRecords.length === 0) return
    const buf = new ArrayBuffer(this.objectRecords.length * TEXT_OBJECT_STRIDE)
    const f32 = new Float32Array(buf)
    const u32 = new Uint32Array(buf)

    this.objectRecords.forEach(({ node, material }, i) => {
      const base = (i * TEXT_OBJECT_STRIDE) / 4

      f32.set(node.worldMatrix().toGPU(), base)
      f32[base + TEXT_OBJECT_DEPTH_OFFSET / 4] = depths.get(node) ?? 0.5
      u32[base + TEXT_OBJECT_FILL_TYPE_OFFSET / 4] = FILL_TYPE_CODE[material.fillPriority]

      const stopCount = Math.min(material.stops.length, MAX_GRADIENT_STOPS)
      u32[base + TEXT_OBJECT_STOP_COUNT_OFFSET / 4] = stopCount

      f32[base + TEXT_OBJECT_GRADIENT_START_OFFSET / 4] = material.gradientStart.x
      f32[base + TEXT_OBJECT_GRADIENT_START_OFFSET / 4 + 1] = material.gradientStart.y
      f32[base + TEXT_OBJECT_GRADIENT_END_OFFSET / 4] = material.gradientEnd.x
      f32[base + TEXT_OBJECT_GRADIENT_END_OFFSET / 4 + 1] = material.gradientEnd.y
      f32[base + TEXT_OBJECT_GRADIENT_START_RADIUS_OFFSET / 4] = material.gradientStartRadius
      f32[base + TEXT_OBJECT_GRADIENT_END_RADIUS_OFFSET / 4] = material.gradientEndRadius

      for (let s = 0; s < stopCount; s++) {
        f32[base + TEXT_OBJECT_STOP_POSITIONS_OFFSET / 4 + s] = material.stops[s].offset
        const [r, g, bch, a] = material.stops[s].color
        const c = base + TEXT_OBJECT_STOP_COLORS_OFFSET / 4 + s * 4
        f32[c + 0] = r
        f32[c + 1] = g
        f32[c + 2] = bch
        f32[c + 3] = a
      }

      const sc = material.strokeColor
      const sBase = base + TEXT_OBJECT_STROKE_COLOR_OFFSET / 4
      f32[sBase + 0] = sc[0]
      f32[sBase + 1] = sc[1]
      f32[sBase + 2] = sc[2]
      f32[sBase + 3] = sc[3]
      f32[base + TEXT_OBJECT_STROKE_WIDTH_OFFSET / 4] = material.strokeWidth
      u32[base + TEXT_OBJECT_HAS_STROKE_OFFSET / 4] = material.strokeWidth > 0 ? 1 : 0
      f32[base + TEXT_OBJECT_DISTANCE_RANGE_OFFSET / 4] = material.distanceRange
      f32[base + TEXT_OBJECT_DILATE_OFFSET / 4] = material.dilate
      u32[base + TEXT_OBJECT_ATLAS_LAYER_OFFSET / 4] = material.atlasIndex
    })

    this.device.queue.writeBuffer(this.objectBuffer, 0, buf)
  }

  /** Draw the whole lane: one bind of the shared atlas array, one indexed draw. */
  draw(pass: GPURenderPassEncoder, frameBindGroup: GPUBindGroup, fontBook: FontBook): void {
    this.drawRange(pass, frameBindGroup, fontBook, 0, this.nodeIndexEnds.length)
  }

  /**
   * Draw only the nodes [fromNode, toNode) of the last rebuild, in that order - which is how
   * the renderer interleaves the lanes back to front. One draw, whatever styles the span
   * mixes: every style is a layer of the one bound texture (see webgpu/FontBook.ts).
   */
  drawRange(
    pass: GPURenderPassEncoder,
    frameBindGroup: GPUBindGroup,
    fontBook: FontBook,
    fromNode: number,
    toNode: number,
  ): void {
    if (!this.vertexBuffer || !this.indexBuffer || !this.objectBindGroup || this.indexCount === 0) {
      return
    }
    const start = fromNode <= 0 ? 0 : (this.nodeIndexEnds[fromNode - 1] ?? this.indexCount)
    const end = toNode <= 0 ? 0 : (this.nodeIndexEnds[Math.min(toNode, this.nodeIndexEnds.length) - 1] ?? this.indexCount)
    if (end <= start) return

    pass.setBindGroup(0, frameBindGroup)
    pass.setBindGroup(1, this.objectBindGroup)
    pass.setBindGroup(2, fontBook.bindGroup)
    pass.setVertexBuffer(0, this.vertexBuffer)
    pass.setIndexBuffer(this.indexBuffer, 'uint32')
    pass.drawIndexed(end - start, 1, start)
  }

  destroy(): void {
    this.vertexBuffer?.destroy()
    this.indexBuffer?.destroy()
    this.objectBuffer?.destroy()
  }
}
