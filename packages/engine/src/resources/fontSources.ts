// Fetching font data, once per address.
//
// The engine ships no typeface, so every application serves its own and fetches it - and every
// one of them ends up writing the same memo, because a React remount, a second renderer, or two
// scenes wanting the same face all ask again for something already in hand. This is that memo,
// in the engine, keyed on the URLs the data came from.
//
// It is device-free on both sides, which is why it can be truly global: a polygon atlas is
// outlines, and an MSDF source is metrics plus the ADDRESS of a PNG that the render path fetches
// into a texture itself. Neither is bound to a GPU (see resources/globalCache.ts for the split).
//
// The fetch is checked for a JSON content type as well as a status, because a dev server that
// answers a missing file through an SPA fallback returns index.html with a 200 - a failure that
// otherwise surfaces as a parse error pointing at the wrong thing.

import { PolygonFontBook, type PolygonFontJson, type PolygonFontSource } from '../text/PolygonFont'
import type { MsdfAtlasSource } from '../text/msdfProvider'
import type { MsdfFontJson } from '../text/msdfMetrics'
import type { FontStyle } from '../text/msdfProvider'
import { globalResourceCache } from './globalCache'
import { SharedValue } from './SharedLifetime'

/** One style of a polygon atlas, and where its document is served from. */
export interface PolygonFontUrl {
  style: FontStyle
  /** The `.polygons.json` document for this style. */
  url: string
}

/** One style of an MSDF set: where its metrics are, and where its atlas image is. */
export interface MsdfAtlasUrl {
  style: FontStyle
  /** The metrics document, fetched here. */
  metricsUrl: string
  /** The atlas PNG. Not fetched here - it goes to the render path, which uploads it directly. */
  imageUrl: string
}

async function fetchJson<T>(url: string, what: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to load ${what} (${response.status} from ${url})`)
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('json')) {
    throw new Error(`${url} returned ${type || 'no content type'}, not JSON - is ${what} being served?`)
  }
  return (await response.json()) as T
}

/** One document, fetched at most once however many callers want it. */
function sharedJson<T>(url: string, what: string): Promise<SharedValue<T>> {
  return globalResourceCache().acquireAsync(`font-json:${url}`, async () => new SharedValue(await fetchJson<T>(url, what)))
}

/**
 * An atlas image's BYTES, fetched at most once per address.
 *
 * Bytes rather than a decoded bitmap, and bytes rather than a texture: decoding and uploading
 * need a device, so they belong to whichever render path is drawing (see MSDFFontBook), while the
 * fetch belongs to nobody. Holding the compressed PNG is a fraction of what its decoded form
 * would be, and it means a font book rebuilt against the same address - a remount, a family
 * replaced with the set it already had - costs no round trip.
 *
 * Never released: a typeface is loaded before the first frame of text and drawn from until the
 * page goes. See loadMsdfAtlases, which says the same of the metrics.
 */
export async function sharedAtlasBytes(url: string): Promise<Blob> {
  const held = await globalResourceCache().acquireAsync(`font-image:${url}`, async () => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to load a font atlas (${response.status} from ${url})`)
    return new SharedValue(await response.blob())
  })
  return held.value
}

/**
 * The outlines a `VectorText` node draws from, fetched once per set of addresses.
 *
 * Asking twice for the same styles gives the same book, and two callers asking before the fetch
 * lands share it. Each is a holder: `book.destroy()` lets go, and the last one to do so is what
 * drops it. An application that draws vector text for the life of the page can simply never call
 * it, which is what holding a font means.
 */
export function loadPolygonFonts(sources: readonly PolygonFontUrl[]): Promise<PolygonFontBook> {
  if (sources.length === 0) throw new Error('loadPolygonFonts: no styles given.')
  // The set is what makes two books the same, and the order it was written in does not.
  const key = `polygon-book:${sources.map((s) => `${s.style}=${s.url}`).sort().join('|')}`
  return globalResourceCache().acquireAsync(key, async () => {
    const documents = await Promise.all(
      sources.map((source) => sharedJson<PolygonFontJson>(source.url, `the ${source.style} glyph atlas`)),
    )
    const book = new PolygonFontBook(
      documents.map((document, i): PolygonFontSource => ({ style: sources[i].style, json: document.value })),
    )
    // The book has read what it needs into its own structures, so the raw documents go. They are
    // the largest thing here - a style's outlines are hundreds of kilobytes as JSON - and the
    // only reason to have held them at all was so that two books sharing a style share its fetch.
    for (const document of documents) document.release()
    return book
  })
}

/** An MSDF set in hand, and the means to let go of the documents it was built from. */
export interface LoadedMsdfAtlases {
  /** What `createSceneRenderer({ fonts })` and `handle.setMSDFFonts()` take. */
  sources: readonly MsdfAtlasSource[]
  /**
   * Lets go of the metrics documents.
   *
   * Rarely called, and that is not an oversight: a typeface is fetched once before the first
   * frame of text and drawn from until the page goes. The reason it exists is the case where
   * that is not true - an editor loading a document's fonts and then closing it.
   */
  release(): void
}

/**
 * The MSDF metrics a renderer is created with, fetched once per address.
 *
 * Only the metrics are fetched: each source carries its PNG's URL and the render path uploads
 * that straight into a texture, so the images never pass through this module or the JS heap.
 * That is also why this is one round trip before the first frame of text and not five - the
 * shaper measures with the metrics synchronously and cannot start without them.
 */
export async function loadMsdfAtlases(sources: readonly MsdfAtlasUrl[]): Promise<LoadedMsdfAtlases> {
  const held = await Promise.all(
    sources.map((source) => sharedJson<MsdfFontJson>(source.metricsUrl, `the ${source.style} MSDF metrics`)),
  )
  return {
    sources: held.map((document, i) => ({ style: sources[i].style, url: sources[i].imageUrl, json: document.value })),
    release: () => {
      for (const document of held) document.release()
    },
  }
}
