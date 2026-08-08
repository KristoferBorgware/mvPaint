// Self-test for the resource cache: the holder count, and the store built on it.
//
// What is being pinned is the pair of rules that make sharing safe - a resource several holders
// want is built once, and it is freed when the LAST of them lets go, not the first. Both are
// invisible until they are wrong: a cache that frees too early leaves a scene drawing from a
// destroyed texture, and one that never frees leaks every picture the application ever opened.
//
// The caching image factory is exercised over a stub factory rather than a device: what it does
// is choose a key and count, and neither needs a GPU.
// Run with: npx vitest run packages/engine/src/resources/resources.test.ts

import { expect, it } from 'vitest'
import { ResourceCache } from './ResourceCache'
import { SharedLifetime, SharedValue } from './SharedLifetime'
import { cachingImageFactory } from './cachingImageFactory'
import type { ImageTexture, ImageTextureFactory } from '../image/ImageTexture'

/**
 * Every check in this file goes through here, so each one reads as the sentence it is making
 * and vitest reports that sentence when it stops being true.
 */
function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}

/** A resource that records whether it was actually freed. */
class Thing {
  readonly lifetime = new SharedLifetime()
  freed = false

  constructor(readonly name: string) {}

  destroy(): void {
    if (!this.lifetime.release()) return
    this.freed = true
  }
}

it('SharedLifetime: the last holder to let go is the one that frees', () => {
  const thing = new Thing('a')
  assert(thing.lifetime.holderCount === 1, 'whoever built it is its first holder')

  thing.lifetime.retain()
  thing.destroy()
  assert(!thing.freed && thing.lifetime.holderCount === 1, 'one of two holders letting go frees nothing')

  thing.destroy()
  assert(thing.freed, 'the second one does')

  // Destroying twice is what a defensive caller does, and it did not become an error.
  thing.destroy()
  assert(thing.lifetime.holderCount === 0, 'and releasing something already freed changes nothing')

  expect(() => thing.lifetime.retain()).toThrow()
})

it('SharedLifetime: one cache may key a resource, not two', () => {
  const thing = new Thing('a')
  thing.lifetime.onLastRelease(() => {})
  expect(() => thing.lifetime.onLastRelease(() => {})).toThrow()
})

it('ResourceCache: one key, one resource, counted per caller', () => {
  const cache = new ResourceCache()
  let built = 0
  const build = () => {
    built++
    return new Thing('shared')
  }

  const first = cache.acquire('k', build)
  const second = cache.acquire('k', build)
  assert(first === second, 'the second caller gets the object the first one built')
  assert(built === 1, 'and it was built once')
  assert(cache.size === 1, 'one entry, not two')

  first.destroy()
  assert(!first.freed && cache.has('k'), 'one holder letting go frees nothing and keeps the entry')

  second.destroy()
  assert(first.freed, 'the last one frees it')
  assert(!cache.has('k'), 'and the entry goes with it, so the next caller builds afresh')

  const third = cache.acquire('k', build)
  assert(built === 2 && third !== first, 'which it does')
})

it('ResourceCache: two callers before the resource lands share one build', async () => {
  const cache = new ResourceCache()
  let built = 0
  let settle: (thing: Thing) => void = () => {}
  const pending = new Promise<Thing>((resolve) => {
    settle = resolve
  })
  const build = () => {
    built++
    return pending
  }

  // Both ask while the first request is still in flight - the ordinary case for two nodes
  // wanting the same picture in one frame.
  const a = cache.acquireAsync('k', build)
  const b = cache.acquireAsync('k', build)
  assert(built === 1, 'the second caller does not start a second request')

  settle(new Thing('shared'))
  const [first, second] = await Promise.all([a, b])
  assert(first === second, 'both get the same resource')
  assert(first.lifetime.holderCount === 2, 'and both are counted, so neither can free it alone')

  first.destroy()
  assert(!first.freed, 'one of them letting go frees nothing')
  second.destroy()
  assert(first.freed, 'the other one does')
})

it('ResourceCache: a failed build leaves nothing behind', async () => {
  const cache = new ResourceCache()
  let attempts = 0
  const build = async () => {
    attempts++
    if (attempts === 1) throw new Error('the network was having a day')
    return new Thing('eventually')
  }

  await expect(cache.acquireAsync('k', build)).rejects.toThrow('the network was having a day')
  assert(!cache.has('k'), 'the entry is gone, so the failure is not what every later caller gets')

  const thing = await cache.acquireAsync('k', build)
  assert(thing.name === 'eventually' && attempts === 2, 'the next caller retries')
})

it('ResourceCache: a plain value can be shared too', () => {
  const cache = new ResourceCache()
  const held = cache.acquire('metrics', () => new SharedValue({ ascent: 12 }))
  const again = cache.acquire('metrics', () => new SharedValue({ ascent: 99 }))
  assert(again.value.ascent === 12, 'the second caller gets the first document, not a second parse')

  held.release()
  assert(cache.has('metrics'), 'still held by the other caller')
  again.release()
  assert(!cache.has('metrics'), 'and gone once neither wants it')
})

// --- the image factory ----------------------------------------------------------------------

/** A texture that owns nothing, so the factory can be checked without a device. */
class FakeTexture implements ImageTexture {
  readonly lifetime = new SharedLifetime()
  readonly width = 4
  readonly height = 4
  freed = false

  constructor(readonly from: string) {}

  destroy(): void {
    if (!this.lifetime.release()) return
    this.freed = true
  }
}

/** Records every call that actually reached the real factory. */
function stubFactory(): { factory: ImageTextureFactory; calls: string[] } {
  const calls: string[] = []
  const factory: ImageTextureFactory = {
    load: async (url) => {
      calls.push(`load:${url}`)
      return new FakeTexture(url)
    },
    fromSource: (_source, label) => {
      calls.push(`source:${label}`)
      return new FakeTexture(label ?? '')
    },
    fromPixels: (_pixels, _w, _h, label) => {
      calls.push(`pixels:${label}`)
      return new FakeTexture(label ?? '')
    },
    fromSvg: async (svgText, options) => {
      calls.push(`svg:${options?.width ?? 'auto'}`)
      return new FakeTexture(svgText)
    },
  }
  return { factory, calls }
}

const SQUARE = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'

it('cachingImageFactory: one URL is one fetch, one decode, one upload', async () => {
  const { factory, calls } = stubFactory()
  const images = cachingImageFactory(factory, new ResourceCache())

  const a = await images.load('/pic.png')
  const b = await images.load('/pic.png')
  assert(a === b, 'the same address is the same texture')
  assert(calls.length === 1, 'and it only reached the real factory once')

  const other = await images.load('/other.png')
  assert(other !== a && calls.length === 2, 'a different address is a different texture')

  a.destroy()
  assert(!(a as FakeTexture).freed, 'one of the two holders letting go frees nothing')
  b.destroy()
  assert((a as FakeTexture).freed, 'the other one does')
})

it('cachingImageFactory: an SVG is keyed by its document AND the size it was drawn at', async () => {
  const { factory, calls } = stubFactory()
  const images = cachingImageFactory(factory, new ResourceCache())

  const small = await images.fromSvg(SQUARE, { width: 24, height: 24 })
  const smallAgain = await images.fromSvg(SQUARE, { width: 24, height: 24 })
  assert(small === smallAgain && calls.length === 1, 'the same document at the same size is one raster')

  const large = await images.fromSvg(SQUARE, { width: 128, height: 128 })
  assert(large !== small && calls.length === 2, 'the same document at another size is another texture')

  // scale is part of the resolved size, so it separates two otherwise identical requests.
  await images.fromSvg(SQUARE, { width: 24, height: 24, scale: 2 })
  assert(calls.length === 3, 'and so does a scale that changes how many pixels are behind it')
})

it('cachingImageFactory: a document with no size to draw at rejects rather than throwing', async () => {
  const { factory } = stubFactory()
  const images = cachingImageFactory(factory, new ResourceCache())
  // Sizing is settled in the caching layer now, so this is where the complaint comes from - and
  // it still has to arrive as a rejected promise, since that is what the caller is awaiting.
  await expect(images.fromSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).rejects.toThrow('svg raster')
})

it('cachingImageFactory: computed pixels are shared only when the caller says what makes them equal', () => {
  const { factory, calls } = stubFactory()
  const images = cachingImageFactory(factory, new ResourceCache())
  const pixels = new Uint8Array(4 * 4 * 4)

  const a = images.fromPixels(pixels, 4, 4, 'checker')
  const b = images.fromPixels(pixels, 4, 4, 'checker')
  assert(a !== b && calls.length === 2, 'a debug label is not a key - two calls are two textures')

  const keyed = images.fromPixels(pixels, 4, 4, 'checker', 'checker-256-8')
  const keyedAgain = images.fromPixels(pixels, 4, 4, 'checker', 'checker-256-8')
  assert(keyed === keyedAgain && calls.length === 3, 'an explicit key is')
})
