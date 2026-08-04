// The FALLBACK MSDF atlas: the four Inter PNGs, paired with the metrics next door.
//
// This is what an application gets when it passes no `fonts` to createSceneRenderer - enough
// for `Text` to draw on the first frame of a project that has not chosen a typeface yet. An
// application that has chosen one supplies MsdfAtlasSource[] of its own and none of this is
// used.
//
// Its own module because the `?url` imports below only resolve under a bundler, which is
// exactly what text/msdfProvider.ts is kept free of so the metrics half stays importable under
// node.
//
// A `?url` import is a STRING, so naming these four costs an application four files in its
// output and no bytes on the wire: nothing fetches them unless a FontBook is built without
// atlases of its own.
//
// The order is STYLE_ORDER's, and that shared index IS the array layer each style occupies.

import { STYLE_JSON, type MsdfAtlasSource } from './msdfProvider'
import interRegularPng from './fonts/inter-regular.png?url'
import interBoldPng from './fonts/inter-bold.png?url'
import interItalicPng from './fonts/inter-italic.png?url'
import interBoldItalicPng from './fonts/inter-bold-italic.png?url'

export type { MsdfAtlasSource } from './msdfProvider'

const PNG_URLS: readonly string[] = [interRegularPng, interBoldPng, interItalicPng, interBoldItalicPng]

export const MSDF_ATLAS_SOURCES: readonly MsdfAtlasSource[] = STYLE_JSON.map((s, i) => ({
  style: s.style,
  url: PNG_URLS[i],
  json: s.json,
}))
