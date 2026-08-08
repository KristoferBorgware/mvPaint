// The cache for resources that belong to nobody in particular.
//
// There are two layers, and which one a resource goes in is decided by a hard fact: a GPUTexture
// belongs to a device and cannot be handed to a second renderer, while a parsed glyph outline
// belongs to no device at all. So textures and font atlases are cached per renderer, and this
// holds what is genuinely global - the parse, and the bytes a parse was made from.
//
// NOTHING HERE KEEPS A SECOND COPY OF WHAT IS ALREADY ON THE GPU. A picture is deduplicated at
// the texture layer, where one URL means one texture; holding its decoded pixels here as well
// would be the same image in memory twice. What this layer saves is the fetch and the parse,
// which is where the milliseconds are.

import { ResourceCache } from './ResourceCache'

const cache = new ResourceCache()

/**
 * The process-wide store of device-free resources - parsed glyph outlines, and font metrics.
 *
 * Reached through a function rather than exported as a binding so that a test can put a clean
 * one in front of it (see InitGlobalResourceCache), which module-level state otherwise makes
 * impossible.
 */
export function globalResourceCache(): ResourceCache {
  return current
}

let current = cache

/**
 * Draw from a different cache - for a test that needs its own, and has to put the real one back
 * afterwards. Returns the cache that was in place.
 */
export function InitGlobalResourceCache(replacement: ResourceCache): ResourceCache {
  const previous = current
  current = replacement
  return previous
}
