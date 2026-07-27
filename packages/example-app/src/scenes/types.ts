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
  /** Populates `scene.root`. The root is already emptied of the previous scene's content. */
  build: (scene: Scene) => SceneContent
}
