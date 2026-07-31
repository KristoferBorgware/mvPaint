// The shadow lane on WebGL2: one quad per caster, all sampling the shared atlas.
//
// Geometry is a unit square per caster and never changes - where the quad actually lands, and
// which part of the atlas it samples, are both per-object values rewritten every frame. That
// is what lets a shadow's slot appear, move or be re-baked with no geometry rebuild at all: a
// caster still waiting on its first bake gets a zero-size quad, which rasterizes nothing.
//
// The shadow offset is applied along WORLD axes rather than the shape's own, matching canvas
// 2D - where a shadow's offset lives outside the current transform, so a rotated shape's
// shadow still falls in the direction the light notionally comes from.

import type { Shape } from '../../shapes/Shape'
import { shadowWorldOffset, worldAxisScale } from '../../render/shadowMath'
import {
  SHADOW_OBJECT_COLOR_OFFSET,
  SHADOW_OBJECT_DEPTH_OFFSET,
  SHADOW_OBJECT_QUAD_OFFSET,
  SHADOW_OBJECT_STRIDE,
  SHADOW_OBJECT_UV_OFFSET,
  SHADOW_VERTEX_FLOATS,
  SHADOW_VERTEX_STRIDE,
} from '../../render/shadowFormat'
import { ObjectTexture } from '../ObjectTexture'
import type { GlProgram } from '../programs'
import type { GlShadowAtlas } from '../ShadowAtlas'

const CORNERS: readonly [number, number][] = [
  [0, 1],
  [1, 1],
  [1, 0],
  [0, 0],
]

export class GlShadowBatcher {
  private readonly gl: WebGL2RenderingContext
  private readonly objects: ObjectTexture

  private vao: WebGLVertexArrayObject | null = null
  private vertexBuffer: WebGLBuffer | null = null
  private indexBuffer: WebGLBuffer | null = null
  private casters: Shape[] = []

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.objects = new ObjectTexture(gl, SHADOW_OBJECT_STRIDE, 'shadow-objects')
  }

  /** The casters currently packed - the renderer compares this to decide on a rebuild. */
  get packed(): readonly Shape[] {
    return this.casters
  }

  rebuild(shapes: readonly Shape[]): void {
    const gl = this.gl
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

    this.releaseGeometry()
    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)
    this.vertexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, vtx, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, SHADOW_VERTEX_STRIDE, 0) // corner (0..1)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, SHADOW_VERTEX_STRIDE, 8) // object index
    this.indexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)

    this.objects.allocate(this.casters.length)
  }

  /** Rewrite every shadow's placement, colour, atlas slot and depth. */
  updateObjects(atlas: GlShadowAtlas, depths: ReadonlyMap<Shape, number>, depthNudge: number): void {
    if (this.casters.length === 0) return
    const f32 = this.objects.data

    this.casters.forEach((shape, i) => {
      const base = (i * SHADOW_OBJECT_STRIDE) / 4
      const world = shape.worldMatrix().toGPU()

      // Scaled by the shape's absolute scale but applied along world axes. Prepending it to
      // the world matrix's translation column is the same as multiplying by a world
      // translation, and costs two writes instead of a matrix product.
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

      // Read fresh every frame: a shape still waiting on its first bake, or one the atlas had
      // no room for, gets a zero-size quad rather than sampling whatever sits at uv 0.
      const slot = atlas.slotFor(shape)
      const quadBase = base + SHADOW_OBJECT_QUAD_OFFSET / 4
      const uvBase = base + SHADOW_OBJECT_UV_OFFSET / 4
      f32[quadBase + 0] = slot ? slot.x0 : 0
      f32[quadBase + 1] = slot ? slot.y0 : 0
      f32[quadBase + 2] = slot ? slot.x1 : 0
      f32[quadBase + 3] = slot ? slot.y1 : 0
      f32[uvBase + 0] = slot ? slot.u0 : 0
      f32[uvBase + 1] = slot ? slot.v0 : 0
      f32[uvBase + 2] = slot ? slot.u1 : 0
      f32[uvBase + 3] = slot ? slot.v1 : 0

      f32[base + SHADOW_OBJECT_DEPTH_OFFSET / 4] = (depths.get(shape) ?? 0.5) + depthNudge
    })

    this.objects.uploadAll()
  }

  /**
   * Draw the shadows of casters `[from, to)`. Every caster packs exactly one quad - six
   * indices, in caster order - so the span is arithmetic rather than a lookup.
   */
  drawRange(program: GlProgram, atlas: GlShadowAtlas, from: number, to: number): void {
    if (!this.vao || this.casters.length === 0 || !atlas.ready) return
    const first = Math.max(0, from) * 6
    const last = Math.min(to, this.casters.length) * 6
    if (last <= first) return
    const gl = this.gl

    this.objects.bind(0)
    gl.uniform1i(program.uniform('u_objects'), 0)
    gl.uniform1i(program.uniform('u_objectsWidth'), this.objects.width)
    atlas.bind(1)
    gl.uniform1i(program.uniform('u_atlas'), 1)

    gl.bindVertexArray(this.vao)
    gl.drawElements(gl.TRIANGLES, last - first, gl.UNSIGNED_INT, first * 4)
    gl.bindVertexArray(null)
  }

  destroy(): void {
    this.releaseGeometry()
    this.objects.destroy()
    this.casters = []
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
