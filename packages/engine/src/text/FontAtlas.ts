// FontAtlas / FontBook - runtime ownership of the MSDF atlases. Each FontAtlas holds one
// style's GPU texture, its group(2) bind group, and its normalized metrics; FontBook loads
// all four Inter styles, owns the shared sampler + atlas bind-group layout, and maps a style
// (and a stable atlas index, used by the batcher to segment draws) to its FontAtlas. Atlases
// are loaded asynchronously (fetch the PNG -> ImageBitmap -> texture) before the text lane
// draws; the metrics JSON is bundled, so only the PNG is fetched.
//
// The metrics-only half of this - the JSON, the style-fallback ladder, and msdfFontProvider()
// (a FontProvider needing no device at all) - lives in msdfProvider.ts, re-exported below.
// It's a separate module specifically so it stays importable under node (no `?url` PNG import
// only a bundler can resolve), which is what lets the self-test - and any app code that wants
// to measure text before a device exists - reach it directly.

import { createAtlasBindGroupLayout } from '../render/layouts'
import { normalizeMetrics, type FontMetrics, type MsdfFontJson } from './msdfMetrics'
import { resolveStyle, STYLE_JSON, STYLE_ORDER, type FontStyle } from './msdfProvider'

export type { FontStyle } from './msdfProvider'
export { msdfFontProvider } from './msdfProvider'

import interRegularPng from './fonts/inter-regular.png?url'
import interBoldPng from './fonts/inter-bold.png?url'
import interItalicPng from './fonts/inter-italic.png?url'
import interBoldItalicPng from './fonts/inter-bold-italic.png?url'

interface StyleSource {
  style: FontStyle
  url: string
  json: MsdfFontJson
}

const PNG_URLS: readonly string[] = [interRegularPng, interBoldPng, interItalicPng, interBoldItalicPng]
// PNG_URLS is ordered to match STYLE_JSON (both list the four styles in STYLE_ORDER), so
// zipping them index-for-index pairs each style with its own atlas image.
const SOURCES: readonly StyleSource[] = STYLE_JSON.map((s, i) => ({ style: s.style, url: PNG_URLS[i], json: s.json }))

export class FontAtlas {
  readonly metrics: FontMetrics
  readonly bindGroup: GPUBindGroup
  private readonly texture: GPUTexture

  private constructor(metrics: FontMetrics, texture: GPUTexture, bindGroup: GPUBindGroup) {
    this.metrics = metrics
    this.texture = texture
    this.bindGroup = bindGroup
  }

  static async create(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    sampler: GPUSampler,
    url: string,
    json: MsdfFontJson,
  ): Promise<FontAtlas> {
    const response = await fetch(url)
    const blob = await response.blob()
    // colorSpaceConversion 'none': MSDF channels are distances, not sRGB color - keep raw.
    const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' })

    const texture = device.createTexture({
      label: `atlas:${json.info.face}`,
      size: [bitmap.width, bitmap.height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height])
    bitmap.close()

    const bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: sampler },
      ],
    })
    return new FontAtlas(normalizeMetrics(json), texture, bindGroup)
  }

  destroy(): void {
    this.texture.destroy()
  }
}

export class FontBook {
  /** group(2) layout for the atlas texture+sampler, reused by the text pipeline. */
  readonly atlasLayout: GPUBindGroupLayout

  private readonly atlases: FontAtlas[] // indexed by STYLE_ORDER

  private constructor(atlasLayout: GPUBindGroupLayout, atlases: FontAtlas[]) {
    this.atlasLayout = atlasLayout
    this.atlases = atlases
  }

  /** Load all four Inter styles: create the shared sampler + layout, then every atlas. */
  static async load(device: GPUDevice): Promise<FontBook> {
    const atlasLayout = createAtlasBindGroupLayout(device)
    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    const atlases = await Promise.all(
      SOURCES.map((s) => FontAtlas.create(device, atlasLayout, sampler, s.url, s.json)),
    )
    return new FontBook(atlasLayout, atlases)
  }

  /** Stable atlas index for a style (its position in the draw-segmentation order). */
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
    const r = resolveStyle(style, (i) => this.atlases[i]?.metrics)
    return { metrics: r.value, atlasIndex: r.atlasIndex, fauxBold: r.fauxBold, fauxItalic: r.fauxItalic }
  }

  atlas(style: FontStyle): FontAtlas {
    return this.atlases[this.indexOf(style)]
  }

  atlasByIndex(index: number): FontAtlas {
    return this.atlases[index]
  }

  destroy(): void {
    for (const atlas of this.atlases) atlas.destroy()
  }
}
