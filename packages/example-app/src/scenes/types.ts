// The example-scene contract. Each scene is a self-contained bundle of content plus the
// metadata the picker lists it with, so adding one means adding a file and an entry in
// index.ts - nothing in the canvas or the app shell needs to know about it.

import type { Scene } from '@mvpaint/engine'

/** What a scene hands back to the frame loop after building itself. */
export interface SceneContent {
  /**
   * Called once per frame when the scene animates. `speed` is the app's rotation-speed
   * control; a scene that ignores it simply never reads it. Scenes own their own animation
   * state (accumulated angle and so on), which is what lets one be discarded wholesale on
   * a switch without leaving anything behind.
   */
  onFrame?: (dt: number, speed: number) => void
}

export interface ExampleScene {
  id: string
  title: string
  /** One or two lines shown under the title in the picker. */
  description: string
  /**
   * Any assets this scene needs fetched before it can be built - awaited by the canvas, and
   * expected to memoize, since it runs again on every switch back to the scene. Only for
   * things the engine doesn't load at startup: the vector text scene's TTFs are ~1.6MB and
   * would be dead weight for every other scene, so they're fetched on first open instead.
   * The canvas keeps the previous scene on screen while this runs.
   */
  prepare?: () => Promise<void>
  /**
   * Skip viewport culling entirely for this scene (every shape is tested and drawn every
   * frame, regardless of the camera's current view) - for a scene specifically stress-testing
   * "how much can this draw", where culling would otherwise hide most of the point unless the
   * camera happened to be zoomed out over everything. Default false (culling on, as normal);
   * the canvas restores it on switching to any scene that doesn't set this.
   */
  disableCulling?: boolean
  /**
   * Skip the zIndex depth-sort for this scene: shapes still get a depth rank every frame,
   * just in scene-traversal order rather than sorted by zIndex - free for a scene that
   * never sets zIndex (every comparison would tie, so the sort reproduces traversal order
   * anyway) and where stacking order genuinely doesn't matter. Default false (sorted, as
   * normal); the canvas restores it on switching to any scene that doesn't set this.
   */
  disableZSort?: boolean
  /**
   * Skip the shadow lane entirely for this scene: no per-frame scan for shadow-casting
   * shapes, in either the shadow-atlas prepass or the main draw. Free for a scene that
   * never enables a shadow on anything. Default false (shadows on, as normal); the canvas
   * restores it on switching to any scene that doesn't set this.
   */
  disableShadows?: boolean
  /** Populates `scene.root`. The root is already emptied of the previous scene's content. */
  build: (scene: Scene) => SceneContent
}
