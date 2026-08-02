// The mesh lane on WebGL2: the same packing as webgpu/lanes/MeshBatcher.ts, uploaded differently.
//
// It tessellates the same shapes into the same interleaved vertex layout and writes the same
// 304-byte object records at the same byte offsets, because those are the format the geometry
// and the shader agree on and neither path owns them. Three things differ, all of them forced:
//
//   - The object records go into a TEXTURE, not a storage buffer (see ObjectTexture.ts), so
//     the dirty ranges the per-slot cache produces are rounded out to whole texel rows before
//     upload rather than written as byte ranges.
//   - Integer fields are written as floats, for the denormal reason in ObjectTexture.ts.
//   - A vertex array object stands in for the pipeline's vertex layout. WebGL binds attribute
//     state globally; a VAO is the only way to say "this buffer, this layout" once.
//
// ObjectCache comes from the WebGPU batcher rather than being copied. It is pure CPU - it
// compares a material against what was last written and names no GPU type - and it is the
// comparison the whole per-frame cost model rests on. One of it, shared, is right; two of it
// would be two to keep correct.

import type { Shape } from '../../shapes/Shape'
import { objectRecordEpoch } from '../../shapes/contentEpoch'
import { sameMembers } from '../../render/gather'
import { ObjectCache } from '../../webgpu/lanes/MeshBatcher'
import {
  FILL_TYPE_CODE,
  MAX_GRADIENT_STOPS,
  MESH_FILL_BIT,
  MESH_VERTEX_FLOATS,
  MESH_VERTEX_STRIDE,
  OBJECT_DEPTH_OFFSET,
  OBJECT_OPACITY_OFFSET,
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
  type MeshSink,
} from '../../render/meshFormat'
import { ObjectTexture } from '../ObjectTexture'
import type { GlProgram } from '../programs'

const EMPTY_STOPS: readonly GradientStop[] = []
/** Slots this close together upload as one row range rather than two - see MeshBatcher's. */
const DIRTY_RANGE_MERGE_GAP = 8
/** Past this many scattered ranges, one whole-texture upload beats the call overhead. */
const MAX_DIRTY_RANGES = 512

export class GlMeshBatcher {
  private readonly gl: WebGL2RenderingContext
  private readonly objects: ObjectTexture

  private vao: WebGLVertexArrayObject | null = null
  private vertexBuffer: WebGLBuffer | null = null
  private indexBuffer: WebGLBuffer | null = null

  private indexCount = 0
  private objectCount = 0
  /** Records claimed per shape - a shape takes one per material it declares. */
  private objectCounts: number[] = []
  /** Where each shape's indices end, so a contiguous run of shapes can be drawn alone. */
  private indexEnds: number[] = []
  private objectCache: ObjectCache[] = []
  // What the last updateObjects() ran against - see the guard at the top of it.
  private recordEpoch = -1
  private lastShapes: readonly Shape[] = []

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.objects = new ObjectTexture(gl, OBJECT_STRIDE, 'mesh-objects')
  }

  /** Re-tessellate every shape into the shared buffers and upload. Rare, and expensive. */
  rebuild(shapes: readonly Shape[]): void {
    const gl = this.gl
    const positions: number[] = []
    const packedIds: number[] = []
    const indices: number[] = []
    let vertexCount = 0

    this.indexEnds = []
    this.objectCounts = []
    let objectBase = 0
    for (const shape of shapes) {
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
      this.indexEnds.push(indices.length)
    }

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

    this.releaseGeometry()
    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)

    this.vertexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, vtx, gl.STATIC_DRAW)
    // position: two floats at byte 0.
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, MESH_VERTEX_STRIDE, 0)
    // packedId: a genuine unsigned integer at byte 8, carrying an object index in its low 31
    // bits and the isFill flag in its top one. It has to travel through vertexAttribIPointer,
    // not the float path - the top bit set is a value no float round-trips.
    gl.enableVertexAttribArray(1)
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, MESH_VERTEX_STRIDE, 8)

    this.indexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW)

    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)

    // Slot numbering just changed, so nothing previously written to a slot number still means
    // anything - the cache is rebuilt from scratch alongside the texture.
    this.objects.allocate(this.objectCount)
    this.objectCache = Array.from({ length: this.objectCount }, () => new ObjectCache())
    // The slot caches just went blank, so the next refresh must actually run however quiet the
    // scene has been - a geometry-only change (a Circle's radius) rebuilds with the very same
    // shapes in the very same order, which is exactly the case the fast path above would
    // otherwise skip, leaving every record unwritten.
    this.recordEpoch = -1
    this.lastShapes = []
  }

  /**
   * Refresh every object's transform, material and depth. Cheap, and per frame: a slot whose
   * paint and matrix are unchanged since last frame is skipped entirely, and only the texel
   * rows holding slots that did change are uploaded.
   */
  updateObjects(shapes: readonly Shape[], depths: readonly number[]): void {
    // Nothing that lands in a record has changed anywhere in the scene, and the visible set is
    // the same objects in the same order - so every slot would be compared, matched and
    // skipped, and the whole pass is provably a no-op. Skipping it is the difference between
    // 40 ms and nothing at all on a static scene of a hundred thousand objects, which is what
    // the announcing setters in contentEpoch.ts exist to make knowable. Depths need no
    // separate check: they are a function of rank and count, so the same objects in the same
    // order are the same depths.
    if (this.recordEpoch === objectRecordEpoch() && sameMembers(shapes, this.lastShapes)) return
    this.recordEpoch = objectRecordEpoch()
    this.lastShapes = shapes

    if (this.objectCount === 0) return
    const f32 = this.objects.data
    const n = Math.min(this.objectCounts.length, shapes.length)
    let anyChanged = false
    const dirtyRanges: { start: number; end: number }[] = []

    let object = 0
    for (let i = 0; i < n; i++) {
      const shape = shapes[i]
      // The same Float32Array reference across frames when the shape has not actually moved
      // (see Node.worldMatrix()'s cache), which is what lets the slot cache skip a static
      // shape's whole re-pack rather than just its matrix compute.
      const model = shape.worldMatrix().toGPU()
      const depth = depths[i] ?? 0.5
      // One opacity for the whole shape, written into every record it produces.
      const opacity = shape.opacity
      const materials = shape.materials()

      for (let m = 0; m < this.objectCounts[i]; m++, object++) {
        // Clamped, not trusted: a material list that shrank since the rebuild would otherwise
        // leave holes the geometry still points at.
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
        if (cache.matches(model, depth, opacity, fillType, material, stopCount, stops)) continue

        anyChanged = true
        const lastRange = dirtyRanges[dirtyRanges.length - 1]
        if (lastRange && object - lastRange.end <= DIRTY_RANGE_MERGE_GAP) lastRange.end = object + 1
        else dirtyRanges.push({ start: object, end: object + 1 })

        const base = (object * OBJECT_STRIDE) / 4
        f32.set(model, base)
        f32[base + OBJECT_DEPTH_OFFSET / 4] = depth
        f32[base + OBJECT_OPACITY_OFFSET / 4] = opacity
        // Floats, not reinterpreted integer bits - see ObjectTexture.ts's header.
        f32[base + OBJECT_FILL_TYPE_OFFSET / 4] = fillType
        f32[base + OBJECT_STOP_COUNT_OFFSET / 4] = stopCount

        if (material.fillPriority === 'linear-gradient') {
          f32[base + OBJECT_GRADIENT_START_OFFSET / 4] = material.fillLinearGradientStartPoint.x
          f32[base + OBJECT_GRADIENT_START_OFFSET / 4 + 1] = material.fillLinearGradientStartPoint.y
          f32[base + OBJECT_GRADIENT_END_OFFSET / 4] = material.fillLinearGradientEndPoint.x
          f32[base + OBJECT_GRADIENT_END_OFFSET / 4 + 1] = material.fillLinearGradientEndPoint.y
        } else if (material.fillPriority === 'radial-gradient') {
          f32[base + OBJECT_GRADIENT_START_OFFSET / 4] = material.fillRadialGradientStartPoint.x
          f32[base + OBJECT_GRADIENT_START_OFFSET / 4 + 1] = material.fillRadialGradientStartPoint.y
          f32[base + OBJECT_GRADIENT_START_RADIUS_OFFSET / 4] = material.fillRadialGradientStartRadius
          f32[base + OBJECT_GRADIENT_END_OFFSET / 4] = material.fillRadialGradientEndPoint.x
          f32[base + OBJECT_GRADIENT_END_OFFSET / 4 + 1] = material.fillRadialGradientEndPoint.y
          f32[base + OBJECT_GRADIENT_END_RADIUS_OFFSET / 4] = material.fillRadialGradientEndRadius
        }

        for (let s = 0; s < stopCount; s++) {
          f32[base + OBJECT_STOP_POSITIONS_OFFSET / 4 + s] = stops[s].offset
          const [r, g, bch, a] = stops[s].color
          const colorBase = base + OBJECT_STOP_COLORS_OFFSET / 4 + s * 4
          f32[colorBase + 0] = r
          f32[colorBase + 1] = g
          f32[colorBase + 2] = bch
          f32[colorBase + 3] = a
        }

        f32.set(material.fill, base + OBJECT_FILL_COLOR_OFFSET / 4)
        f32.set(material.stroke, base + OBJECT_STROKE_COLOR_OFFSET / 4)

        cache.remember(model, depth, opacity, fillType, material, stopCount, stops)
      }
    }

    if (!anyChanged) return
    if (dirtyRanges.length <= MAX_DIRTY_RANGES) {
      for (const range of dirtyRanges) this.objects.uploadRecords(range.start, range.end)
    } else {
      // Scattered too widely to be worth one call each - one contiguous copy is cheaper, and
      // never worse than uploading everything unconditionally would have been.
      this.objects.uploadAll()
    }
  }

  /** The index-buffer slice covering shapes `[fromShape, toShape)` of the last rebuild. */
  indexRangeFor(fromShape: number, toShape: number): { first: number; count: number } {
    const first = fromShape <= 0 ? 0 : (this.indexEnds[fromShape - 1] ?? this.indexCount)
    const end = toShape <= 0 ? 0 : (this.indexEnds[Math.min(toShape, this.indexEnds.length) - 1] ?? this.indexCount)
    return { first, count: Math.max(0, end - first) }
  }

  /**
   * Draw part of the batch. The program is already bound and carries its own state; what is
   * left is the per-lane bindings and one call.
   */
  draw(program: GlProgram, range: { first: number; count: number }): void {
    if (!this.vao || this.indexCount === 0 || range.count <= 0) return
    const gl = this.gl

    this.objects.bind(0)
    gl.uniform1i(program.uniform('u_objects'), 0)
    gl.uniform1i(program.uniform('u_objectsWidth'), this.objects.width)

    gl.bindVertexArray(this.vao)
    // Byte offset into the index buffer - uint32 indices, so four bytes per index.
    gl.drawElements(gl.TRIANGLES, range.count, gl.UNSIGNED_INT, range.first * 4)
    gl.bindVertexArray(null)
  }

  destroy(): void {
    this.releaseGeometry()
    this.objects.destroy()
  }

  private releaseGeometry(): void {
    const gl = this.gl
    if (this.vao) gl.deleteVertexArray(this.vao)
    if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer)
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer)
    this.vao = null
    this.vertexBuffer = null
    this.indexBuffer = null
  }
}
