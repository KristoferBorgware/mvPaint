// The text lane on WebGL2: every MSDFText node's glyph and decoration quads in one buffer pair,
// one object record per run, drawn as a range of nodes.
//
// The same shaping, the same quads and the same 320-byte record as webgpu/lanes/TextBatcher.ts -
// the shaper (text/layout.ts) is shared outright, so what arrives here is already identical.
// What differs is the same three things as the mesh lane: records go into a texture, integer
// fields are written as floats, and a VAO carries the vertex layout.
//
// Unlike the mesh lane there is no per-slot cache. MSDFText records are per RUN - hundreds, where
// mesh records run to tens of thousands - and every one of them is rewritten whenever anything
// re-shapes anyway, so the whole set uploads in one call. That is what the WebGPU text batcher
// does too, for the same reason.

import type { Shape } from '../../shapes/Shape'
import type { MSDFText } from '../../shapes/MSDFText'
import type { TextMaterial } from '../../text/layout'
import { quadCorner } from '../../text/textQuad'
import { FILL_TYPE_CODE, MAX_GRADIENT_STOPS } from '../../render/meshFormat'
import {
  TEXT_GLYPH_BIT,
  TEXT_OBJECT_ATLAS_LAYER_OFFSET,
  TEXT_OBJECT_DEPTH_OFFSET,
  TEXT_OBJECT_OPACITY_OFFSET,
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
import { GlObjectTexture } from '../GlObjectTexture'
import type { GlProgram } from '../GlProgram'
import type { GlFontBook } from '../GlFontBook'
import type { GlFontLibrary } from '../GlFontLibrary'

interface ObjectRecord {
  node: MSDFText
  material: TextMaterial
}

export class GlTextBatcher {
  private readonly gl: WebGL2RenderingContext
  private readonly objects: GlObjectTexture

  private vao: WebGLVertexArrayObject | null = null
  private vertexBuffer: WebGLBuffer | null = null
  private indexBuffer: WebGLBuffer | null = null
  private indexCount = 0
  private objectRecords: ObjectRecord[] = []
  /** Where each node's indices end, so a contiguous run of nodes can be drawn alone. */
  private nodeIndexEnds: number[] = []
  // The book each node was shaped against, aligned with nodeIndexEnds. Draw ranges break where
  // this changes, because a range binds one atlas texture.
  private nodeBooks: GlFontBook[] = []

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.objects = new GlObjectTexture(gl, TEXT_OBJECT_STRIDE, 'text-objects')
  }

  /**
   * Shape all MSDFText nodes into the shared buffers, one object record per run.
   *
   * Each node is shaped against ITS OWN family's book, so two nodes in different typefaces pack
   * into the same buffers and differ only in which texture their draw binds.
   */
  rebuild(texts: readonly MSDFText[], fonts: GlFontLibrary): void {
    const gl = this.gl
    const posUvColor: number[] = [] // 8 per vertex: x,y,u,v,r,g,b,a
    const packedIds: number[] = []
    const indices: number[] = []
    let vertexCount = 0
    let objectBase = 0
    this.objectRecords = []
    this.nodeIndexEnds = []
    this.nodeBooks = []

    for (const text of texts) {
      const book = fonts.bookFor(text.fontFamily)
      // Pushed for invisible nodes too: both arrays are indexed by position in `texts`.
      this.nodeBooks.push(book)
      if (!text.visible) {
        this.nodeIndexEnds.push(indices.length)
        continue
      }
      const shaped = text.shaped(book)
      for (const material of shaped.materials) this.objectRecords.push({ node: text, material })

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
        // TL, TR, BR, BL (y-down: y0 is the top edge, y1 the bottom).
        push(q.x0, q.y0, q.u0, q.v0)
        push(q.x1, q.y0, q.u1, q.v0)
        push(q.x1, q.y1, q.u1, q.v1)
        push(q.x0, q.y1, q.u0, q.v1)

        indices.push(b, b + 1, b + 2, b, b + 2, b + 3)
      }
      objectBase += shaped.materials.length
      this.nodeIndexEnds.push(indices.length)
    }

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

    this.releaseGeometry()
    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)

    this.vertexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, vtx, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, TEXT_VERTEX_STRIDE, 0) // position (local)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, TEXT_VERTEX_STRIDE, 8) // uv (atlas)
    gl.enableVertexAttribArray(2)
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, TEXT_VERTEX_STRIDE, 16) // colour
    gl.enableVertexAttribArray(3)
    gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, TEXT_VERTEX_STRIDE, 32) // packedId

    this.indexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW)

    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)

    this.objects.allocate(this.objectRecords.length)
  }

  /** Refresh every run's transform, paint, outline and depth. One upload, per frame. */
  updateObjects(depths: ReadonlyMap<Shape, number>): void {
    if (this.objectRecords.length === 0) return
    const f32 = this.objects.data

    this.objectRecords.forEach(({ node, material }, i) => {
      const base = (i * TEXT_OBJECT_STRIDE) / 4

      f32.set(node.worldMatrix().toGPU(), base)
      f32[base + TEXT_OBJECT_DEPTH_OFFSET / 4] = depths.get(node) ?? 0.5
      f32[base + TEXT_OBJECT_OPACITY_OFFSET / 4] = node.opacity
      // Floats, not reinterpreted integer bits - see GlObjectTexture.ts's header.
      f32[base + TEXT_OBJECT_FILL_TYPE_OFFSET / 4] = FILL_TYPE_CODE[material.fillPriority]

      const stopCount = Math.min(material.stops.length, MAX_GRADIENT_STOPS)
      f32[base + TEXT_OBJECT_STOP_COUNT_OFFSET / 4] = stopCount

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
      f32[base + TEXT_OBJECT_HAS_STROKE_OFFSET / 4] = material.strokeWidth > 0 ? 1 : 0
      f32[base + TEXT_OBJECT_DISTANCE_RANGE_OFFSET / 4] = material.distanceRange
      f32[base + TEXT_OBJECT_DILATE_OFFSET / 4] = material.dilate
      f32[base + TEXT_OBJECT_ATLAS_LAYER_OFFSET / 4] = material.atlasIndex
    })

    this.objects.uploadAll()
  }

  /**
   * Draw only nodes `[fromNode, toNode)` of the last rebuild - which is how the renderer
   * interleaves the lanes back to front. One draw, whatever styles the span mixes: every style
   * is a layer of the one bound array texture (see GlFontBook.ts).
   */
  drawRange(program: GlProgram, fromNode: number, toNode: number): void {
    if (!this.vao || this.indexCount === 0) return
    const first = Math.max(0, fromNode)
    const last = Math.min(toNode, this.nodeIndexEnds.length)
    if (last <= first) return
    const gl = this.gl

    let bound = false
    // Walk the span, emitting a draw whenever the next node's book differs from the run's - one
    // draw per family CHANGE, so a span in a single family stays a single draw.
    let runStart = first
    for (let node = first; node < last; node++) {
      const isLast = node === last - 1
      if (!isLast && this.nodeBooks[node + 1] === this.nodeBooks[runStart]) continue

      const start = runStart <= 0 ? 0 : (this.nodeIndexEnds[runStart - 1] ?? this.indexCount)
      const end = this.nodeIndexEnds[node] ?? this.indexCount
      runStart = node + 1
      if (end <= start) continue

      if (!bound) {
        this.objects.bind(0)
        gl.uniform1i(program.uniform('u_objects'), 0)
        gl.uniform1i(program.uniform('u_objectsWidth'), this.objects.width)
        gl.uniform1i(program.uniform('u_atlas'), 1)
        gl.bindVertexArray(this.vao)
        bound = true
      }
      this.nodeBooks[node].bind(1)
      gl.drawElements(gl.TRIANGLES, end - start, gl.UNSIGNED_INT, start * 4)
    }
    if (bound) gl.bindVertexArray(null)
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
