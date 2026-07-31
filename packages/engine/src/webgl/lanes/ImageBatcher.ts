// The image lane on WebGL2: every Image node's quad in one buffer pair, drawn as a run of
// ranges - the same shape as render/ImageBatcher.ts.
//
// A range is a stretch of quads sharing one texture AND one sampler state. Consecutive quads
// that agree on both merge into a single draw, so a sprite sheet used forty times costs one
// bind and one call rather than forty. Ordering is the caller's and is deliberately NOT
// re-sorted to group textures: regrouping would cut binds further but would also reorder
// overlapping translucent images against each other, which the depth buffer alone cannot put
// right.
//
// This is the lane with the most draws on either path, and for the same reason: an
// application's pictures are of any size and format, so pooling them means a real atlas
// allocator rather than the four fixed layers the font atlas gets away with.

import type { Image } from '../../shapes/Image'
import type { ImageSampling } from '../../image/ImageTexture'
import {
  IMAGE_OBJECT_DEPTH_OFFSET,
  IMAGE_OBJECT_STRIDE,
  IMAGE_OBJECT_TINT_OFFSET,
  IMAGE_VERTEX_FLOATS,
  IMAGE_VERTEX_STRIDE,
} from '../../render/imageFormat'
import { GlImageTexture } from '../ImageTexture'
import { ObjectTexture } from '../ObjectTexture'
import type { GlProgram } from '../programs'

/** A stretch of indices sharing one texture and one sampler state. */
interface DrawRange {
  texture: GlImageTexture
  sampling: ImageSampling
  firstIndex: number
  indexCount: number
}

function sameSampling(a: ImageSampling, b: ImageSampling): boolean {
  return a.wrapX === b.wrapX && a.wrapY === b.wrapY && a.filter === b.filter
}

/**
 * An Image node holds the backend-neutral ImageTexture interface, because the scene graph
 * knows no GPU API. This lane does, and only ever sees textures its own renderer created - so
 * the narrowing always succeeds. It is checked rather than asserted because the one way to
 * reach here otherwise is to build a texture on one render path and draw it on the other, and
 * a sentence saying so beats a blank rectangle.
 */
function glTextureOf(image: Image): GlImageTexture {
  const texture = image.texture
  if (!(texture instanceof GlImageTexture)) {
    throw new Error(
      `GlImageBatcher: "${image.name || image.nodeName}" carries an image texture built for a different render path`,
    )
  }
  return texture
}

export class GlImageBatcher {
  private readonly gl: WebGL2RenderingContext
  private readonly objects: ObjectTexture

  private vao: WebGLVertexArrayObject | null = null
  private vertexBuffer: WebGLBuffer | null = null
  private indexBuffer: WebGLBuffer | null = null
  private indexCount = 0
  private nodes: Image[] = []
  private ranges: DrawRange[] = []
  /** Cumulative index count after each node handed to rebuild(), aligned with it by position. */
  private nodeIndexEnds: number[] = []

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.objects = new ObjectTexture(gl, IMAGE_OBJECT_STRIDE, 'image-objects')
  }

  /** Rebuild every quad. Only needed when the SET of images, or one's UVs, change. */
  rebuild(images: readonly Image[]): void {
    const gl = this.gl
    const posUv: number[] = []
    const objectIds: number[] = []
    const indices: number[] = []
    let vertexCount = 0
    this.nodes = []
    this.ranges = []
    this.nodeIndexEnds = []

    for (const image of images) {
      if (!image.visible) {
        this.nodeIndexEnds.push(indices.length)
        continue
      }
      const objectId = this.nodes.length
      this.nodes.push(image)

      // The node's origin is the picture's top-left corner, so the quad hangs below it -
      // matching Image.buildGeometry(), which is what picking and the shadow silhouette use.
      const w = image.width
      const b = -image.height
      const { u0, v0, u1, v1 } = image.uvRect()
      // v runs down the image while y runs up the scene, so the top-left texel belongs to the
      // quad's +y corner - otherwise every image would come out upside down.
      const corners = [
        [0, b, u0, v1],
        [w, b, u1, v1],
        [w, 0, u1, v0],
        [0, 0, u0, v0],
      ]
      for (const [x, y, u, v] of corners) {
        posUv.push(x, y, u, v)
        objectIds.push(objectId)
      }

      const base = vertexCount
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
      vertexCount += 4

      const sampling: ImageSampling = { wrapX: image.wrapX, wrapY: image.wrapY, filter: image.filter }
      const texture = glTextureOf(image)
      const last = this.ranges[this.ranges.length - 1]
      if (last && last.texture === texture && sameSampling(last.sampling, sampling)) {
        last.indexCount += 6
      } else {
        this.ranges.push({ texture, sampling, firstIndex: indices.length - 6, indexCount: 6 })
      }
      this.nodeIndexEnds.push(indices.length)
    }

    const vtx = new ArrayBuffer(vertexCount * IMAGE_VERTEX_STRIDE)
    const f32 = new Float32Array(vtx)
    const u32 = new Uint32Array(vtx)
    for (let i = 0; i < vertexCount; i++) {
      const b = i * IMAGE_VERTEX_FLOATS
      f32[b + 0] = posUv[i * 4 + 0]
      f32[b + 1] = posUv[i * 4 + 1]
      f32[b + 2] = posUv[i * 4 + 2]
      f32[b + 3] = posUv[i * 4 + 3]
      u32[b + 4] = objectIds[i]
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
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, IMAGE_VERTEX_STRIDE, 0) // position (local)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, IMAGE_VERTEX_STRIDE, 8) // uv
    gl.enableVertexAttribArray(2)
    gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, IMAGE_VERTEX_STRIDE, 16) // object index

    this.indexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW)

    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)

    this.objects.allocate(this.nodes.length)
  }

  /** Rewrite each quad's transform, tint and depth. Geometry is untouched. */
  updateObjects(depths: ReadonlyMap<Image, number>): void {
    if (this.nodes.length === 0) return
    const f32 = this.objects.data
    this.nodes.forEach((image, i) => {
      const base = (i * IMAGE_OBJECT_STRIDE) / 4
      f32.set(image.worldMatrix().toGPU(), base)
      const t = image.tint
      const tintBase = base + IMAGE_OBJECT_TINT_OFFSET / 4
      f32[tintBase + 0] = t[0]
      f32[tintBase + 1] = t[1]
      f32[tintBase + 2] = t[2]
      f32[tintBase + 3] = t[3]
      f32[base + IMAGE_OBJECT_DEPTH_OFFSET / 4] = depths.get(image) ?? 0.5
    })
    this.objects.uploadAll()
  }

  /**
   * Draw nodes `[fromNode, toNode)`, one call per texture+sampler run inside that span. The
   * runs are clipped to the span rather than rebuilt, so a partial draw costs the same per-run
   * bind as a whole one and never more runs than the whole lane.
   */
  drawRange(program: GlProgram, fromNode: number, toNode: number): void {
    if (!this.vao || this.indexCount === 0) return
    const start = fromNode <= 0 ? 0 : (this.nodeIndexEnds[fromNode - 1] ?? this.indexCount)
    const end =
      toNode <= 0 ? 0 : (this.nodeIndexEnds[Math.min(toNode, this.nodeIndexEnds.length) - 1] ?? this.indexCount)
    if (end <= start) return
    const gl = this.gl

    this.objects.bind(0)
    gl.uniform1i(program.uniform('u_objects'), 0)
    gl.uniform1i(program.uniform('u_objectsWidth'), this.objects.width)
    gl.uniform1i(program.uniform('u_image'), 1)

    gl.bindVertexArray(this.vao)
    for (const range of this.ranges) {
      const first = Math.max(range.firstIndex, start)
      const last = Math.min(range.firstIndex + range.indexCount, end)
      if (last <= first) continue
      range.texture.bind(1, range.sampling)
      gl.drawElements(gl.TRIANGLES, last - first, gl.UNSIGNED_INT, first * 4)
    }
    gl.bindVertexArray(null)
  }

  /** How many draws the current build costs - one per texture+sampler run. */
  get rangeCount(): number {
    return this.ranges.length
  }

  destroy(): void {
    this.releaseGeometry()
    this.objects.destroy()
    this.nodes = []
    this.ranges = []
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
