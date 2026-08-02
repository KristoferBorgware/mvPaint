// The browser-side loader for the vector text path: fetch the four bundled Inter polygon
// atlases and build a PolygonFontBook from them. Kept apart from PolygonFont.ts so that module
// stays free of bundler asset imports and can be exercised under node by the self-tests.
//
// Loading is lazy and memoized rather than done at startup like the MSDF atlases, because
// these files are the whole cost of this path and an app that only ever draws MSDF text should
// never pay for them. The `?url` imports keep them out of the JS bundle - they resolve to asset
// URLs, so the files are only fetched when this function is actually called.
//
// This used to fetch the four Inter TTFs (1.6 MB) and parse them with opentype.js (another
// quarter of a megabyte, in the main chunk). The atlases are a fraction of that and need no
// parser at all - see PolygonFont.ts.

import { PolygonFontBook, type PolygonFontJson, type PolygonFontSource } from './PolygonFont'
import type { FontStyle } from './msdfProvider'

import interRegularPolygons from './fonts/inter-regular.polygons.json?url'
import interBoldPolygons from './fonts/inter-bold.polygons.json?url'
import interItalicPolygons from './fonts/inter-italic.polygons.json?url'
import interBoldItalicPolygons from './fonts/inter-bold-italic.polygons.json?url'

const URLS: readonly { style: FontStyle; url: string }[] = [
  { style: 'regular', url: interRegularPolygons },
  { style: 'bold', url: interBoldPolygons },
  { style: 'italic', url: interItalicPolygons },
  { style: 'bold-italic', url: interBoldItalicPolygons },
]

let pending: Promise<PolygonFontBook> | null = null

/**
 * Fetch the bundled Inter polygon atlases into a PolygonFontBook - the outlines VectorText
 * draws from.
 *
 * Memoized on the promise, not the result, so concurrent callers (two scenes loading at once,
 * say) share one set of fetches instead of racing.
 */
export function loadDefaultVectorFonts(): Promise<PolygonFontBook> {
  if (!pending) {
    pending = Promise.all(
      URLS.map(async ({ style, url }): Promise<PolygonFontSource> => {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Failed to load the ${style} glyph atlas (${response.status})`)
        return { style, json: (await response.json()) as PolygonFontJson }
      }),
    )
      .then((sources) => new PolygonFontBook(sources))
      .catch((error: unknown) => {
        // Don't cache a failure - a transient network error shouldn't disable the vector text
        // path for the rest of the session.
        pending = null
        throw error
      })
  }
  return pending
}
