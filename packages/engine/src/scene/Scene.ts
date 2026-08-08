// Scene - owns the scene-graph root, and the resources built to fill it. Where the scene is
// looked at from is a Camera2D the application supplies to the renderer (see
// webgpu/SceneRenderer). Keeping the camera out means one scene can be drawn through several at
// once, and that adding content can never disturb the view.
//
// own() is the answer to "when does this texture go away?". A picture is acquired by whoever
// builds the scene - not by the Image node that draws it, which may be one of ten drawing the
// same one - so the builder is the holder, and handing the resource to the scene is how that
// hold acquires an end. Everything own()ed is released by dispose(), after the nodes are gone.
//
// A resource several scenes want is acquired once and own()ed by each of them, because
// handle.images counts holders (see resources/cachingImageFactory.ts): the first scene to be
// disposed releases its hold and the texture stays, the last one frees it.

import { Container } from '../shapes/Container'

/** Anything with an end: an ImageTexture, a PolygonFontBook, an application's own handle. */
export interface Disposable {
  destroy(): void
}

export class Scene {
  readonly root = new Container('root')

  private readonly owned: Disposable[] = []
  private disposed = false

  /**
   * Hands a resource's lifetime to this scene: it is released when the scene is disposed.
   * Returns it, so it can wrap the call that built it.
   *
   * ```ts
   * const checker = scene.own(images.fromPixels(pixels, 256, 256, 'checker'))
   * ```
   */
  own<T extends Disposable>(resource: T): T {
    if (this.disposed) throw new Error('Scene.own: this scene has been disposed.')
    this.owned.push(resource)
    return resource
  }

  /** True once dispose() has run. A disposed scene is finished; do not add to it. */
  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * Finishes with the scene: every node destroyed, then every own()ed resource released.
   *
   * The nodes go first so that nothing is still holding a texture that is about to be let go of
   * - and because destroy() fires a 'destroy' event on each node while the tree is still whole
   * (see Node.destroy), which a listener may answer by reading the scene.
   *
   * Releasing is not freeing. A texture another scene also holds survives this; what ends is
   * this scene's interest in it.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.root.destroy()
    // Reverse order, so a resource built from another is let go of before the thing it was
    // built from - the same order a stack unwinds in.
    for (let i = this.owned.length - 1; i >= 0; i--) this.owned[i].destroy()
    this.owned.length = 0
  }
}
