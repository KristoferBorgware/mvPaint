// ImageBatcher - every Image node's quad in one vertex/index buffer, with one per-object
// record each, drawn as a run of ranges.
//
// A range is a stretch of quads sharing one bind group, and the bind group is the texture
// AND its sampler state together (see image/ImageTexture). Consecutive quads that agree on
// both merge into a single draw, so a sprite sheet used forty times, or a tiled background
// repeated across a scene, costs one bind and one drawIndexed rather than forty.
//
// Ordering is the caller's - the quads arrive already in zIndex rank order - and is NOT
// re-sorted to group textures together. Regrouping would cut binds further, but it would
// also reorder overlapping translucent images against each other, which the depth buffer
// alone cannot put right. The same trade the text lane makes between atlases.
//
// updateObjects() rewrites the transforms, tints and depths each frame without touching the
// geometry, so moving, fading or restacking an image never rebuilds a buffer - only changing
// which texture it shows, or how it is cropped or tiled, does.

import type { Image } from '../../shapes/Image'
import type { ImageSampling } from '../../image/ImageTexture'
import { WebGpuImageTexture } from '../ImageTexture'
import {
  IMAGE_OBJECT_DEPTH_OFFSET,
  IMAGE_OBJECT_STRIDE,
  IMAGE_OBJECT_TINT_OFFSET,
  IMAGE_VERTEX_FLOATS,
  IMAGE_VERTEX_STRIDE,
} from '../../render/imageFormat'

/** A stretch of indices sharing one texture + sampler bind group. */
interface DrawRange {
  texture: WebGpuImageTexture
  sampling: ImageSampling
  firstIndex: number
  indexCount: number
}

/**
 * An Image node holds the backend-neutral ImageTexture interface, because the scene graph
 * knows no GPU API (see image/ImageTexture.ts). This lane does know, and only ever sees
 * textures its own renderer created - so the narrowing always succeeds. It is checked rather
 * than asserted because the one way to get here otherwise is to build a texture on one render
 * path and draw it on the other, and "your image is blank" is a far worse way to find that
 * out than a sentence saying so.
 */
function webGpuTextureOf(image: Image): WebGpuImageTexture {
  const texture = image.texture
  if (!(texture instanceof WebGpuImageTexture)) {
    throw new Error(
      `ImageBatcher: "${image.name || image.nodeName}" carries an image texture built for a different render path`,
    )
  }
  return texture
}

function sameSampling(a: ImageSampling, b: ImageSampling): boolean {
  return a.wrapX === b.wrapX && a.wrapY === b.wrapY && a.filter === b.filter
}

export class ImageBatcher {
  private readonly device: GPUDevice
  private readonly objectLayout: GPUBindGroupLayout

  private vertexBuffer: GPUBuffer | null = null
  private indexBuffer: GPUBuffer | null = null
  private objectBuffer: GPUBuffer | null = null
  private objectBindGroup: GPUBindGroup | null = null

  private indexCount = 0
  private nodes: Image[] = []
  private ranges: DrawRange[] = []
  // Cumulative index count after each Image handed to rebuild(), aligned with that argument
  // by position (an invisible node contributes nothing but still takes a slot). This is what
  // lets any run of nodes be drawn on its own, which is how the renderer interleaves the
  // lanes back to front - see SceneRenderer's draw().
  private nodeIndexEnds: number[] = []

  constructor(device: GPUDevice, objectLayout: GPUBindGroupLayout) {
    this.device = device
    this.objectLayout = objectLayout
  }

  /** Rebuilds every quad's geometry. Only needed when the SET of images, or one's UVs, change. */
  rebuild(images: readonly Image[]): void {
    const posUv: number[] = [] // 4 per vertex: x, y, u, v
    const packedIds: number[] = [] // 1 per vertex: the object index
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
      // v runs down the image while y runs up the scene, so the top-left texel belongs to
      // the quad's +y corner - otherwise every image would come out upside down.
      const corners = [
        [0, b, u0, v1],
        [w, b, u1, v1],
        [w, 0, u1, v0],
        [0, 0, u0, v0],
      ]
      for (const [x, y, u, v] of corners) {
        posUv.push(x, y, u, v)
        packedIds.push(objectId)
      }

      const base = vertexCount
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
      vertexCount += 4

      const sampling: ImageSampling = { wrapX: image.wrapX, wrapY: image.wrapY, filter: image.filter }
      const texture = webGpuTextureOf(image)
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
      u32[b + 4] = packedIds[i]
    }
    const idx = new Uint32Array(indices)
    this.indexCount = idx.length

    this.vertexBuffer?.destroy()
    this.vertexBuffer = null
    if (vtx.byteLength > 0) {
      this.vertexBuffer = this.device.createBuffer({
        label: 'image-vertices',
        size: vtx.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(this.vertexBuffer, 0, vtx)
    }

    this.indexBuffer?.destroy()
    this.indexBuffer = null
    if (idx.byteLength > 0) {
      this.indexBuffer = this.device.createBuffer({
        label: 'image-indices',
        size: idx.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(this.indexBuffer, 0, idx)
    }

    this.objectBuffer?.destroy()
    this.objectBuffer = this.device.createBuffer({
      label: 'image-objects',
      size: Math.max(1, this.nodes.length) * IMAGE_OBJECT_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    this.objectBindGroup = this.device.createBindGroup({
      label: 'image-objects',
      layout: this.objectLayout,
      entries: [{ binding: 0, resource: { buffer: this.objectBuffer } }],
    })
  }

  /** Rewrites each quad's transform, tint and depth. Geometry is untouched. */
  updateObjects(depths: ReadonlyMap<Image, number>): void {
    if (!this.objectBuffer || this.nodes.length === 0) return
    const buf = new ArrayBuffer(this.nodes.length * IMAGE_OBJECT_STRIDE)
    const f32 = new Float32Array(buf)

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

    this.device.queue.writeBuffer(this.objectBuffer, 0, buf)
  }

  /** Draws each range with its own texture bound (group 2); groups 0/1 are set once. */
  draw(pass: GPURenderPassEncoder, frameBindGroup: GPUBindGroup): void {
    this.drawRange(pass, frameBindGroup, 0, this.nodeIndexEnds.length)
  }

  /**
   * Draw only the nodes [fromNode, toNode) of the last rebuild, in that order. The
   * texture+sampler runs are clipped to that span rather than rebuilt, so a partial draw
   * costs the same per-run bind as a whole one and never more runs than the whole lane.
   */
  drawRange(pass: GPURenderPassEncoder, frameBindGroup: GPUBindGroup, fromNode: number, toNode: number): void {
    if (!this.vertexBuffer || !this.indexBuffer || !this.objectBindGroup || this.indexCount === 0) return
    const start = fromNode <= 0 ? 0 : (this.nodeIndexEnds[fromNode - 1] ?? this.indexCount)
    const end = toNode <= 0 ? 0 : (this.nodeIndexEnds[Math.min(toNode, this.nodeIndexEnds.length) - 1] ?? this.indexCount)
    if (end <= start) return

    pass.setBindGroup(0, frameBindGroup)
    pass.setBindGroup(1, this.objectBindGroup)
    pass.setVertexBuffer(0, this.vertexBuffer)
    pass.setIndexBuffer(this.indexBuffer, 'uint32')
    for (const range of this.ranges) {
      const first = Math.max(range.firstIndex, start)
      const last = Math.min(range.firstIndex + range.indexCount, end)
      if (last <= first) continue
      pass.setBindGroup(2, range.texture.bindGroupFor(range.sampling))
      pass.drawIndexed(last - first, 1, first)
    }
  }

  /** How many draws the current build costs - one per texture+sampler run. */
  get rangeCount(): number {
    return this.ranges.length
  }

  destroy(): void {
    this.vertexBuffer?.destroy()
    this.indexBuffer?.destroy()
    this.objectBuffer?.destroy()
    this.vertexBuffer = null
    this.indexBuffer = null
    this.objectBuffer = null
    this.objectBindGroup = null
    this.nodes = []
    this.ranges = []
    this.indexCount = 0
  }
}
