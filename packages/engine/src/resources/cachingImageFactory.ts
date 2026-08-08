// One picture, one texture - however many nodes want it.
//
// Both render paths build their own ImageTextureFactory (webgpu/ImageTexture.ts's
// gpuImageFactory, webgl/GlImageTexture.ts's glImageFactory) and neither knows the other exists,
// so the sharing lives here, wrapped around whichever one a renderer made. What is added is a
// key per call and a ResourceCache lookup; the texture that comes back is the implementation's
// own object, unwrapped, because the image lane narrows it to reach its bind groups.
//
// The cache is per renderer, not global: a GPUTexture belongs to a device, and a second renderer
// on a second device cannot bind this one whatever the key says. What IS global - a parse, the
// bytes a fetch returned - lives in resources/globalCache.ts instead.

import { resolveSvgPixelSize, type ImageTexture, type ImageTextureFactory } from '../image/ImageTexture'
import type { ResourceCache } from './ResourceCache'

/**
 * `inner` with sharing on top.
 *
 * `load` and `fromSvg` are shared on their own terms - a URL, and a document at a resolved size.
 * `fromSource` and `fromPixels` are shared only when the caller supplies a key, since a bitmap
 * and a pixel buffer are objects rather than names and nothing here can tell two of them apart.
 */
export function cachingImageFactory(inner: ImageTextureFactory, cache: ResourceCache): ImageTextureFactory {
  return {
    load: (url) => cache.acquireAsync(`url:${url}`, () => inner.load(url)),

    // Async so that a document with no size to rasterize at rejects, as it did when
    // resolveSvgPixelSize was reached inside inner.fromSvg, rather than throwing synchronously
    // out of a call the caller is awaiting.
    async fromSvg(svgText, options): Promise<ImageTexture> {
      // The size is part of what makes two rasterizations the same, so it is settled before the
      // key is built. Reading it scans the root <svg> tag only, not the document.
      const { width, height } = resolveSvgPixelSize(svgText, options)
      // The document itself is in the key, which keeps it in memory for as long as the texture
      // is held. A caller passing a module constant - which is the ordinary case - was keeping
      // it anyway.
      return cache.acquireAsync(`svg:${width}x${height}:${svgText}`, () => inner.fromSvg(svgText, options))
    },

    fromSource: (source, label, key) =>
      key === undefined
        ? inner.fromSource(source, label)
        : cache.acquire(`source:${key}`, () => inner.fromSource(source, label, key)),

    fromPixels: (pixels, width, height, label, key) =>
      key === undefined
        ? inner.fromPixels(pixels, width, height, label)
        : cache.acquire(`pixels:${key}`, () => inner.fromPixels(pixels, width, height, label, key)),
  }
}
