// How a resource several holders can share knows when the last of them has let go.
//
// The count lives ON the resource rather than in a wrapper around it. A wrapper is the obvious
// design and it does not work here: a render path narrows an ImageTexture to the implementation
// it created in order to reach its bind groups (see image/ImageTexture.ts), and a proxy fails
// that narrowing. So the resource keeps its own identity, and carries this.
//
// A resource starts with ONE holder - whoever built it - so an uncached texture behaves exactly
// as it reads: construct it, destroy it, it is gone. Sharing is what a cache adds on top by
// retaining a second time (see resources/ResourceCache.ts).

export class SharedLifetime {
  private holders = 1
  private notifyLastRelease: (() => void) | undefined

  /** How many holders are still using this. 0 once it has been freed. */
  get holderCount(): number {
    return this.holders
  }

  /** Another holder takes it up. */
  retain(): void {
    if (this.holders <= 0) {
      throw new Error('SharedLifetime.retain: this resource was already freed - the last holder let go of it.')
    }
    this.holders++
  }

  /**
   * One holder lets go. Returns true when it was the LAST one, which is the resource's cue to
   * actually free itself.
   *
   * Releasing an already-freed resource returns false rather than throwing, so a second
   * destroy() is the no-op it always was.
   */
  release(): boolean {
    if (this.holders <= 0) return false
    this.holders--
    if (this.holders > 0) return false
    this.notifyLastRelease?.()
    return true
  }

  /**
   * Told to whatever is keying this resource, so its entry goes when the resource does.
   *
   * One slot, not a list: a resource is cached in one place, and a second registration would
   * mean two caches each believing they hold the key to it.
   */
  onLastRelease(notify: () => void): void {
    if (this.notifyLastRelease) {
      throw new Error('SharedLifetime.onLastRelease: this resource is already keyed by a cache.')
    }
    this.notifyLastRelease = notify
  }
}

/** A resource whose holders are counted - what ResourceCache stores. */
export interface Shared {
  readonly lifetime: SharedLifetime
}

/**
 * Plain data with a holder count around it, so something that is not an object with a destroy()
 * of its own - a parsed JSON document, a decoded buffer - can be cached like anything else.
 */
export class SharedValue<T> implements Shared {
  readonly lifetime = new SharedLifetime()

  constructor(readonly value: T) {}

  /** One holder lets go. There is nothing to free; what this releases is the cache entry. */
  release(): void {
    this.lifetime.release()
  }
}
