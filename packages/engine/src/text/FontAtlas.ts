// FontBook - runtime ownership of the MSDF atlases. All four Inter styles live in ONE
// texture_2d_array, one style per layer, behind ONE group(2) bind group; a glyph picks its
// layer from its object record (see render/textFormat.ts). That is what lets a paragraph
// mixing regular, bold, italic and bold-italic draw in a single call: the text lane used to
// segment its draws by atlas, so text that alternated styles paid a bind and a draw per
// switch - 108 draws for four pages of mixed-style lorem ipsum, against 4 distinct atlases.
//
// Array layers must all be the same size, and the generator packs each style to its own tight
// bounds, so every image is copied into the TOP-LEFT of a layer sized for the largest of them
// (ATLAS_LAYER_SIZE) and the remainder is left transparent. Uvs are measured against the layer
// rather than the image, which normalizeMetrics does; nothing else has to know. The waste is a
// few percent of a texture under two megabytes.
//
// Atlases load asynchronously (fetch the PNG -> ImageBitmap -> one layer of the texture)
// before the text lane draws; the metrics JSON is bundled, so only the PNG is fetched.
//
// The metrics-only half of this - the JSON, the style-fallback ladder, ATLAS_LAYER_SIZE, and
// msdfFontProvider() (a FontProvider needing no device at all) - lives in msdfProvider.ts,
// re-exported below. It's a separate module specifically so it stays importable under node (no
// `?url` PNG import only a bundler can resolve), which is what lets the self-test - and any app
// code that wants to measure text before a device exists - reach it directly.

import { createAtlasBindGroupLayout } from '../render/layouts'
import { normalizeMetrics, type FontMetrics } from './msdfMetrics'
import { ATLAS_LAYER_SIZE, resolveStyle, STYLE_ORDER, type FontStyle } from './msdfProvider'

export type { FontStyle } from './msdfProvider'
export { msdfFontProvider, ATLAS_LAYER_SIZE } from './msdfProvider'

import { MSDF_ATLAS_SOURCES as SOURCES } from './msdfAtlasImages'

export class FontBook {
  /** group(2) layout for the atlas array + sampler, reused by the text pipeline. */
  readonly atlasLayout: GPUBindGroupLayout
  /** The one bind group for every style - bound once per text draw, never per style. */
  readonly bindGroup: GPUBindGroup

  private readonly texture: GPUTexture
  private readonly metrics: FontMetrics[] // indexed by STYLE_ORDER, i.e. by array layer

  private constructor(
    atlasLayout: GPUBindGroupLayout,
    bindGroup: GPUBindGroup,
    texture: GPUTexture,
    metrics: FontMetrics[],
  ) {
    this.atlasLayout = atlasLayout
    this.bindGroup = bindGroup
    this.texture = texture
    this.metrics = metrics
  }

  /** Load all four Inter styles into one array texture, one layer each. */
  static async load(device: GPUDevice): Promise<FontBook> {
    const atlasLayout = createAtlasBindGroupLayout(device, '2d-array')
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })

    const texture = device.createTexture({
      label: 'atlas:inter',
      size: [ATLAS_LAYER_SIZE.width, ATLAS_LAYER_SIZE.height, SOURCES.length],
      format: 'rgba8unorm',
      // RENDER_ATTACHMENT is not optional here despite nothing ever rendering into the atlas:
      // copyExternalImageToTexture requires COPY_DST | RENDER_ATTACHMENT on its destination.
      usage:
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })

    // Fetched in parallel, copied in layer order. A layer's untouched remainder stays at the
    // zero WebGPU guarantees, which the shader reads as "fully outside the glyph" - the same
    // answer the field's outer plateau gives, so a linear tap straying off the packed image at
    // its far edge biases a glyph's outermost half-texel toward transparent and nothing worse.
    await Promise.all(
      SOURCES.map(async (source, layer) => {
        const response = await fetch(source.url)
        const blob = await response.blob()
        // colorSpaceConversion 'none': MSDF channels are distances, not sRGB color - keep raw.
        const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' })
        device.queue.copyExternalImageToTexture(
          { source: bitmap },
          { texture, origin: { x: 0, y: 0, z: layer } },
          [bitmap.width, bitmap.height],
        )
        bitmap.close()
      }),
    )

    const bindGroup = device.createBindGroup({
      label: 'atlas:inter',
      layout: atlasLayout,
      entries: [
        { binding: 0, resource: texture.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: sampler },
      ],
    })

    const metrics = SOURCES.map((s) => normalizeMetrics(s.json, ATLAS_LAYER_SIZE))
    return new FontBook(atlasLayout, bindGroup, texture, metrics)
  }

  /** Stable atlas index for a style - its array layer in the shared texture. */
  indexOf(style: FontStyle): number {
    return STYLE_ORDER.indexOf(style)
  }

  /**
   * Resolve a requested style to a loaded atlas, synthesizing what is missing. When the exact
   * style is present it is used as-is; otherwise the nearest available atlas is chosen and the
   * missing weight/slant is flagged for synthesis (faux bold via distance dilation, faux italic
   * via shear). With all four Inter styles loaded this always returns the real atlas.
   */
  resolve(style: FontStyle): { metrics: FontMetrics; atlasIndex: number; fauxBold: boolean; fauxItalic: boolean } {
    const r = resolveStyle(style, (i) => this.metrics[i])
    return { metrics: r.value, atlasIndex: r.atlasIndex, fauxBold: r.fauxBold, fauxItalic: r.fauxItalic }
  }

  destroy(): void {
    this.texture.destroy()
  }
}
