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
import type { ColorInput } from '../render/color'

/** Which render path drew this frame. `'auto'` is only an input; a renderer is always one. */
export type RenderPathKind = 'webgpu' | 'webgl2'

/**
 * The GPU resources a scene has to create for itself, because only it knows what it wants.
 * Every renderer handle provides them, so a function that builds content can take this
 * narrower type instead of the whole renderer.
 */
export interface SceneResources {
  /** Build an image texture for whichever path is drawing - see image/ImageTexture.ts. */
  readonly images: ImageTextureFactory
}

export interface SceneRendererHandle extends SceneResources {
  /** Which path this renderer actually took - `'webgl2'` means WebGPU was unavailable. */
  readonly path: RenderPathKind
  /**
   * The scene graph. A renderer starts with an empty one and draws it every frame, so content
   * is added here after the renderer exists - `handle.scene.root.addChild(node)` - rather than
   * being supplied at construction.
   *
   * Adding and removing nodes needs no dirty mark: the visible set is recomputed each frame
   * and a lane repacks when its membership changes. The exception is a scene that has turned
   * BOTH culling and the zIndex sort off, which reuses the previous frame's visible set
   * wholesale (see render/gather.ts) and needs markGeometryDirty() to notice.
   */
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
  /**
   * Called every frame, before the draw - animate scene content here.
   *
   * A property rather than a construction option, for the reason the scene is filled after
   * construction too: a callback that animates a node wants that node to exist, and at
   * construction it does not. Assign it when there is something to animate, and null it to
   * stop. It is called with the seconds elapsed since the previous frame.
   */
  onFrame: ((dt: number) => void) | null
  /**
   * Draws the scene once into an offscreen target and hands back a canvas of it - the
   * primitive the other two are built on, and the one to reach for when the pixels are going
   * somewhere other than a file.
   *
   * Nothing about the live view changes. The capture runs through a camera the engine builds
   * from the requested region, on its own render target, and the on-screen camera, size and
   * contents are exactly as they were afterwards.
   *
   * It costs a full frame's work - one gather, one repack, one draw - and, because the capture
   * culls against a different rectangle than the live view, the frame after it re-gathers.
   * That is a screenshot's fair price; it is not something to call every frame.
   */
  toCanvas: (options?: CaptureOptions) => Promise<HTMLCanvasElement>
  /** The same capture as an encoded data URL. */
  toDataURL: (options?: EncodedCaptureOptions) => Promise<string>
  /** The same capture as a Blob, which is what a download wants (see URL.createObjectURL). */
  toBlob: (options?: EncodedCaptureOptions) => Promise<Blob>
  markGeometryDirty: () => void
  markTextGeometryDirty: () => void
  markImageGeometryDirty: () => void
  destroy: () => void
}

/**
 * What region of the scene to capture, and at what size. Every field is optional: the default
 * is "exactly what is on screen now, at screen resolution".
 *
 * The region is in WORLD units and the engine builds the camera for it, so a caller never
 * constructs or attaches one. That is the whole point of the shape of this: a screenshot is a
 * question about the scene ("this rectangle of world, at this size"), not an instruction to
 * rearrange the renderer's view - and a capture must not disturb what the user is looking at.
 */
export interface CaptureOptions {
  /**
   * World point at the capture's top-left corner. The scene is y-up, so the region extends
   * right and DOWNWARD from here - the same convention Rect, Camera2D and the rest follow.
   * Defaults to the live camera's, so omitting x/y/width/height captures the current view.
   */
  x?: number
  y?: number
  /** Size of the region in world units. Defaults to what the camera currently shows. */
  width?: number
  height?: number
  /**
   * Output pixels per world unit. Default 1, so a 800x600 region is an 800x600 image; 2 gives
   * 1600x1200 of the same region, which is how a print-resolution export is asked for.
   */
  pixelRatio?: number
  /** Radians, about the region's centre. Default 0 - a capture is normally axis-aligned. */
  rotation?: number
  /**
   * What to fill the image with before the scene is drawn. Takes either form a colour can be
   * written in - the tuple, or a string like '#fff' or 'white'.
   *
   * Default fully transparent, which is what a screenshot meant for compositing wants; pass an
   * opaque colour for one meant to be looked at on its own.
   */
  background?: ColorInput
}

/** Capture options plus the two things only an encoded image needs. See toDataURL/toBlob. */
export interface EncodedCaptureOptions extends CaptureOptions {
  /** Default 'image/png'. 'image/jpeg' and 'image/webp' are the other usual ones. */
  mimeType?: string
  /** 0..1, for the lossy types. Ignored by PNG. */
  quality?: number
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
   * The camera to draw through. Omit it and the scene renders through a default one, which
   * puts world (0, 0) at the viewport's top-left corner at one world unit per CSS pixel - a
   * deliberate framing, not a fallback. Supply one to own the view, and keep the reference:
   * moving it is how an application pans and zooms.
   */
  camera?: Camera2D
}
