// ShadowRenderer - drop shadows for ordinary (mesh-lane) shapes. Unlike Text, which has an
// MSDF distance field to soften analytically (see text/layout.ts), a Rect/Circle/Polyline/
// Path is just hard-edged triangles - there is no per-pixel distance available to widen. So
// shadow blur/spread here is real: each shadow-casting shape is rendered alone into an
// offscreen texture, dilated (spread) and gaussian-blurred (blur) with separable filter
// passes, then composited into an accumulation texture; that accumulation is drawn once,
// first, in the main pass, so shadows always sit behind the entire scene (see the caveat
// below).
//
// Every step after the caster draw is a fullscreen filter pass (see blurFilter.wgsl.ts) -
// dilate reads a texture and writes the per-pixel max over a texel window (a rounded-square
// approximation of true outward silhouette offsetting); blur is a standard separable
// gaussian. Both are separable: one horizontal pass, one vertical, each a full draw over the
// canvas-sized scratch textures. Shapes without spread/blur skip straight to compositing -
// a plain hard shadow costs one caster pass plus one composite, nothing else.
//
// Known simplifications:
// - All shadows composite into ONE layer behind the WHOLE scene, not depth-interleaved per
//   shape against other content (a shape's shadow can't be covered by something behind that
//   shape but in front of a third shape). Getting that right would mean drawing shadows
//   inline with the per-shape depth order, which a single flattened+blurred texture can't
//   represent (blur intentionally mixes neighboring shadows together).
// - Every shadow-casting shape gets its own canvas-sized offscreen pass (simple and exactly
//   correct per-shape blur/spread), so cost scales with the number of shadowed shapes, not
//   with how big or small each one is on screen. Fine for the modest number of shadows a
//   typical scene uses; not built for hundreds of simultaneously shadowed shapes.
// - The dilate filter's separable max window approximates true outward offsetting; a
//   perfect Euclidean spread would need a real distance transform, out of scope here.
//
// Buffer lifetime: every tiny per-shape/per-pass buffer (geometry, shadow placement+color,
// filter params) is freshly allocated and written exactly once - never reused for a second
// value - so an ordinary queue.writeBuffer() is safe despite several of them being written
// before the frame's one submit(): each holds only its own value, and by the time any pass
// executes, every write queued ahead of that submit() has already resolved. (A single
// buffer rewritten with DIFFERENT values between passes would be a real hazard - all those
// writes resolve before the encoder's commands run at all - but nothing here does that.)
// They're destroyed at the start of the NEXT prepare() call, once last frame's submitted
// work has almost certainly finished - a pragmatic simplification rather than fencing their
// GPU completion precisely.

import type { Shape } from '../shapes/Shape'
import { blurFilterShaderCode } from './blurFilter.wgsl'
import { DEPTH_FORMAT } from './depthFormat'
import {
  createFilterParamsBindGroupLayout,
  createFilterPipelineLayout,
  createFilterTextureBindGroupLayout,
  createShadowCasterPipelineLayout,
  createShadowObjectBindGroupLayout,
} from './layouts'
import { shadowCasterShaderCode } from './shadowCaster.wgsl'

const SHADOW_TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm'
const SHADOW_OBJECT_STRIDE = 80 // model: mat4x4<f32> (64) + color: vec4<f32> (16)
const FILTER_PARAMS_STRIDE = 32 // radius+pad (8) + direction (8) + texel (8) + pad (8)
const MAX_FILTER_RADIUS_PX = 64

const PREMULTIPLIED_OVER_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

// Converts a shape's straight (non-premultiplied) color into the offscreen texture via the
// SAME blend equations MeshPipeline uses (straight-alpha color, "over" alpha accumulation) -
// composited against a transparent-cleared texture, that arithmetic is exactly what leaves a
// premultiplied result stored (srcColor*srcAlpha + dst*(1-srcAlpha), dst starting at 0).
const CASTER_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

function makeUniformBuffer(device: GPUDevice, byteLength: number, fill: (f32: Float32Array, u32: Uint32Array) => void): GPUBuffer {
  const data = new ArrayBuffer(byteLength)
  fill(new Float32Array(data), new Uint32Array(data))
  const buffer = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(buffer, 0, data)
  return buffer
}

interface ShadowTexture {
  texture: GPUTexture
  view: GPUTextureView
}

function makeShadowTexture(device: GPUDevice, width: number, height: number): ShadowTexture {
  const texture = device.createTexture({
    size: [width, height],
    format: SHADOW_TEXTURE_FORMAT,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  })
  return { texture, view: texture.createView() }
}

export class ShadowRenderer {
  private readonly device: GPUDevice
  private readonly sampler: GPUSampler

  private readonly casterPipeline: GPURenderPipeline
  private readonly shadowObjectLayout: GPUBindGroupLayout

  private readonly filterParamsLayout: GPUBindGroupLayout
  private readonly filterTextureLayout: GPUBindGroupLayout
  private readonly dilatePipeline: GPURenderPipeline
  private readonly blurPipeline: GPURenderPipeline
  private readonly compositeToAccumPipeline: GPURenderPipeline
  private readonly compositeToMainPipeline: GPURenderPipeline

  private width = 0
  private height = 0
  private rawA: ShadowTexture | null = null
  private rawB: ShadowTexture | null = null
  private accum: ShadowTexture | null = null

  private accumBindGroup: GPUBindGroup | null = null // group(1) for compositing accum -> main
  // Small per-frame scratch buffers (geometry, shadow placement/color, filter params) -
  // recreated every prepare() call, destroyed at the START of the next one (see the file
  // header's note on why that delayed destroy is safe).
  private scratchBuffers: GPUBuffer[] = []

  constructor(
    device: GPUDevice,
    frameLayout: GPUBindGroupLayout,
    mainFormat: GPUTextureFormat,
    mainSampleCount: number,
  ) {
    this.device = device
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })

    this.shadowObjectLayout = createShadowObjectBindGroupLayout(device)
    const casterLayout = createShadowCasterPipelineLayout(device, frameLayout, this.shadowObjectLayout)
    const casterModule = device.createShaderModule({ code: shadowCasterShaderCode })
    this.casterPipeline = device.createRenderPipeline({
      layout: casterLayout,
      vertex: {
        module: casterModule,
        entryPoint: 'vs_main',
        buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
      },
      fragment: {
        module: casterModule,
        entryPoint: 'fs_main',
        targets: [{ format: SHADOW_TEXTURE_FORMAT, blend: CASTER_BLEND }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    })

    this.filterParamsLayout = createFilterParamsBindGroupLayout(device)
    this.filterTextureLayout = createFilterTextureBindGroupLayout(device)
    const filterLayout = createFilterPipelineLayout(device, this.filterParamsLayout, this.filterTextureLayout)
    const filterModule = device.createShaderModule({ code: blurFilterShaderCode })
    const filterPipeline = (entryPoint: string, format: GPUTextureFormat, blend: GPUBlendState | undefined, withDepth: boolean, sampleCount: number): GPURenderPipeline =>
      device.createRenderPipeline({
        layout: filterLayout,
        vertex: { module: filterModule, entryPoint: 'vs_fullscreen' },
        fragment: { module: filterModule, entryPoint, targets: [{ format, blend }] },
        primitive: { topology: 'triangle-list' },
        depthStencil: withDepth ? { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' } : undefined,
        multisample: { count: sampleCount },
      })

    this.dilatePipeline = filterPipeline('fs_dilate', SHADOW_TEXTURE_FORMAT, undefined, false, 1)
    this.blurPipeline = filterPipeline('fs_blur', SHADOW_TEXTURE_FORMAT, undefined, false, 1)
    this.compositeToAccumPipeline = filterPipeline('fs_composite', SHADOW_TEXTURE_FORMAT, PREMULTIPLIED_OVER_BLEND, false, 1)
    this.compositeToMainPipeline = filterPipeline('fs_composite', mainFormat, PREMULTIPLIED_OVER_BLEND, true, mainSampleCount)
  }

  private ensureTextures(width: number, height: number): void {
    if (this.width === width && this.height === height && this.rawA && this.rawB && this.accum) return
    this.width = width
    this.height = height
    this.rawA?.texture.destroy()
    this.rawB?.texture.destroy()
    this.accum?.texture.destroy()
    this.rawA = makeShadowTexture(this.device, width, height)
    this.rawB = makeShadowTexture(this.device, width, height)
    this.accum = makeShadowTexture(this.device, width, height)
    this.accumBindGroup = this.device.createBindGroup({
      layout: this.filterTextureLayout,
      entries: [
        { binding: 0, resource: this.accum.view },
        { binding: 1, resource: this.sampler },
      ],
    })
  }

  private destroyScratch(): void {
    for (const buffer of this.scratchBuffers) buffer.destroy()
    this.scratchBuffers = []
  }

  private textureBindGroup(view: GPUTextureView): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.filterTextureLayout,
      entries: [
        { binding: 0, resource: view },
        { binding: 1, resource: this.sampler },
      ],
    })
  }

  private filterParamsBuffer(radiusPx: number, direction: readonly [number, number]): GPUBuffer {
    const buffer = makeUniformBuffer(this.device, FILTER_PARAMS_STRIDE, (f32) => {
      f32[0] = Math.min(radiusPx, MAX_FILTER_RADIUS_PX)
      f32[2] = direction[0]
      f32[3] = direction[1]
      f32[4] = 1 / this.width
      f32[5] = 1 / this.height
    })
    this.scratchBuffers.push(buffer)
    return buffer
  }

  private runFilterPass(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    srcView: GPUTextureView,
    dstView: GPUTextureView,
    radiusPx: number,
    direction: readonly [number, number],
  ): void {
    const paramsBuffer = this.filterParamsBuffer(radiusPx, direction)
    const paramsBindGroup = this.device.createBindGroup({
      layout: this.filterParamsLayout,
      entries: [{ binding: 0, resource: { buffer: paramsBuffer } }],
    })
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: dstView, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, paramsBindGroup)
    pass.setBindGroup(1, this.textureBindGroup(srcView))
    pass.draw(3)
    pass.end()
  }

  /**
   * Renders every shadow-casting shape into the accumulation texture, ready for
   * composite(). Call once per frame, BEFORE the main render pass begins (it needs its own
   * passes on the same encoder) - see webgpu/SceneRenderer's prepareShadows/draw split.
   * `pixelsPerWorldUnit` converts a shadow's blur/spread (world units) to a texel radius.
   */
  prepare(
    encoder: GPUCommandEncoder,
    frameBindGroup: GPUBindGroup,
    shapes: readonly Shape[],
    width: number,
    height: number,
    pixelsPerWorldUnit: number,
  ): void {
    this.destroyScratch()
    this.ensureTextures(width, height)
    const rawA = this.rawA!
    const rawB = this.rawB!
    const accum = this.accum!

    // Clear the accumulator once per frame; each shadow shape composites into it below.
    encoder.beginRenderPass({
      colorAttachments: [{ view: accum.view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
    }).end()

    for (const shape of shapes) {
      if (!shape.visible || !shape.shadow) continue
      const s = shape.shadow
      const model = shape.shadowWorldMatrix()
      if (!model) continue

      // isFill mirrors the mesh lane's own fill/stroke distinction (see meshFormat.ts's
      // MeshSink) - recorded per vertex so a triangle can be excluded at the point it's
      // emitted when the shadow is configured to skip the stroke ring entirely.
      const positions: number[] = []
      const isFill: boolean[] = []
      const indices: number[] = []
      shape.tessellate({
        vertex: (x, y, fill) => {
          positions.push(x, y)
          isFill.push(fill)
          return positions.length / 2 - 1
        },
        triangle: (a, b, c) => {
          if (!s.includeStroke && !(isFill[a] && isFill[b] && isFill[c])) return
          indices.push(a, b, c)
        },
      })
      if (indices.length === 0) continue

      const vertexData = new Float32Array(positions)
      const vertexBuffer = this.device.createBuffer({
        size: Math.max(vertexData.byteLength, 8),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(vertexBuffer, 0, vertexData)
      this.scratchBuffers.push(vertexBuffer)

      const indexData = new Uint32Array(indices)
      const indexBuffer = this.device.createBuffer({
        size: Math.max(indexData.byteLength, 4),
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(indexBuffer, 0, indexData)
      this.scratchBuffers.push(indexBuffer)

      // Written STRAIGHT (not premultiplied) - CASTER_BLEND multiplies by alpha itself on
      // the way into the (transparent-cleared) texture, same as MeshPipeline's blend does
      // for every ordinary shape's fillColor.
      const objectBuffer = makeUniformBuffer(this.device, SHADOW_OBJECT_STRIDE, (f32) => {
        f32.set(model.toGPU(), 0)
        f32[16] = s.color[0]
        f32[17] = s.color[1]
        f32[18] = s.color[2]
        f32[19] = s.color[3] * s.opacity
      })
      this.scratchBuffers.push(objectBuffer)
      const objectBindGroup = this.device.createBindGroup({
        layout: this.shadowObjectLayout,
        entries: [{ binding: 0, resource: { buffer: objectBuffer } }],
      })

      const casterPass = encoder.beginRenderPass({
        colorAttachments: [{ view: rawA.view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
      })
      casterPass.setPipeline(this.casterPipeline)
      casterPass.setBindGroup(0, frameBindGroup)
      casterPass.setBindGroup(1, objectBindGroup)
      casterPass.setVertexBuffer(0, vertexBuffer)
      casterPass.setIndexBuffer(indexBuffer, 'uint32')
      casterPass.drawIndexed(indexData.length)
      casterPass.end()

      const spreadPx = s.spread * pixelsPerWorldUnit
      const blurPx = s.blur * pixelsPerWorldUnit

      let current = rawA
      let scratch = rawB
      if (spreadPx > 0) {
        this.runFilterPass(encoder, this.dilatePipeline, current.view, scratch.view, spreadPx, [1, 0])
        ;[current, scratch] = [scratch, current]
        this.runFilterPass(encoder, this.dilatePipeline, current.view, scratch.view, spreadPx, [0, 1])
        ;[current, scratch] = [scratch, current]
      }
      if (blurPx > 0) {
        this.runFilterPass(encoder, this.blurPipeline, current.view, scratch.view, blurPx, [1, 0])
        ;[current, scratch] = [scratch, current]
        this.runFilterPass(encoder, this.blurPipeline, current.view, scratch.view, blurPx, [0, 1])
        ;[current, scratch] = [scratch, current]
      }

      const compositePass = encoder.beginRenderPass({
        colorAttachments: [{ view: accum.view, loadOp: 'load', storeOp: 'store' }],
      })
      compositePass.setPipeline(this.compositeToAccumPipeline)
      compositePass.setBindGroup(0, this.filterParamsBindGroupForComposite())
      compositePass.setBindGroup(1, this.textureBindGroup(current.view))
      compositePass.draw(3)
      compositePass.end()
    }
  }

  // The composite entry point ignores FilterParams entirely, but the shared pipeline
  // layout still needs a bound group(0) - a zeroed buffer is fine.
  private filterParamsBindGroupForComposite(): GPUBindGroup {
    const buffer = makeUniformBuffer(this.device, FILTER_PARAMS_STRIDE, () => {})
    this.scratchBuffers.push(buffer)
    return this.device.createBindGroup({ layout: this.filterParamsLayout, entries: [{ binding: 0, resource: { buffer } }] })
  }

  /** Composites the accumulated shadow layer onto `pass` - call FIRST, before any scene content. */
  composite(pass: GPURenderPassEncoder): void {
    if (!this.accumBindGroup) return
    const paramsBuffer = makeUniformBuffer(this.device, FILTER_PARAMS_STRIDE, () => {})
    this.scratchBuffers.push(paramsBuffer)
    const paramsBindGroup = this.device.createBindGroup({
      layout: this.filterParamsLayout,
      entries: [{ binding: 0, resource: { buffer: paramsBuffer } }],
    })
    pass.setPipeline(this.compositeToMainPipeline)
    pass.setBindGroup(0, paramsBindGroup)
    pass.setBindGroup(1, this.accumBindGroup)
    pass.draw(3)
  }

  destroy(): void {
    this.destroyScratch()
    this.rawA?.texture.destroy()
    this.rawB?.texture.destroy()
    this.accum?.texture.destroy()
  }
}
