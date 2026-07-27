// The browser-side loader for the vector text path: fetch the four bundled Inter TTFs and
// hand their buffers to VectorFontBook. Kept apart from VectorFont.ts so that module stays
// free of bundler asset imports and can be parsed under node by the self-tests.
//
// Loading is lazy and memoized rather than done at startup like the MSDF atlases, because
// the font files are the whole cost of this path: four TTFs are a good deal more bytes than
// four atlas PNGs, and an app that only ever draws MSDF text should never pay for them. The
// `?url` imports keep them out of the JS bundle - they resolve to asset URLs, so the files
// are only fetched when this function is actually called.

import { VectorFontBook, type VectorFontOptions, type VectorFontSource } from './VectorFont'
import type { FontStyle } from './FontAtlas'

import interRegularTtf from './fonts/src/Inter-Regular.ttf?url'
import interBoldTtf from './fonts/src/Inter-Bold.ttf?url'
import interItalicTtf from './fonts/src/Inter-Italic.ttf?url'
import interBoldItalicTtf from './fonts/src/Inter-BoldItalic.ttf?url'

const URLS: readonly { style: FontStyle; url: string }[] = [
  { style: 'regular', url: interRegularTtf },
  { style: 'bold', url: interBoldTtf },
  { style: 'italic', url: interItalicTtf },
  { style: 'bold-italic', url: interBoldItalicTtf },
]

let pending: Promise<VectorFontBook> | null = null

/**
 * Fetch and parse the bundled Inter TTFs into a VectorFontBook.
 *
 * Memoized on the promise, not the result, so concurrent callers (two scenes loading at
 * once, say) share one set of fetches instead of racing. `options` therefore only takes
 * effect on the first call; build a book with VectorFontBook.load directly to use
 * different curve tolerances side by side.
 */
export function loadDefaultVectorFonts(options: VectorFontOptions = {}): Promise<VectorFontBook> {
  if (!pending) {
    pending = Promise.all(
      URLS.map(async ({ style, url }): Promise<VectorFontSource> => {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Failed to load ${style} font (${response.status})`)
        return { style, data: await response.arrayBuffer() }
      }),
    )
      .then((sources) => VectorFontBook.load(sources, options))
      .catch((error) => {
        // Don't cache a failure - a transient network error shouldn't disable the vector
        // text path for the rest of the session.
        pending = null
        throw error
      })
  }
  return pending
}
