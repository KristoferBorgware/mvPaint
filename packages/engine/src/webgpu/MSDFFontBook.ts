// MSDFFontBook - runtime ownership of the MSDF atlases. All four styles live in ONE
// texture_2d_array, one style per layer, behind ONE group(2) bind group; a glyph picks its
// layer from its object record (see render/textFormat.ts). That is what lets a paragraph
// mixing regular, bold, italic and bold-italic draw in a single call: the text lane used to
// segment its draws by atlas, so text that alternated styles paid a bind and a draw per
// switch - 108 draws for four pages of mixed-style lorem ipsum, against 4 distinct atlases.
//
// WHOSE ATLASES. The application's: `load()` takes MsdfAtlasSource[], which is what
// createSceneRenderer's `fonts` option carries down. Given none, it loads none - a renderer
// created without `fonts` draws no text until setMSDFFonts() is called. A set may be partial -
// one face, or three - and the style ladder synthesizes the rest.
//
// Array layers must all be the same size, and the generator packs each style to its own tight
// bounds, so every image is copied into the TOP-LEFT of a layer sized for the largest of them
// (atlasLayerSize) and the remainder is left transparent. Uvs are measured against the layer
// rather than the image, which normalizeMetrics does; nothing else has to know. The waste is a
// few percent of a texture under two megabytes.
//
// Atlases are prepared BEFORE the text lane draws - PNG bytes -> ImageBitmap -> one layer of
// the texture - inside createSceneRenderer or setMSDFFonts, both of which the application
// awaits. Nothing here is reachable from a frame: drawing binds a bind group that already
// exists. The bytes come from the global resource cache and the metrics arrive as a value, so
// this module fetches nothing itself.
//
// The metrics-only half of this - the style-fallback ladder, atlasLayerSize, and
// msdfFontProvider() (a FontProvider needing no device at all) - lives in msdfProvider.ts,
// re-exported below. It's a separate module specifically so it stays importable under node,
// which is what lets the self-test - and any app code that wants to measure text before a
// device exists - reach it directly.

import { createAtlasBindGroupLayout } from './layouts'
import { normalizeMetrics, type FontMetrics } from '../text/msdfMetrics'
import { sharedAtlasBytes } from '../resources/fontSources'
import {
  atlasLayerSize,
  resolveStyle,
  STYLE_ORDER,
  type FontStyle,
  type MsdfAtlasSource,
} from '../text/msdfProvider'

import { bumpFontEpoch, bumpTextShapingEpoch } from '../shapes/contentEpoch'

export type { FontStyle, MsdfAtlasSource } from '../text/msdfProvider'
export { msdfFontProvider, atlasLayerSize } from '../text/msdfProvider'

export class MSDFFontBook {
  /**
   * group(2) layout for the atlas array + sampler, reused by the text pipeline.
   *
   * Stable for the life of the book, which is what lets setMSDFFonts() swap the atlases without
   * touching a pipeline: the layout describes the SHAPE of the binding - an array texture and
   * a sampler - and every atlas set has that shape whatever size or how many styles it holds.
   */
  readonly atlasLayout: GPUBindGroupLayout
  /** The one bind group for every style - bound once per text draw, never per style. */
  bindGroup: GPUBindGroup

  private readonly device: GPUDevice
  private readonly sampler: GPUSampler
  private texture: GPUTexture
  private metrics: FontMetrics[] // indexed by STYLE_ORDER, i.e. by array layer
  private atlases: readonly MsdfAtlasSource[]

  private constructor(
    device: GPUDevice,
    atlasLayout: GPUBindGroupLayout,
    sampler: GPUSampler,
    bindGroup: GPUBindGroup,
    texture: GPUTexture,
    metrics: FontMetrics[],
    atlases: readonly MsdfAtlasSource[],
  ) {
    this.device = device
    this.atlasLayout = atlasLayout
    this.sampler = sampler
    this.bindGroup = bindGroup
    this.texture = texture
    this.metrics = metrics
    this.atlases = atlases
  }

  /** The atlases currently loaded, in the order they were supplied. */
  get sources(): readonly MsdfAtlasSource[] {
    return this.atlases
  }

  /**
   * Load a set of atlases into one array texture, each style at its STYLE_ORDER layer.
   *
   * A partial set is allowed: unnamed layers stay zeroed and unresolvable, and the style ladder
   * falls back onto what is there. `sources` omitted, or empty, is the far end of that - a book
   * with no atlases, which fetches nothing and draws no text until setMSDFFonts() supplies some.
   * That is what a renderer created without the `fonts` option holds.
   */
  static async load(device: GPUDevice, sources?: readonly MsdfAtlasSource[]): Promise<MSDFFontBook> {
    return MSDFFontBook.loadWith(device, createAtlasBindGroupLayout(device, '2d-array'), createMSDFAtlasSampler(device), sources)
  }

  /**
   * Load against a layout and sampler somebody else owns - what MSDFFontLibrary does for every
   * family it holds.
   *
   * The layout in particular has to be SHARED: the text pipeline is built from one, and a bind
   * group is only usable with the pipeline whose layout it was made against. Creating a
   * structurally identical layout per family would rely on group-equivalence rather than the
   * thing the spec plainly guarantees.
   */
  static async loadWith(
    device: GPUDevice,
    atlasLayout: GPUBindGroupLayout,
    sampler: GPUSampler,
    sources?: readonly MsdfAtlasSource[],
  ): Promise<MSDFFontBook> {
    const atlases = sources ?? []
    const built = await buildAtlas(device, atlasLayout, sampler, atlases)
    return new MSDFFontBook(device, atlasLayout, sampler, built.bindGroup, built.texture, built.metrics, atlases)
  }

  /**
   * Replace the atlases, at any point after the renderer exists.
   *
   * This is the runtime half of the `fonts` option: fetch a set from wherever it lives - a CDN,
   * a user's upload, a document that names its own typeface - and hand it over. Metrics change,
   * so every cached text layout is dropped (the font epoch) and the text lane repacks (the text
   * shaping epoch); the pipelines are untouched, since only the texture behind a stable bind
   * group layout has changed.
   *
   * REPLACES, it does not merge. The set you pass is the set the renderer has, so an
   * application never ends up drawing half its own typeface and half the fallback without
   * having asked for it. To add a style, spread what is already there:
   *
   *   await handle.setMSDFFonts([...handle.getMSDFFonts(), { style: 'italic', url, json }])
   *
   * Rebuilding the whole texture rather than patching layers is deliberate: a new set can want
   * a different layer size, and a style dropped from the set has to stop resolving rather than
   * linger in a layer nobody overwrote. The images come back from the resource cache rather than
   * the network, and this is a rare call - not something a frame does.
   *
   * The swap is atomic: if a fetch fails, the exception propagates and the book still holds the
   * atlases it had, rather than being left half-replaced with text that cannot draw.
   */
  async setMSDFFonts(sources: readonly MsdfAtlasSource[]): Promise<void> {
    const built = await buildAtlas(this.device, this.atlasLayout, this.sampler, sources)
    this.texture.destroy()
    this.texture = built.texture
    this.bindGroup = built.bindGroup
    this.metrics = built.metrics
    this.atlases = sources
    bumpFontEpoch()
    bumpTextShapingEpoch()
  }

  /** Stable atlas index for a style - its array layer in the shared texture. */
  indexOf(style: FontStyle): number {
    return STYLE_ORDER.indexOf(style)
  }

  /**
   * Resolve a requested style to a loaded atlas, synthesizing what is missing. When the exact
   * style is present it is used as-is; otherwise the nearest available atlas is chosen and the
   * missing weight/slant is flagged for synthesis (faux bold via distance dilation, faux italic
   * via shear). With all four styles loaded this always returns the real atlas.
   */
  resolve(style: FontStyle): { metrics: FontMetrics; atlasIndex: number; fauxBold: boolean; fauxItalic: boolean } {
    const r = resolveStyle(style, (i) => this.metrics[i])
    return { metrics: r.value, atlasIndex: r.atlasIndex, fauxBold: r.fauxBold, fauxItalic: r.fauxItalic }
  }

  destroy(): void {
    this.texture.destroy()
  }
}

/** The sampler every atlas is read through - linear, clamped, one per library. */
export function createMSDFAtlasSampler(device: GPUDevice): GPUSampler {
  return device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  })
}

/**
 * One atlas set -> a texture, a bind group over it, and the metrics indexed by array layer.
 *
 * Shared by load() and setMSDFFonts() so a book built at startup and one replaced at runtime cannot
 * differ. Nothing is assigned to the book here: the caller swaps the result in once every fetch
 * has succeeded, which is what makes a failed replacement leave the old atlases in place.
 */
async function buildAtlas(
  device: GPUDevice,
  atlasLayout: GPUBindGroupLayout,
  sampler: GPUSampler,
  atlases: readonly MsdfAtlasSource[],
): Promise<{ texture: GPUTexture; bindGroup: GPUBindGroup; metrics: FontMetrics[] }> {
  // An empty set means no atlases. The texture below is created either way - the text
  // pipeline's bind group needs one - but at the 1x1 atlasLayerSize gives for an empty set,
  // with nothing fetched into it and no metrics behind it, so every style is unresolvable and
  // MSDFText draws nothing until setMSDFFonts() is called.
  const layerSize = atlasLayerSize(atlases)

  const texture = device.createTexture({
    label: 'atlas:msdf',
    // Always STYLE_ORDER.length layers, however many styles were supplied: a style's layer is
    // its STYLE_ORDER index, which is what a shaped quad's `atlasLayer` names, so the layers
    // cannot be packed tight against a partial set without renumbering that.
    size: [layerSize.width, layerSize.height, STYLE_ORDER.length],
    format: 'rgba8unorm',
    // RENDER_ATTACHMENT is not optional here despite nothing ever rendering into the atlas:
    // copyExternalImageToTexture requires COPY_DST | RENDER_ATTACHMENT on its destination.
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  })

  try {
    // Fetched in parallel, copied in layer order. A layer's untouched remainder stays at the
    // zero WebGPU guarantees, which the shader reads as "fully outside the glyph" - the same
    // answer the field's outer plateau gives, so a linear tap straying off the packed image at
    // its far edge biases a glyph's outermost half-texel toward transparent and nothing worse.
    await Promise.all(
      atlases.map(async (source) => {
        const layer = STYLE_ORDER.indexOf(source.style)
        if (layer < 0) throw new Error(`MSDFFontBook: '${source.style}' is not one of ${STYLE_ORDER.join(', ')}.`)
        // The bytes come from the global cache, so the same address is fetched once however
        // often a family is built - a book replaced with the set it already had, or a renderer
        // rebuilt after a remount, does no round trip. Decoding and uploading stay here: both
        // need a device, and the decoded form is far larger than the PNG it came from.
        const blob = await sharedAtlasBytes(source.url)
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
  } catch (cause) {
    // A replacement that fails leaves the book on its old atlases, so this texture has no
    // owner and nothing would ever destroy it.
    texture.destroy()
    throw cause
  }

  const bindGroup = device.createBindGroup({
    label: 'atlas:msdf',
    layout: atlasLayout,
    entries: [
      { binding: 0, resource: texture.createView({ dimension: '2d-array' }) },
      { binding: 1, resource: sampler },
    ],
  })

  // Sparse by STYLE_ORDER index, matching the layers above - a style that was not supplied
  // reads back undefined, which is exactly what resolveStyle treats as "not loaded".
  const metrics: FontMetrics[] = []
  for (const source of atlases) metrics[STYLE_ORDER.indexOf(source.style)] = normalizeMetrics(source.json, layerSize)
  return { texture, bindGroup, metrics }
}
