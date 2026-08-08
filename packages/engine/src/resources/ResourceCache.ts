// A keyed store of resources that are worth building once: a decoded and uploaded picture, a
// rasterized SVG, a parsed set of glyph outlines. Asking twice for the same key hands back the
// same object and counts a second holder; the resource is freed when the last of them lets go.
//
// The count is on the resource (see SharedLifetime), so this holds no reference of its own. A
// cache that did would keep everything in it alive forever, and one that expired entries on a
// timer would free a texture a scene is still drawing. Counting holders is the only rule that
// answers both.
//
// WHAT A KEY HAS TO BE. Everything that would change the result: a URL is enough for a picture,
// but an SVG is a document AND the size it was rasterized at, and two sizes are two entries.
// Where no such key exists - pixels an application computed - there is nothing to key on and the
// caller supplies one or goes uncached (see resources/cachingImageFactory.ts).
//
// IN-FLIGHT REQUESTS ARE ONE REQUEST. Two nodes asking for the same URL in the same frame is the
// ordinary case, and both arrive long before either fetch lands. A pending entry counts its
// waiters as they arrive - synchronously, before any of them can touch the resource - and the
// retains are applied the moment it resolves.

import type { Shared } from './SharedLifetime'

/** A resource in hand, or the one request that is going to produce it. */
type Entry<T extends Shared> = { value: T; pending?: undefined } | { value?: undefined; pending: PendingEntry<T> }

interface PendingEntry<T extends Shared> {
  promise: Promise<T>
  /** How many callers are waiting. The first built it and already holds it once. */
  waiters: number
}

export class ResourceCache {
  // Typed loosely because one cache holds unrelated kinds - a texture under a URL, a font book
  // under its sources - and a key names exactly one of them. acquire() reimposes the type at
  // the only boundary where a caller states what it expects.
  private readonly entries = new Map<string, Entry<Shared>>()

  /** How many resources are currently held through this cache. */
  get size(): number {
    return this.entries.size
  }

  /** Whether a key currently names a resource (or a request for one). */
  has(key: string): boolean {
    return this.entries.has(key)
  }

  /**
   * The resource this key names, building it on a miss. Every caller gets the same object and
   * counts as a holder, so every caller has to let go of it - for an ImageTexture that is
   * destroy(), which releases one holder and frees only for the last.
   */
  acquire<T extends Shared>(key: string, create: () => T): T {
    const found = this.entries.get(key) as Entry<T> | undefined
    if (found?.value) {
      found.value.lifetime.retain()
      return found.value
    }
    if (found?.pending) {
      throw new Error(`ResourceCache.acquire: '${key}' is being built asynchronously - await acquireAsync instead.`)
    }

    const value = create()
    this.entries.set(key, { value })
    value.lifetime.onLastRelease(() => this.entries.delete(key))
    return value
  }

  /**
   * The same, for a resource that has to be fetched, decoded or rasterized first.
   *
   * A failed build leaves nothing behind, so the next caller retries rather than inheriting an
   * error - which matters most for the case it is likeliest in, a network request.
   */
  acquireAsync<T extends Shared>(key: string, create: () => Promise<T>): Promise<T> {
    const found = this.entries.get(key) as Entry<T> | undefined
    if (found?.value) {
      found.value.lifetime.retain()
      return Promise.resolve(found.value)
    }
    if (found?.pending) {
      // Counted now, not in a then(): the resolve handler below runs before any waiter's, so
      // by the time one of them holds the resource its count already includes it. Retaining
      // later would leave a window where the builder could let go and free it underneath them.
      found.pending.waiters++
      return found.pending.promise
    }

    const promise = create().then(
      (value) => {
        const pending = (this.entries.get(key) as Entry<T> | undefined)?.pending
        this.entries.set(key, { value })
        value.lifetime.onLastRelease(() => this.entries.delete(key))
        // The builder's own hold is the one the resource was constructed with.
        for (let i = 1; i < (pending?.waiters ?? 1); i++) value.lifetime.retain()
        return value
      },
      (error: unknown) => {
        this.entries.delete(key)
        throw error
      },
    )

    this.entries.set(key, { pending: { promise, waiters: 1 } })
    return promise
  }

  /**
   * Forget every entry WITHOUT freeing anything - for a test that wants a clean slate, and for a
   * renderer whose device has gone, taking its textures with it.
   *
   * Not a way to free a cache's contents: the holders decide that, and one of them may still be
   * drawing. What this drops is the engine's ability to hand the same resource out again.
   */
  clear(): void {
    this.entries.clear()
  }
}
