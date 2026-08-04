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

import type { Vector2Like } from '../math/Vector2'
import type { AABB } from '../math/AABB'
import type { Camera2D } from '../camera/Camera2D'
import type { Scene } from '../scene/Scene'
import type { Shape } from '../shapes/Shape'
import type { TransformableNode } from '../shapes/Group'
import type { PickableNode } from '../scene/picking'
import type { MarqueeOptions } from '../scene/selection'
import type { ImageTextureFactory } from '../image/ImageTexture'
import type { ColorInput } from '../render/color'
import type { InputOptions } from '../input/inputOptions'
import type { SceneInput } from '../input/sceneInput'
import type { MsdfAtlasSource } from '../text/msdfProvider'
import type { GpuPowerPreference, RendererAdapter } from './adapter'

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
   * Which GPU is drawing, and which one was asked for - see renderer/adapter.ts.
   *
   * Reported rather than assumed, because `powerPreference` is a hint that a machine with one
   * GPU ignores and a machine whose browser is pinned elsewhere overrides. This is how an
   * application (or a person looking at a debug panel) can tell what it actually got.
   */
  readonly adapter: RendererAdapter
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
  /**
   * Replace the MSDF atlases `Text` draws from, at any point - the runtime half of the `fonts`
   * option, so an application whose fonts live on a CDN is not forced to have them in hand
   * before the canvas exists.
   *
   * ```ts
   * const handle = await createSceneRenderer(canvas)          // draws with the fallback
   * await handle.setFonts(await fetchAtlasesFromCdn())        // ...then with yours
   * ```
   *
   * Pass a `family` name to load a SECOND typeface rather than replace the default, which is
   * what lets two `Text` nodes draw in different faces: `setFonts(roboto, 'roboto')`, then
   * `new Text({ fontFamily: 'roboto' })`. Within one family it replaces rather than merges, so
   * an application never silently ends up half its own typeface and half the fallback; to add a
   * style, spread what is already loaded: `setFonts([...handle.getFonts(), extra])`.
   *
   * Every cached text layout is dropped and re-shaped against the new metrics, and the text
   * lane repacks; nodes, transforms and the camera are untouched. Awaiting it means the atlases
   * are uploaded and the next frame draws them. If a fetch fails it rejects and the renderer
   * keeps the fonts it had, rather than being left with text it cannot draw.
   *
   * `VectorText` needs nothing like this - its outlines are supplied per node, so loading them
   * late has always just been a matter of when you construct the node.
   */
  setFonts: (sources: readonly MsdfAtlasSource[], family?: string) => Promise<void>
  /**
   * The atlases a family currently holds - the default family unless named, and an empty list
   * for a family that is not loaded.
   */
  getFonts: (family?: string) => readonly MsdfAtlasSource[]
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
  nodesInBox: (from: Vector2Like, to: Vector2Like, options?: MarqueeOptions) => Shape[]
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
   * The same thing for several subscribers, running just after `onFrame`, and what the
   * engine's own per-frame furniture uses (the selection frame refits here). Returns the
   * function that unsubscribes.
   *
   * `onFrame` stays a single settable slot because that is the shape an application wants;
   * this is what keeps the engine from quietly taking it.
   */
  addFrameListener: (listener: (dt: number) => void) => () => void
  /**
   * The input the engine wired up for this canvas, or null for a static render - see the
   * `input` option below. Holds the selection frame and the pointer dispatcher, and is torn
   * down with the renderer.
   */
  readonly input: SceneInput | null
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
   * Which GPU to ask for on a machine that has more than one. Default `'high-performance'`,
   * which is NOT the platform default - browsers left to themselves pick the integrated GPU.
   * Pass `'low-power'` for an application that would rather have the battery.
   *
   * It is a hint, and the only one there is: neither WebGPU nor WebGL lets a page enumerate
   * GPUs or name one. See renderer/adapter.ts for what it can and cannot do, and read
   * `handle.adapter` for what came back.
   */
  powerPreference?: GpuPowerPreference
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
  /**
   * The MSDF atlases `Text` draws from - one entry per style, each a generated metrics JSON
   * plus a URL for its PNG. Generate them with `packages/scripts` and keep them with your
   * application's other assets.
   *
   * Omit it and the engine loads the Inter atlas it ships with, so text draws before an
   * application has chosen a typeface. That fallback is fetched through a dynamic import, so
   * supplying your own keeps those four images out of your main bundle.
   *
   * A partial set is fine - give it bold alone and every run resolves to bold, with regular
   * synthesized off it by the same ladder that synthesizes faux italic.
   *
   * Glyph OUTLINES, for `VectorText`, are supplied per node instead: see `VectorFonts`,
   * `PolygonFontBook` and `@mvpaint/ttf`. The engine ships none of those at all.
   */
  fonts?: readonly MsdfAtlasSource[]

  /**
   * Which pointer and keyboard bindings the engine should set up for this canvas. Omitted
   * (the default) is a STATIC render: nothing is listened for and nothing is hit-tested,
   * while the camera stays an ordinary object the application can move whenever it likes.
   *
   *   'view'    pan, zoom and the keyboard - the reader's set. Nothing is ever picked, so a
   *             press always lands on empty space and a scene of any size costs nothing per
   *             pointer move.
   *   'editor'  that plus the content: hover and click events on nodes, dragging, selection,
   *             the resize/rotate frame, and marquee selection.
   *
   * The long form turns individual behaviours off - `{ objects: { drag: false } }`,
   * `{ camera: { zoom: false } }` - and everything it sets up is reachable afterwards through
   * `handle.input`. See input/inputOptions.ts.
   */
  input?: InputOptions
}
