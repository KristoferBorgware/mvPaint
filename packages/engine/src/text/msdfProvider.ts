// The fallback Inter MSDF metrics - and everything derivable from JUST that data, no device, no
// PNG, no texture. Split out from FontAtlas.ts (which adds exactly those three things to turn
// this into something the text lane can actually draw) so this half can be imported under
// node - by the self-test, or by any app code that wants to run the shaper before a device
// exists - without pulling in a `?url` PNG import only a bundler can resolve.
//
// FALLBACK, not the atlas. An application supplies its own through `createSceneRenderer`'s
// `fonts` option (see MsdfAtlasSource below); Inter is what it gets if it supplies none, so
// that `Text` draws something on the first frame of a project that has not thought about fonts
// yet. Everything here that names Inter is therefore prefixed FALLBACK_, and everything that
// does not - the style ladder, the layer-size arithmetic - works on whatever it is handed.

import { normalizeMetrics, type AtlasLayerSize, type FontMetrics, type MsdfFontJson } from './msdfMetrics'
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

/**
 * One style of an MSDF atlas set, as an application supplies it: which style it is, the
 * generated metrics JSON, and a URL the PNG can be fetched from.
 *
 * The JSON is a value rather than a URL because an application's bundler already inlines it
 * (`import metrics from './fonts/inter-regular.json'`) and the shaper wants it synchronously;
 * the image is a URL because it is a quarter of a megabyte that should stay out of the JS.
 * `packages/scripts` writes exactly this pair per style.
 */
export interface MsdfAtlasSource extends StyleJson {
  /** Where the PNG is served from - typically a bundler's `?url` import of it. */
  url: string
}

/** The fallback set's metrics. Inter, in STYLE_ORDER. */
export const STYLE_JSON: readonly StyleJson[] = [
  { style: 'regular', json: interRegularJson as unknown as MsdfFontJson },
  { style: 'bold', json: interBoldJson as unknown as MsdfFontJson },
  { style: 'italic', json: interItalicJson as unknown as MsdfFontJson },
  { style: 'bold-italic', json: interBoldItalicJson as unknown as MsdfFontJson },
]

/**
 * The size of one layer of a shared atlas array: big enough for the largest style in the set,
 * since array layers must all be the same size. Each font's own image is copied into the
 * top-left of its layer and every uv is measured against THIS, not against the individual
 * image (see normalizeMetrics) - which is what lets one texture, and so one draw call, serve
 * regular, bold, italic and bold-italic at once.
 *
 * Computed from the set rather than hard-coded, so an application's atlases - packed at
 * whatever size its charset needed - are as correct here as the bundled ones. The packer emits
 * tight bounds per style and they differ (280x285 through 306x324 for Inter at the time of
 * writing); the padding that costs is a few percent of a texture under two megabytes.
 */
export function atlasLayerSize(styles: readonly StyleJson[]): AtlasLayerSize {
  return {
    width: Math.max(...styles.map((s) => s.json.common.scaleW)),
    height: Math.max(...styles.map((s) => s.json.common.scaleH)),
  }
}

/** The fallback set's layer size. An application-supplied set computes its own. */
export const ATLAS_LAYER_SIZE: AtlasLayerSize = atlasLayerSize(STYLE_JSON)

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

let defaultMsdfProvider: FontProvider | null = null

/**
 * A FontProvider over MSDF metrics alone - no device, no fetch, no texture, just the same JSON
 * a FontBook would eventually feed into its atlases. For running the shaper (layoutText)
 * synchronously wherever a real FontBook isn't available yet - e.g. a scene measuring how tall
 * a paragraph of Text will wrap, to place the next node below it, without waiting on WebGPU
 * initialization to do so.
 *
 * Called with no argument it measures against the bundled Inter fallback, which is right for an
 * application that draws with it. Pass your own styles to measure against the atlases you will
 * actually render with - the numbers differ, and text laid out against the wrong metrics wraps
 * in the wrong place. The no-argument case is cached; a supplied set builds a fresh provider,
 * since the caller holds it for as long as it is useful.
 */
export function msdfFontProvider(styles?: readonly StyleJson[]): FontProvider {
  if (styles) return providerOver(styles)
  defaultMsdfProvider ??= providerOver(STYLE_JSON)
  return defaultMsdfProvider
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
