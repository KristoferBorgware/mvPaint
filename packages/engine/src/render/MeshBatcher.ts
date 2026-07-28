// MeshBatcher - owns the shared vertex/index buffers, the per-object storage buffer
// (transform + fill/gradient material), and the group(1) bind group. A shape normally
// occupies one object record, but may claim a contiguous block of them - one per material
// it declares (see Shape.materials()) - which is how a text node's independently styled
// runs share a single node, and a single draw call. Shapes tessellate
// into it once (rebuild); each object's transform and material are refreshed every
// frame (updateObjects) without touching geometry, so animating a position, rotation,
// or gradient parameter never requires a rebuild. One lane = one drawIndexed. Geometry
// buffers are recreated on rebuild (rebuilds are rare); per-slice incremental updates
// and capacity pooling are a later optimization.

import type { Shape } from '../shapes/Shape'
import {
  FILL_TYPE_CODE,
  MAX_GRADIENT_STOPS,
  MESH_FILL_BIT,
  MESH_VERTEX_FLOATS,
  MESH_VERTEX_STRIDE,
  OBJECT_DEPTH_OFFSET,
  OBJECT_FILL_COLOR_OFFSET,
  OBJECT_FILL_TYPE_OFFSET,
  OBJECT_GRADIENT_END_OFFSET,
  OBJECT_GRADIENT_END_RADIUS_OFFSET,
  OBJECT_GRADIENT_START_OFFSET,
  OBJECT_GRADIENT_START_RADIUS_OFFSET,
  OBJECT_STOP_COLORS_OFFSET,
  OBJECT_STOP_COUNT_OFFSET,
  OBJECT_STOP_POSITIONS_OFFSET,
  OBJECT_STRIDE,
  OBJECT_STROKE_COLOR_OFFSET,
  type GradientStop,
  type MeshMaterial,
  type MeshSink,
} from './meshFormat'

const EMPTY_STOPS: readonly GradientStop[] = []
// 5 numbers per gradient stop, flattened: offset, r, g, b, a.
const STOP_FIELDS = 5

/**
 * What was last written into one object slot - everything updateObjects() reads off a
 * material, snapshotted so a slot whose paint hasn't changed since last frame can skip
 * the whole re-pack (materials()/gradient-stop reads, FILL_TYPE_CODE lookup, the f32/u32
 * writes) instead of redoing it every frame regardless. `model` is compared by reference,
 * not value: Matrix4x4 instances are never mutated after being returned (see Node.ts), so
 * an unchanged reference already proves an unchanged transform.
 */
class ObjectCache {
  model: Float32Array | null = null
  depth = NaN
  fillType = -1
  fillR = NaN
  fillG = NaN
  fillB = NaN
  fillA = NaN
  strokeR = NaN
  strokeG = NaN
  strokeB = NaN
  strokeA = NaN
  gradStartX = NaN
  gradStartY = NaN
  gradStartRadius = NaN
  gradEndX = NaN
  gradEndY = NaN
  gradEndRadius = NaN
  stopCount = -1
  readonly stops = new Float64Array(MAX_GRADIENT_STOPS * STOP_FIELDS)

  matches(model: Float32Array, depth: number, fillType: number, material: MeshMaterial, stopCount: number, stops: readonly GradientStop[]): boolean {
    if (
      this.model !== model ||
      this.depth !== depth ||
      this.fillType !== fillType ||
      this.fillR !== material.fill[0] ||
      this.fillG !== material.fill[1] ||
      this.fillB !== material.fill[2] ||
      this.fillA !== material.fill[3] ||
      this.strokeR !== material.stroke[0] ||
      this.strokeG !== material.stroke[1] ||
      this.strokeB !== material.stroke[2] ||
      this.strokeA !== material.stroke[3] ||
      this.stopCount !== stopCount
    ) {
      return false
    }
    if (fillType === FILL_TYPE_CODE['linear-gradient']) {
      if (
        this.gradStartX !== material.fillLinearGradientStartPoint.x ||
        this.gradStartY !== material.fillLinearGradientStartPoint.y ||
        this.gradEndX !== material.fillLinearGradientEndPoint.x ||
        this.gradEndY !== material.fillLinearGradientEndPoint.y
      ) {
        return false
      }
    } else if (fillType === FILL_TYPE_CODE['radial-gradient']) {
      if (
        this.gradStartX !== material.fillRadialGradientStartPoint.x ||
        this.gradStartY !== material.fillRadialGradientStartPoint.y ||
        this.gradStartRadius !== material.fillRadialGradientStartRadius ||
        this.gradEndX !== material.fillRadialGradientEndPoint.x ||
        this.gradEndY !== material.fillRadialGradientEndPoint.y ||
        this.gradEndRadius !== material.fillRadialGradientEndRadius
      ) {
        return false
      }
    }
    for (let s = 0; s < stopCount; s++) {
      const base = s * STOP_FIELDS
      const [r, g, b, a] = stops[s].color
      if (
        this.stops[base] !== stops[s].offset ||
        this.stops[base + 1] !== r ||
        this.stops[base + 2] !== g ||
        this.stops[base + 3] !== b ||
        this.stops[base + 4] !== a
      ) {
        return false
      }
    }
    return true
  }

  remember(model: Float32Array, depth: number, fillType: number, material: MeshMaterial, stopCount: number, stops: readonly GradientStop[]): void {
    this.model = model
    this.depth = depth
    this.fillType = fillType
    this.fillR = material.fill[0]
    this.fillG = material.fill[1]
    this.fillB = material.fill[2]
    this.fillA = material.fill[3]
    this.strokeR = material.stroke[0]
    this.strokeG = material.stroke[1]
    this.strokeB = material.stroke[2]
    this.strokeA = material.stroke[3]
    this.stopCount = stopCount
    if (fillType === FILL_TYPE_CODE['linear-gradient']) {
      this.gradStartX = material.fillLinearGradientStartPoint.x
      this.gradStartY = material.fillLinearGradientStartPoint.y
      this.gradEndX = material.fillLinearGradientEndPoint.x
      this.gradEndY = material.fillLinearGradientEndPoint.y
    } else if (fillType === FILL_TYPE_CODE['radial-gradient']) {
      this.gradStartX = material.fillRadialGradientStartPoint.x
      this.gradStartY = material.fillRadialGradientStartPoint.y
      this.gradStartRadius = material.fillRadialGradientStartRadius
      this.gradEndX = material.fillRadialGradientEndPoint.x
      this.gradEndY = material.fillRadialGradientEndPoint.y
      this.gradEndRadius = material.fillRadialGradientEndRadius
    }
    for (let s = 0; s < stopCount; s++) {
      const base = s * STOP_FIELDS
      const [r, g, b, a] = stops[s].color
      this.stops[base] = stops[s].offset
      this.stops[base + 1] = r
      this.stops[base + 2] = g
      this.stops[base + 3] = b
      this.stops[base + 4] = a
    }
  }
}

export class MeshBatcher {
  private readonly device: GPUDevice
  private readonly objectLayout: GPUBindGroupLayout

  private vertexBuffer: GPUBuffer | null = null
  private indexBuffer: GPUBuffer | null = null
  private objectBuffer: GPUBuffer | null = null
  private objectBindGroup: GPUBindGroup | null = null

  private indexCount = 0
  private objectCount = 0
  /** Cumulative index count after each shape in the last rebuild, for sub-range draws. */
  private indexEnds: number[] = []
  /**
   * How many object records each shape was packed with, in the last rebuild's order. The
   * count is read from the shape at rebuild time and remembered, rather than re-read every
   * frame: if a shape's material list changes without a rebuild, the geometry still refers
   * to the old slots, so honouring a new count would slide every later shape's records out
   * from under its vertices. Sticking to what was packed keeps the two in step until the
   * rebuild that makes the change real.
   */
  private objectCounts: number[] = []

  // The CPU-side mirror of the object storage buffer, persisted across frames (allocated
  // fresh only on rebuild, when objectCount changes) so updateObjects() can leave an
  // unchanged object's bytes untouched instead of reconstructing and reuploading every
  // object every frame. objectCache holds what was last written to each slot - see
  // ObjectCache.matches().
  private objectData: ArrayBuffer | null = null
  private objectF32: Float32Array | null = null
  private objectU32: Uint32Array | null = null
  private objectCache: ObjectCache[] = []

  constructor(device: GPUDevice, objectLayout: GPUBindGroupLayout) {
    this.device = device
    this.objectLayout = objectLayout
  }

  /**
   * Re-tessellate all shapes (objectId = index) into the shared buffers and upload.
   *
   * Shapes keep the order given, and `indexRangeFor` can then hand back the slice of the
   * index buffer belonging to any prefix/suffix of that order - which is how the renderer
   * draws ordinary shapes and always-on-top overlays from ONE buffer with two draw calls
   * (see webgpu/SceneRenderer), rather than maintaining a second batcher for the overlay.
   */
  rebuild(shapes: readonly Shape[]): void {
    const positions: number[] = [] // 2 per vertex: x,y
    const packedIds: number[] = [] // 1 per vertex: object index, top bit = isFill
    const indices: number[] = []
    let vertexCount = 0

    this.indexEnds = []
    this.objectCounts = []
    // Object records are handed out in blocks: a shape claims one per material (usually
    // just one - see Shape.materials()), and its vertices pick within that block.
    let objectBase = 0
    shapes.forEach((shape) => {
      const start = vertexCount
      const materialCount = Math.max(1, shape.materials().length)
      if (shape.visible) {
        const sink: MeshSink = {
          vertex: (x, y, isFill, material = 0) => {
            const objectId = objectBase + Math.min(Math.max(0, material | 0), materialCount - 1)
            positions.push(x, y)
            packedIds.push(isFill ? objectId | MESH_FILL_BIT : objectId)
            return vertexCount++ - start
          },
          triangle: (a, b, c) => {
            indices.push(start + a, start + b, start + c)
          },
        }
        shape.tessellate(sink)
      }
      objectBase += materialCount
      this.objectCounts.push(materialCount)
      // Where each shape's indices end, so a contiguous run of shapes can be drawn alone.
      this.indexEnds.push(indices.length)
    })

    // Pack the interleaved vertex buffer (floats for position, u32 bits for packedId).
    const vtx = new ArrayBuffer(vertexCount * MESH_VERTEX_STRIDE)
    const f32 = new Float32Array(vtx)
    const u32 = new Uint32Array(vtx)
    for (let i = 0; i < vertexCount; i++) {
      const b = i * MESH_VERTEX_FLOATS
      f32[b + 0] = positions[i * 2 + 0]
      f32[b + 1] = positions[i * 2 + 1]
      u32[b + 2] = packedIds[i]
    }
    const idx = new Uint32Array(indices)

    this.indexCount = idx.length
    this.objectCount = objectBase

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

    // Object storage buffer (min one slot so the binding is never zero-sized).
    this.objectBuffer?.destroy()
    this.objectBuffer = this.device.createBuffer({
      size: Math.max(1, this.objectCount) * OBJECT_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this.objectBindGroup = this.device.createBindGroup({
      layout: this.objectLayout,
      entries: [{ binding: 0, resource: { buffer: this.objectBuffer } }],
    })

    // The CPU mirror and its per-slot cache are rebuilt from scratch here too: slot
    // numbering just changed (a different shape may now own any given slot), so nothing
    // about what was last written to a slot number is still meaningful.
    this.objectData = new ArrayBuffer(Math.max(1, this.objectCount) * OBJECT_STRIDE)
    this.objectF32 = new Float32Array(this.objectData)
    this.objectU32 = new Uint32Array(this.objectData)
    this.objectCache = Array.from({ length: this.objectCount }, () => new ObjectCache())
  }

  /**
   * Refresh every object's transform, fill/gradient material, and depth into the
   * storage buffer (cheap, per frame). A shape writes one record per material it declared
   * at rebuild time - normally exactly one, all of them sharing its transform and depth.
   * Each object's record is OBJECT_STRIDE bytes;
   * f32/u32 views share one ArrayBuffer so integer fields (fillType, stopCount) can be
   * written alongside the float fields (matrix, gradient points/radii, stops, depth) at
   * their exact byte offsets. `depths[i]` is `shapes[i]`'s zIndex-derived NDC depth (see
   * scene/picking.ts's collectZOrder/depthForRank) - a plain array aligned by position
   * rather than a Map keyed by shape, since a hash lookup per object is real, avoidable
   * cost once there are tens of thousands of them and the caller already has them in the
   * same order it's handing shapes over in.
   */
  updateObjects(shapes: readonly Shape[], depths: readonly number[]): void {
    if (!this.objectBuffer || this.objectCount === 0 || !this.objectData || !this.objectF32 || !this.objectU32) return
    const n = Math.min(this.objectCounts.length, shapes.length)
    const f32 = this.objectF32
    const u32 = this.objectU32
    let anyChanged = false

    let object = 0
    for (let i = 0; i < n; i++) {
      const shape = shapes[i]
      // The shape's whole block shares one transform and one depth; only the paint differs.
      // model is the SAME Float32Array reference across frames when the shape hasn't
      // actually moved (see Node.worldMatrix()'s cache), which is what lets the slot-level
      // cache below skip a static shape's re-pack instead of just its worldMatrix compute.
      const model = shape.worldMatrix().toGPU()
      const depth = depths[i] ?? 0.5
      const materials = shape.materials()

      for (let m = 0; m < this.objectCounts[i]; m++, object++) {
        // Clamped, not trusted: a material list that shrank since the rebuild would
        // otherwise leave holes the geometry still points at (see objectCounts).
        const material = materials[Math.min(m, materials.length - 1)] ?? shape
        const fillType = FILL_TYPE_CODE[material.fillPriority]
        const stops =
          material.fillPriority === 'linear-gradient'
            ? material.fillLinearGradientColorStops
            : material.fillPriority === 'radial-gradient'
              ? material.fillRadialGradientColorStops
              : EMPTY_STOPS
        const stopCount = Math.min(stops.length, MAX_GRADIENT_STOPS)

        const cache = this.objectCache[object]
        if (cache.matches(model, depth, fillType, material, stopCount, stops)) {
          continue // Buffer already holds these exact bytes from a previous frame.
        }
        anyChanged = true

        const floatBase = (object * OBJECT_STRIDE) / 4
        f32.set(model, floatBase)
        f32[floatBase + OBJECT_DEPTH_OFFSET / 4] = depth
        u32[floatBase + OBJECT_FILL_TYPE_OFFSET / 4] = fillType
        u32[floatBase + OBJECT_STOP_COUNT_OFFSET / 4] = stopCount

        if (material.fillPriority === 'linear-gradient') {
          f32[floatBase + OBJECT_GRADIENT_START_OFFSET / 4] = material.fillLinearGradientStartPoint.x
          f32[floatBase + OBJECT_GRADIENT_START_OFFSET / 4 + 1] = material.fillLinearGradientStartPoint.y
          f32[floatBase + OBJECT_GRADIENT_END_OFFSET / 4] = material.fillLinearGradientEndPoint.x
          f32[floatBase + OBJECT_GRADIENT_END_OFFSET / 4 + 1] = material.fillLinearGradientEndPoint.y
        } else if (material.fillPriority === 'radial-gradient') {
          f32[floatBase + OBJECT_GRADIENT_START_OFFSET / 4] = material.fillRadialGradientStartPoint.x
          f32[floatBase + OBJECT_GRADIENT_START_OFFSET / 4 + 1] = material.fillRadialGradientStartPoint.y
          f32[floatBase + OBJECT_GRADIENT_START_RADIUS_OFFSET / 4] = material.fillRadialGradientStartRadius
          f32[floatBase + OBJECT_GRADIENT_END_OFFSET / 4] = material.fillRadialGradientEndPoint.x
          f32[floatBase + OBJECT_GRADIENT_END_OFFSET / 4 + 1] = material.fillRadialGradientEndPoint.y
          f32[floatBase + OBJECT_GRADIENT_END_RADIUS_OFFSET / 4] = material.fillRadialGradientEndRadius
        }

        for (let s = 0; s < stopCount; s++) {
          f32[floatBase + OBJECT_STOP_POSITIONS_OFFSET / 4 + s] = stops[s].offset
          const [r, g, bch, a] = stops[s].color
          const colorBase = floatBase + OBJECT_STOP_COLORS_OFFSET / 4 + s * 4
          f32[colorBase + 0] = r
          f32[colorBase + 1] = g
          f32[colorBase + 2] = bch
          f32[colorBase + 3] = a
        }

        f32.set(material.fill, floatBase + OBJECT_FILL_COLOR_OFFSET / 4)
        f32.set(material.stroke, floatBase + OBJECT_STROKE_COLOR_OFFSET / 4)

        cache.remember(model, depth, fillType, material, stopCount, stops)
      }
    }

    // Skipping the upload when nothing changed matters less for its own bandwidth (it was
    // already cheap - see the investigation numbers) than for what it signals: the whole
    // per-object CPU loop above just short-circuited to cache comparisons for every slot.
    if (anyChanged) {
      this.device.queue.writeBuffer(this.objectBuffer, 0, this.objectData)
    }
  }

  /**
   * The index-buffer slice covering shapes [fromShape, toShape) of the last rebuild -
   * `{ first, count }`, with count 0 when that run emitted nothing.
   */
  indexRangeFor(fromShape: number, toShape: number): { first: number; count: number } {
    const first = fromShape <= 0 ? 0 : (this.indexEnds[fromShape - 1] ?? this.indexCount)
    const end = toShape <= 0 ? 0 : (this.indexEnds[Math.min(toShape, this.indexEnds.length) - 1] ?? this.indexCount)
    return { first, count: Math.max(0, end - first) }
  }

  /** Draws part of the batch (or all of it, when `range` is omitted). */
  draw(pass: GPURenderPassEncoder, frameBindGroup: GPUBindGroup, range?: { first: number; count: number }): void {
    if (!this.vertexBuffer || !this.indexBuffer || !this.objectBindGroup || this.indexCount === 0) {
      return
    }
    const first = range?.first ?? 0
    const count = range?.count ?? this.indexCount
    if (count <= 0) return
    pass.setBindGroup(0, frameBindGroup)
    pass.setBindGroup(1, this.objectBindGroup)
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
