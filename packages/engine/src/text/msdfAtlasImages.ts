// Where the four MSDF atlas PNGs are, in the order their styles occupy layers.
//
// Its own module because the `?url` imports below only resolve under a bundler, which is
// exactly what text/msdfProvider.ts is kept free of so the metrics half stays importable under
// node. This is the other half: the images, wanted by every render path that actually draws
// text, and by nothing that only measures it.
//
// The order is STYLE_ORDER's, and that shared index IS the array layer each style occupies.

import { STYLE_JSON } from './msdfProvider'
import type { MsdfFontJson } from './msdfMetrics'
import interRegularPng from './fonts/inter-regular.png?url'
import interBoldPng from './fonts/inter-bold.png?url'
import interItalicPng from './fonts/inter-italic.png?url'
import interBoldItalicPng from './fonts/inter-bold-italic.png?url'

const PNG_URLS: readonly string[] = [interRegularPng, interBoldPng, interItalicPng, interBoldItalicPng]

export interface MsdfAtlasSource {
  style: (typeof STYLE_JSON)[number]['style']
  url: string
  json: MsdfFontJson
}

export const MSDF_ATLAS_SOURCES: readonly MsdfAtlasSource[] = STYLE_JSON.map((s, i) => ({
  style: s.style,
  url: PNG_URLS[i],
  json: s.json,
}))
