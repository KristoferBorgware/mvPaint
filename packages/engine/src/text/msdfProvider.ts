// MSDF metrics arithmetic: everything derivable from a set of atlas JSON and nothing else - no
// device, no PNG, no texture. Split out from FontAtlas.ts (which adds exactly those three
// things to turn this into something the text lane can actually draw) so this half can be
// imported under node, by the self-test or by any app code that wants to run the shaper before
// a device exists.
//
// THE ENGINE SHIPS NO FONT. Every function here works on whatever set it is handed and names
// no typeface: an atlas is an application's asset, in the same way glyph outlines are (see
// PolygonFont.ts). A renderer starts with no atlases at all and draws no text until a family is
// registered under the name a node asks for, so a consumer's bundle carries only the typeface that
// consumer chose. This repository's Inter set lives with the example app, under
// packages/example-app/public/fonts/, and reaches the engine through `fonts` like any other.

import { normalizeMetrics, type AtlasLayerSize, type FontMetrics, type MsdfFontJson } from './msdfMetrics'
import type { FontProvider } from './layout'

export type FontStyle = 'regular' | 'bold' | 'italic' | 'bold-italic'

// Ordered so a style's array index is its stable atlas index (used to segment text draws).
export const STYLE_ORDER: readonly FontStyle[] = ['regular', 'bold', 'italic', 'bold-italic']

export interface StyleJson {
  style: FontStyle
  json: MsdfFontJson
}

/**
 * One style of an MSDF atlas set, as an application supplies it: which style it is, the
 * generated metrics JSON, and a URL the PNG can be fetched from.
 *
 * The JSON is a value rather than a URL because the shaper wants it synchronously - however
 * the application got hold of it, by bundling the document or by fetching it before creating
 * the renderer; the image is a URL because it is a quarter of a megabyte that should stay out
 * of the JS. `packages/scripts` writes exactly this pair per style.
 */
export interface MsdfAtlasSource extends StyleJson {
  /** Where the PNG is served from - a static path, a CDN, or a bundler's `?url` import. */
  url: string
}

/**
 * The size of one layer of a shared atlas array: big enough for the largest style in the set,
 * since array layers must all be the same size. Each font's own image is copied into the
 * top-left of its layer and every uv is measured against THIS, not against the individual
 * image (see normalizeMetrics) - which is what lets one texture, and so one draw call, serve
 * regular, bold, italic and bold-italic at once.
 *
 * Computed from the set rather than hard-coded, so an application's atlases - packed at
 * whatever size its charset needed - come out right whatever they are. The packer emits tight
 * bounds per style and they differ (280x285 through 306x324 for Inter at the time of writing);
 * the padding that leaves is a few percent of a texture under two megabytes.
 *
 * An EMPTY set is 1x1. That is the no-atlases case - a renderer created without the `fonts`
 * option - and the size the placeholder texture behind it is allocated at: the text lane binds
 * a texture unconditionally, and one texel it never samples is the smallest thing that
 * satisfies it.
 */
export function atlasLayerSize(styles: readonly StyleJson[]): AtlasLayerSize {
  if (styles.length === 0) return { width: 1, height: 1 }
  return {
    width: Math.max(...styles.map((s) => s.json.common.scaleW)),
    height: Math.max(...styles.map((s) => s.json.common.scaleH)),
  }
}

/**
 * How many mip levels a layer of this size holds, down to the 1x1 one.
 *
 * The atlas is mipped because a glyph drawn smaller than the atlas packed it is a MINIFICATION,
 * and one tap of a full-resolution distance field per screen pixel picks an arbitrary point out
 * of a field that varies across the whole footprint - so a line of small text shimmers as the
 * camera moves, each glyph landing on different texels frame to frame. A mip chain averages the
 * footprint instead.
 *
 * Averaging a distance field is not the field of the averaged shape, so the deep levels are mush.
 * They are never reached: the text shader fades a glyph out as it approaches one screen pixel per
 * field width (see the text shaders), which is the first two or three levels of this chain.
 *
 * Both paths compute it here rather than each deriving its own, since a level count that differs
 * from the number of levels actually filled leaves a sampler reading undefined texels.
 */
export function atlasMipLevels(size: AtlasLayerSize): number {
  return Math.floor(Math.log2(Math.max(size.width, size.height))) + 1
}

/**
 * The style-fallback ladder shared by MSDFFontBook.resolve and msdfFontProvider: try the exact
 * style, then the nearest one that keeps whichever of bold/italic was asked for, then plain
 * regular - flagging whatever had to be synthesized along the way. `have` looks up a style's
 * value by its STYLE_ORDER index (a loaded FontAtlas's metrics, or a bare FontMetrics), and is
 * the only thing that differs between the two callers.
 */
export function resolveStyle<T>(
  style: FontStyle,
  have: (index: number) => T | undefined,
): { value: T; atlasIndex: number; fauxBold: boolean; fauxItalic: boolean } {
  const wantBold = style.includes('bold')
  const wantItalic = style.includes('italic')
  const candidates: FontStyle[] = [style, wantItalic ? 'italic' : 'regular', wantBold ? 'bold' : 'regular', 'regular']
  for (const candidate of candidates) {
    const index = STYLE_ORDER.indexOf(candidate)
    const value = index >= 0 ? have(index) : undefined
    if (value !== undefined) {
      return {
        value,
        atlasIndex: index,
        fauxBold: wantBold && !candidate.includes('bold'),
        fauxItalic: wantItalic && !candidate.includes('italic'),
      }
    }
  }
  // Nothing on the ladder is loaded, which an application-supplied set can easily produce - a
  // single bold face and a request for regular walks candidates that are all missing. Take the
  // first style there IS and synthesize from it, rather than indexing 'regular' and handing back
  // an undefined the caller will dereference. Only a completely empty set can get past this,
  // and both font books reject one at load.
  for (let index = 0; index < STYLE_ORDER.length; index++) {
    const value = have(index)
    if (value !== undefined) {
      const candidate = STYLE_ORDER[index]
      return {
        value,
        atlasIndex: index,
        fauxBold: wantBold && !candidate.includes('bold'),
        fauxItalic: wantItalic && !candidate.includes('italic'),
      }
    }
  }
  throw new Error('No font atlas is loaded for any style.')
}

/**
 * A FontProvider over MSDF metrics alone - no device, no fetch, no texture, just the same JSON
 * an MSDFFontBook would eventually feed into its atlases. For running the shaper (layoutText)
 * synchronously wherever a real MSDFFontBook isn't available yet - e.g. a scene measuring how tall
 * a paragraph of MSDFText will wrap, to place the next node below it, without waiting on WebGPU
 * initialization to do so.
 *
 * `styles` must be the set you render with. Metrics differ between atlases, and a layout is
 * only valid against the one it was measured with.
 *
 * The result is not cached. Building it is one normalizeMetrics per style, and the caller holds
 * it for as long as it is useful - the only scope that knows when the atlases behind it have
 * been replaced.
 */
export function msdfFontProvider(styles: readonly StyleJson[]): FontProvider {
  return providerOver(styles)
}

function providerOver(styles: readonly StyleJson[]): FontProvider {
  const layer = atlasLayerSize(styles)
  // Indexed by STYLE_ORDER position, not by position in `styles`, because that index IS the
  // atlas layer a shaped quad names - so a set given as [bold] must leave index 0 empty.
  const metrics: (FontMetrics | undefined)[] = []
  for (const style of styles) metrics[STYLE_ORDER.indexOf(style.style)] = normalizeMetrics(style.json, layer)
  return {
    resolve: (style) => {
      const r = resolveStyle(style, (i) => metrics[i])
      return { metrics: r.value, atlasIndex: r.atlasIndex, fauxBold: r.fauxBold, fauxItalic: r.fauxItalic }
    },
  }
}
