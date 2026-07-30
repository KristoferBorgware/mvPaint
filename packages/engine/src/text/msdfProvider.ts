// The bundled Inter MSDF metrics - and everything derivable from JUST that data, no device, no
// PNG, no texture. Split out from FontAtlas.ts (which adds exactly those three things to turn
// this into something the text lane can actually draw) so this half can be imported under
// node - by the self-test, or by any app code that wants to run the shaper before a device
// exists - without pulling in a `?url` PNG import only a bundler can resolve.

import { normalizeMetrics, type AtlasLayerSize, type MsdfFontJson } from './msdfMetrics'
import type { FontProvider } from './layout'

import interRegularJson from './fonts/inter-regular.json'
import interBoldJson from './fonts/inter-bold.json'
import interItalicJson from './fonts/inter-italic.json'
import interBoldItalicJson from './fonts/inter-bold-italic.json'

export type FontStyle = 'regular' | 'bold' | 'italic' | 'bold-italic'

// Ordered so a style's array index is its stable atlas index (used to segment text draws).
export const STYLE_ORDER: readonly FontStyle[] = ['regular', 'bold', 'italic', 'bold-italic']

export interface StyleJson {
  style: FontStyle
  json: MsdfFontJson
}

export const STYLE_JSON: readonly StyleJson[] = [
  { style: 'regular', json: interRegularJson as unknown as MsdfFontJson },
  { style: 'bold', json: interBoldJson as unknown as MsdfFontJson },
  { style: 'italic', json: interItalicJson as unknown as MsdfFontJson },
  { style: 'bold-italic', json: interBoldItalicJson as unknown as MsdfFontJson },
]

/**
 * The size of one layer of the shared atlas array: big enough for the largest of the four
 * styles, since array layers must all be the same size. Each font's own image is copied into
 * the top-left of its layer and every uv is measured against THIS, not against the individual
 * image (see normalizeMetrics) - which is what lets one texture, and so one draw call, serve
 * regular, bold, italic and bold-italic at once.
 *
 * Derived rather than hard-coded, so regenerating the atlases at different sizes stays correct
 * without anybody having to remember this exists. The packer emits tight bounds per style, and
 * they differ (280x285 through 306x324 at the time of writing); the padding that costs is a
 * few percent of a texture that is under two megabytes.
 */
export const ATLAS_LAYER_SIZE: AtlasLayerSize = {
  width: Math.max(...STYLE_JSON.map((s) => s.json.common.scaleW)),
  height: Math.max(...STYLE_JSON.map((s) => s.json.common.scaleH)),
}

/**
 * The style-fallback ladder shared by FontBook.resolve and msdfFontProvider: try the exact
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
  // All four styles are always present in STYLE_JSON, so index 0 ('regular') always has a value.
  return { value: have(0)!, atlasIndex: 0, fauxBold: wantBold, fauxItalic: wantItalic }
}

let defaultMsdfProvider: FontProvider | null = null

/**
 * A FontProvider over the bundled Inter MSDF metrics - no device, no fetch, no texture, just
 * the same JSON FontBook.load() would eventually feed into its atlases. For running the
 * shaper (layoutText) synchronously wherever a real FontBook isn't available yet - e.g. a
 * scene measuring how tall a paragraph of Text will wrap, to place the next node below it,
 * without waiting on WebGPU initialization to do so. Lazily built and cached on first call.
 */
export function msdfFontProvider(): FontProvider {
  if (!defaultMsdfProvider) {
    const metrics = STYLE_JSON.map((s) => normalizeMetrics(s.json, ATLAS_LAYER_SIZE))
    defaultMsdfProvider = {
      resolve: (style) => {
        const r = resolveStyle(style, (i) => metrics[i])
        return { metrics: r.value, atlasIndex: r.atlasIndex, fauxBold: r.fauxBold, fauxItalic: r.fauxItalic }
      },
    }
  }
  return defaultMsdfProvider
}
