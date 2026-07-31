// The shadow atlas on WebGL2: blurred silhouettes baked once into one shared R8 texture.
//
// The same cache as render/ShadowAtlas.ts, keyed on the same things - geometry version, blur,
// spread, whether the stroke casts - so a shape that is only being moved, spun or zoomed
// re-bakes nothing. Every pass is bounded by the slot (at most MAX_REGION on a side) rather
// than by the canvas, which is what makes a blurred shadow affordable at all.
//
// R8 is colour-renderable in WebGL2 core, so the atlas and both scratch textures are single
// channel: a shadow is a stencil, and its colour lives in the object record.
//
// The one genuinely divergent detail is render-to-texture orientation - see the header of
// shaders/shadow.glsl.ts, which explains the two places it is corrected and why they have to
// agree. The y negation below is the first of them.

import type { Shape } from '../shapes/Shape'
import { silhouetteOf, MAX_REGION, type ShadowSlot } from '../render/ShadowAtlas'
import { shadowQuadBounds, shadowRegion, shadowSigma, slotBucket, type ShadowRegion } from '../render/shadowMath'
import { GlProgram, type GlStateCache } from './programs'
import {
  shadowBlurFragmentGlsl,
  shadowFilterVertexGlsl,
  shadowMorphologyFragmentGlsl,
  shadowSilhouetteFragmentGlsl,
  shadowSilhouetteVertexGlsl,
} from './shaders/shadow.glsl'

const INITIAL_ATLAS_SIZE = 1024
/** Slots are padded apart so a neighbour's texels can never bleed in under linear filtering. */
const SLOT_GUTTER = 1

interface Entry extends ShadowSlot {
  rectX: number
  rectY: number
  width: number
  height: number
  /** The rectangle actually RESERVED, which can exceed the region currently baked into it. */
  allocWidth: number
  allocHeight: number
  geometryVersion: number
  blur: number
  spread: number
  forStroke: boolean
}

type Silhouette = NonNullable<ReturnType<typeof silhouetteOf>>

interface PlannedBake {
  shape: Shape
  silhouette: Silhouette
  region: ShadowRegion
  rect: { x: number; y: number }
  alloc: { width: number; height: number }
}

export class GlShadowAtlas {
  private readonly gl: WebGL2RenderingContext
  private readonly maxAtlasSize: number

  private readonly silhouetteProgram: GlProgram
  private readonly blurProgram: GlProgram
  private readonly morphologyProgram: GlProgram

  private texture: WebGLTexture | null = null
  private scratchA: WebGLTexture | null = null
  private scratchB: WebGLTexture | null = null
  private framebuffer: WebGLFramebuffer | null = null
  /** A VAO with no attributes, for the fullscreen triangle drawn from gl_VertexID alone. */
  private emptyVao: WebGLVertexArrayObject | null = null
  private silhouetteVao: WebGLVertexArrayObject | null = null
  private silhouetteVertices: WebGLBuffer | null = null
  private silhouetteIndices: WebGLBuffer | null = null

  private atlasSize = 0
  private shelfY = 0
  private shelfHeight = 0
  private cursorX = 0
  private readonly entries = new Map<Shape, Entry>()

  constructor(gl: WebGL2RenderingContext, stateCache: GlStateCache) {
    this.gl = gl
    this.maxAtlasSize = Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number)

    // Every bake pass replaces what it writes: no blending, no depth. The state cache still
    // tracks them, so returning to the main pass restores what that needs.
    const bakeState = { blend: false, depthTest: false, depthWrite: false, depthFunc: gl.ALWAYS }
    this.silhouetteProgram = new GlProgram(gl, stateCache, {
      label: 'shadow-silhouette',
      vertex: shadowSilhouetteVertexGlsl,
      fragment: shadowSilhouetteFragmentGlsl,
      state: bakeState,
    })
    this.blurProgram = new GlProgram(gl, stateCache, {
      label: 'shadow-blur',
      vertex: shadowFilterVertexGlsl,
      fragment: shadowBlurFragmentGlsl,
      state: bakeState,
    })
    this.morphologyProgram = new GlProgram(gl, stateCache, {
      label: 'shadow-morphology',
      vertex: shadowFilterVertexGlsl,
      fragment: shadowMorphologyFragmentGlsl,
      state: bakeState,
    })
  }

  /** The baked slot for a shape, or null if it has none. */
  slotFor(shape: Shape): ShadowSlot | null {
    return this.entries.get(shape) ?? null
  }

  bind(unit: number): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
  }

  get ready(): boolean {
    return this.texture !== null
  }

  /**
   * Re-bake any shape whose cached silhouette is stale, and drop entries for shapes that no
   * longer cast. Called once per frame BEFORE the main pass - baking binds its own
   * framebuffer, and it would be a mess to do that halfway through drawing the scene.
   * Shapes already up to date cost nothing.
   */
  update(shapes: readonly Shape[]): void {
    const casters = shapes.filter((s) => s.visible && s.hasShadow())
    const live = new Set(casters)
    for (const shape of [...this.entries.keys()]) {
      if (!live.has(shape)) this.entries.delete(shape)
    }

    const stale = casters.filter((shape) => {
      const entry = this.entries.get(shape)
      return (
        !entry ||
        entry.geometryVersion !== shape.geometryVersion ||
        entry.blur !== shape.shadowBlur ||
        entry.spread !== shape.shadowSpread ||
        entry.forStroke !== shape.shadowForStrokeEnabled
      )
    })
    if (stale.length === 0) return

    this.ensureTextures(this.atlasSize || INITIAL_ATLAS_SIZE)
    // Decide the whole layout before baking anything: planning is what may grow the atlas, and
    // growing replaces the texture. Unlike WebGPU there is no recorded command buffer to
    // invalidate here, but keeping the ordering means the two paths stay easy to compare.
    const plan = this.planBakes(stale, casters)
    try {
      for (const item of plan) this.bakeOne(item)
    } finally {
      // In a finally, not after the loop: a bake that throws would otherwise leave the atlas
      // framebuffer bound, and every subsequent frame would draw the whole scene into the
      // shadow atlas instead of the canvas - a black screen whose cause is nowhere near
      // where it shows up.
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null)
    }
  }

  private ensureTextures(size: number): void {
    const gl = this.gl
    if (this.texture && this.atlasSize === size) return
    if (this.texture) gl.deleteTexture(this.texture)
    this.atlasSize = size
    this.texture = this.createR8(size, size)

    if (!this.scratchA) {
      this.scratchA = this.createR8(MAX_REGION, MAX_REGION)
      this.scratchB = this.createR8(MAX_REGION, MAX_REGION)
      this.framebuffer = gl.createFramebuffer()
      this.emptyVao = gl.createVertexArray()
      this.silhouetteVao = gl.createVertexArray()
      this.silhouetteVertices = gl.createBuffer()
      this.silhouetteIndices = gl.createBuffer()
      gl.bindVertexArray(this.silhouetteVao)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.silhouetteVertices)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.silhouetteIndices)
      gl.bindVertexArray(null)
      gl.bindBuffer(gl.ARRAY_BUFFER, null)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)
    }
  }

  private createR8(width: number, height: number): WebGLTexture {
    const gl = this.gl
    const texture = gl.createTexture()
    if (!texture) throw new Error('GlShadowAtlas: could not create a texture')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, width, height)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)
    return texture
  }

  private resetPacker(): void {
    this.shelfY = 0
    this.shelfHeight = 0
    this.cursorX = 0
  }

  /** Reserve a slot rectangle, or null when the atlas is full at its current size. */
  private packSlot(width: number, height: number): { x: number; y: number } | null {
    const w = width + SLOT_GUTTER
    const h = height + SLOT_GUTTER
    if (this.cursorX + w > this.atlasSize) {
      this.shelfY += this.shelfHeight
      this.shelfHeight = 0
      this.cursorX = 0
    }
    if (this.shelfY + h > this.atlasSize) return null
    const x = this.cursorX
    const y = this.shelfY
    this.cursorX += w
    this.shelfHeight = Math.max(this.shelfHeight, h)
    return { x, y }
  }

  private planBakes(stale: readonly Shape[], casters: readonly Shape[]): PlannedBake[] {
    // A stale entry's old rectangle is not reclaimed individually (the shelf packer only ever
    // moves forward), so once the atlas fills everything is repacked and re-baked. Growing
    // first keeps that from happening every frame on a busy scene.
    for (let attempt = 0; attempt < 8; attempt++) {
      const plan = this.tryPlan(attempt === 0 ? stale : casters, false)
      if (plan) return plan
      if (this.atlasSize >= this.maxAtlasSize) {
        // Out of room even at the largest atlas: plan what fits and leave the rest without a
        // slot, so they render no shadow rather than a corrupted one.
        this.entries.clear()
        this.resetPacker()
        return this.tryPlan(casters, true) ?? []
      }
      this.ensureTextures(Math.min(this.maxAtlasSize, this.atlasSize * 2))
      this.entries.clear()
      this.resetPacker()
    }
    return []
  }

  private tryPlan(shapes: readonly Shape[], partial: boolean): PlannedBake[] | null {
    const plan: PlannedBake[] = []
    for (const shape of shapes) {
      const silhouette = silhouetteOf(shape)
      if (!silhouette) {
        this.entries.delete(shape)
        continue
      }
      const region = shadowRegion(
        silhouette.maxX - silhouette.minX,
        silhouette.maxY - silhouette.minY,
        shape.shadowBlur,
        shape.shadowSpread,
        MAX_REGION,
      )

      // Re-bake into the rectangle this shape already holds whenever the new region still fits
      // it: without this, dragging a blur slider would abandon a rectangle every frame and
      // burn through the atlas. Reservations are on a coarse grid so a slider swept back and
      // forth settles instead of churning on rounding noise.
      const existing = this.entries.get(shape)
      const reusable = existing && existing.allocWidth >= region.width && existing.allocHeight >= region.height
      const alloc = reusable
        ? { width: existing.allocWidth, height: existing.allocHeight }
        : { width: slotBucket(region.width, MAX_REGION), height: slotBucket(region.height, MAX_REGION) }
      const rect = reusable ? { x: existing.rectX, y: existing.rectY } : this.packSlot(alloc.width, alloc.height)
      if (!rect) return partial ? plan : null

      plan.push({ shape, silhouette, region, rect, alloc })
    }
    return plan
  }

  private bakeOne({ shape, silhouette, region, rect, alloc }: PlannedBake): void {
    const gl = this.gl
    const quad = shadowQuadBounds(silhouette.minX, silhouette.minY, region)
    const quadW = quad.x1 - quad.x0
    const quadH = quad.y1 - quad.y0

    // --- 1. silhouette -> scratchA ---------------------------------------------------
    gl.bindVertexArray(this.silhouetteVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.silhouetteVertices)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(silhouette.positions), gl.STREAM_DRAW)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.silhouetteIndices)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(silhouette.indices), gl.STREAM_DRAW)

    this.beginPass(this.scratchA!, { x: 0, y: 0 }, region, true)
    this.silhouetteProgram.use()
    // Local space -> the region's clip space. The y scale and offset are NEGATED relative to
    // the WebGPU projection: GL puts NDC y = +1 in a texture's LAST row, so without this the
    // shape's top edge would land at the bottom of its slot (see shaders/shadow.glsl.ts).
    gl.uniform2f(this.silhouetteProgram.uniform('u_scale'), 2 / quadW, -(2 / quadH))
    gl.uniform2f(
      this.silhouetteProgram.uniform('u_offset'),
      -1 - (2 * quad.x0) / quadW,
      -(-1 - (2 * quad.y0) / quadH),
    )
    gl.drawElements(gl.TRIANGLES, silhouette.indices.length, gl.UNSIGNED_INT, 0)
    gl.bindVertexArray(null)

    // --- 2. spread, then blur: scratchA -> ... -> the atlas slot ----------------------
    const sigmaTexels = shadowSigma(shape.shadowBlur) * region.texelsPerUnit
    const blurRadius = Math.min(region.padTexels, Math.ceil(3 * sigmaTexels))
    const spreadRadius = Math.round(shape.shadowSpread * region.texelsPerUnit)
    const sourceScaleX = region.width / MAX_REGION
    const sourceScaleY = region.height / MAX_REGION
    const texel = 1 / MAX_REGION
    const ORIGIN = { x: 0, y: 0 }

    let source = this.scratchA!
    let target = this.scratchB!

    const filterPass = (
      program: GlProgram,
      setParams: () => void,
      src: WebGLTexture,
      dst: WebGLTexture,
      viewport: { x: number; y: number },
      clear: boolean,
    ): void => {
      this.beginPass(dst, viewport, region, clear)
      program.use()
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, src)
      gl.uniform1i(program.uniform('u_source'), 0)
      gl.uniform2f(program.uniform('u_sourceScale'), sourceScaleX, sourceScaleY)
      setParams()
      gl.bindVertexArray(this.emptyVao)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindVertexArray(null)
    }

    if (spreadRadius !== 0) {
      const morph = (sx: number, sy: number) => () => {
        gl.uniform2f(this.morphologyProgram.uniform('u_step'), sx, sy)
        gl.uniform1f(this.morphologyProgram.uniform('u_radius'), spreadRadius)
      }
      filterPass(this.morphologyProgram, morph(texel, 0), source, target, ORIGIN, true)
      ;[source, target] = [target, source]
      filterPass(this.morphologyProgram, morph(0, texel), source, target, ORIGIN, true)
      ;[source, target] = [target, source]
    }

    const blur = (sx: number, sy: number) => () => {
      gl.uniform2f(this.blurProgram.uniform('u_step'), sx, sy)
      gl.uniform1f(this.blurProgram.uniform('u_sigma'), Math.max(sigmaTexels, 1e-4))
      gl.uniform1f(this.blurProgram.uniform('u_radius'), blurRadius)
    }
    filterPass(this.blurProgram, blur(texel, 0), source, target, ORIGIN, true)
    ;[source, target] = [target, source]
    // The vertical pass writes straight into the slot, so the atlas is NOT cleared - that
    // would wipe every other shape's baked texture.
    filterPass(this.blurProgram, blur(0, texel), source, this.texture!, { x: rect.x, y: rect.y }, false)

    const size = this.atlasSize
    this.entries.set(shape, {
      rectX: rect.x,
      rectY: rect.y,
      width: region.width,
      height: region.height,
      allocWidth: alloc.width,
      allocHeight: alloc.height,
      geometryVersion: shape.geometryVersion,
      blur: shape.shadowBlur,
      spread: shape.shadowSpread,
      forStroke: shape.shadowForStrokeEnabled,
      u0: rect.x / size,
      v0: rect.y / size,
      u1: (rect.x + region.width) / size,
      v1: (rect.y + region.height) / size,
      x0: quad.x0,
      y0: quad.y0,
      x1: quad.x1,
      y1: quad.y1,
    })
  }

  /**
   * Bind `target` as the colour attachment and clip drawing to the slot.
   *
   * The viewport rectangle is NOT flipped, which is worth being explicit about because half of
   * this file is about flipping. GL's framebuffer row 0 is the texture's row 0, exactly as
   * WebGPU's is, so a slot at texel row `y` is at viewport y `y` on both. What differs is only
   * which NDC y lands in which row INSIDE that rectangle, and that is handled once in the
   * silhouette projection and once in the filter shaders' uv - see shaders/shadow.glsl.ts.
   *
   * Clearing wipes the WHOLE attachment, which is what loadOp: 'clear' does on the other path
   * and is not merely tidiness: a blur tap reads `base +/- delta` and so reaches outside the
   * region, and a scratch texture reused by a previous, larger bake still holds that bake's
   * texels there. Clearing only the region leaves them to bleed in as a rectangular halo
   * around every blurred shadow. The atlas itself is never cleared - it has to keep every
   * other shape's bake - which is why the final pass passes false.
   */
  private beginPass(
    target: WebGLTexture,
    viewport: { x: number; y: number },
    region: ShadowRegion,
    clear: boolean,
  ): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0)
    if (clear) {
      gl.disable(gl.SCISSOR_TEST)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    gl.viewport(viewport.x, viewport.y, region.width, region.height)
  }

  destroy(): void {
    const gl = this.gl
    if (this.texture) gl.deleteTexture(this.texture)
    if (this.scratchA) gl.deleteTexture(this.scratchA)
    if (this.scratchB) gl.deleteTexture(this.scratchB)
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer)
    if (this.emptyVao) gl.deleteVertexArray(this.emptyVao)
    if (this.silhouetteVao) gl.deleteVertexArray(this.silhouetteVao)
    if (this.silhouetteVertices) gl.deleteBuffer(this.silhouetteVertices)
    if (this.silhouetteIndices) gl.deleteBuffer(this.silhouetteIndices)
    this.texture = null
    this.silhouetteProgram.destroy()
    this.blurProgram.destroy()
    this.morphologyProgram.destroy()
  }
}
