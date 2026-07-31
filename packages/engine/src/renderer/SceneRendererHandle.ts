// What an application holds when it has a renderer - and the only thing either render path
// has to agree on.
//
// This is the abstraction. Not a device, not a command encoder, not a pipeline: everything an
// application actually does with a renderer is here, and none of it mentions an API. A scene
// to add content to, a camera to look through, some debug toggles, three questions about what
// is under a pixel, and the dirty marks. WebGPU implements it (webgpu/SceneRenderer.ts) and
// the WebGL fallback implements it too, and neither knows the other exists.
//
// Keeping it in its own file rather than beside the WebGPU implementation is what makes that
// true: the fallback can implement this interface without importing a single WebGPU symbol,
// and deleting the fallback later takes nothing with it.

import type { AABB } from '../math/AABB'
import type { Camera2D } from '../camera/Camera2D'
import type { Scene } from '../scene/Scene'
import type { Shape } from '../shapes/Shape'
import type { TransformableNode } from '../shapes/Group'
import type { PickableNode } from '../scene/picking'
import type { MarqueeOptions } from '../scene/selection'
import type { ImageTextureFactory } from '../image/ImageTexture'

/** Which render path drew this frame. `'auto'` is only an input; a renderer is always one. */
export type RenderPathKind = 'webgpu' | 'webgl2'

/**
 * The GPU resources a scene has to create for itself, because only it knows what it wants.
 * Handed to `populate` (before any handle exists) and available on the handle afterwards.
 */
export interface SceneResources {
  /** Build an image texture for whichever path is drawing - see image/ImageTexture.ts. */
  readonly images: ImageTextureFactory
}

export interface SceneRendererHandle extends SceneResources {
  /** Which path this renderer actually took - `'webgl2'` means WebGPU was unavailable. */
  readonly path: RenderPathKind
  /** The scene graph root - add/remove content here, then call markGeometryDirty()/markTextGeometryDirty(). */
  scene: Scene
  /** The view the scene is drawn through - the one supplied, or the default. */
  camera: Camera2D
  /** Draw through a different camera; null goes back to the default (0,0 top-left, zoom 1). */
  setCamera: (camera: Camera2D | null) => void
  setZoom: (zoom: number) => void
  getZoom: () => number
  /** Debug/testing knob: grows (or shrinks, if negative) the viewport-culling rectangle. */
  setCullMargin: (margin: number) => void
  getCullMargin: () => number
  /** Turns viewport culling on/off entirely. */
  setCullingEnabled: (enabled: boolean) => void
  getCullingEnabled: () => boolean
  /** Turns the zIndex depth-sort on/off. */
  setZSortEnabled: (enabled: boolean) => void
  getZSortEnabled: () => boolean
  /** Turns the shadow lane on/off entirely. */
  setShadowsEnabled: (enabled: boolean) => void
  getShadowsEnabled: () => boolean
  /** The last frame's (margin-expanded) cull rectangle, world space, or null before the first draw. */
  getCullBounds: () => AABB | null
  /** The topmost pickable shape/text under a canvas-relative CSS pixel, or null. */
  pick: (screenX: number, screenY: number) => PickableNode | null
  /** A picked node's own local-space bounds - for sizing a selection-highlight overlay. */
  localBoundsOf: (node: TransformableNode) => AABB
  /** Every visible, pickable shape meeting a world-space rectangle - what a marquee selects. */
  nodesInBox: (from: { x: number; y: number }, to: { x: number; y: number }, options?: MarqueeOptions) => Shape[]
  markGeometryDirty: () => void
  markTextGeometryDirty: () => void
  markImageGeometryDirty: () => void
  destroy: () => void
}

export interface CreateSceneRendererOptions {
  /**
   * Which render path to take. `'auto'` (the default) uses WebGPU and falls back to WebGL2
   * only if WebGPU is unavailable. `'webgl2'` forces the fallback - which is how it gets
   * tested on a machine that has WebGPU, and the only reason to ask for it deliberately.
   */
  backend?: 'auto' | RenderPathKind
  /**
   * Called with a human-readable message on a device error (e.g. an invalid pipeline from a
   * shader/layout mismatch). Such errors do NOT throw - they surface asynchronously - so
   * without this they render as a silently blank canvas. Reporting them makes that failure
   * mode visible instead.
   */
  onDeviceError?: (message: string) => void
  /**
   * Called once after the scene and camera are ready, before the first frame - build the
   * initial scene content here (shapes, text, camera framing). `resources` is passed because
   * this runs before the handle exists, and content with images needs somewhere to build a
   * texture from.
   */
  populate?: (scene: Scene, camera: Camera2D, resources: SceneResources) => void
  /**
   * The camera to draw through. Omit it and the scene renders through a default one, which
   * puts world (0, 0) at the viewport's top-left corner at one world unit per CSS pixel - a
   * deliberate framing, not a fallback. Supply one to own the view, and keep the reference:
   * moving it is how an application pans and zooms.
   */
  camera?: Camera2D
  /** Called every frame, before the draw - e.g. to animate scene content. */
  onFrame?: (dt: number) => void
}
