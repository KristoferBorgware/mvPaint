// FontAtlas / FontBook - runtime ownership of the MSDF atlases. Each FontAtlas holds one
// style's GPU texture, its group(2) bind group, and its normalized metrics; FontBook loads
// all four Inter styles, owns the shared sampler + atlas bind-group layout, and maps a style
// (and a stable atlas index, used by the batcher to segment draws) to its FontAtlas. Atlases
// are loaded asynchronously (fetch the PNG -> ImageBitmap -> texture) before the text lane
// draws; the metrics JSON is bundled, so only the PNG is fetched.

import { createAtlasBindGroupLayout } from '../render/layouts'
import { normalizeMetrics, type FontMetrics, type MsdfFontJson } from './msdfMetrics'

import interRegularPng from './fonts/inter-regular.png?url'
import interBoldPng from './fonts/inter-bold.png?url'
import interItalicPng from './fonts/inter-italic.png?url'
import interBoldItalicPng from './fonts/inter-bold-italic.png?url'
import interRegularJson from './fonts/inter-regular.json'
import interBoldJson from './fonts/inter-bold.json'
import interItalicJson from './fonts/inter-italic.json'
import interBoldItalicJson from './fonts/inter-bold-italic.json'

export type FontStyle = 'regular' | 'bold' | 'italic' | 'bold-italic'

// Ordered so a style's array index is its stable atlas index (used to segment text draws).
const STYLE_ORDER: readonly FontStyle[] = ['regular', 'bold', 'italic', 'bold-italic']

interface StyleSource {
  style: FontStyle
  url: string
  json: MsdfFontJson
}

const SOURCES: readonly StyleSource[] = [
  { style: 'regular', url: interRegularPng, json: interRegularJson as unknown as MsdfFontJson },
  { style: 'bold', url: interBoldPng, json: interBoldJson as unknown as MsdfFontJson },
  { style: 'italic', url: interItalicPng, json: interItalicJson as unknown as MsdfFontJson },
  { style: 'bold-italic', url: interBoldItalicPng, json: interBoldItalicJson as unknown as MsdfFontJson },
]

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
