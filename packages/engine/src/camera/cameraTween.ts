// Animating the view: flying to a place, framing a thing, zooming toward a point.
//
// A camera can be tweened through its own fields - `camera.to({ x, y, zoom })` - and for a
// caller that has already worked out where the corner belongs, that is the whole story. It is
// the wrong way to say "fly over there and zoom in", for two reasons that have nothing to do
// with tweening:
//
//   - x/y are the view's TOP-LEFT CORNER, not what it is looking at. Hold the corner still and
//     change the zoom and the content slides sideways, because the rectangle grew from that
//     corner. What a caller means by "where the camera is" is the CENTRE.
//   - zoom is a scale factor, and a straight line through a scale factor is not a steady zoom.
//     1 to 8 passes 4 - halfway to the eye - after seven eighths of a second in every second.
//     Moving through its LOGARITHM instead makes each moment magnify by the same ratio, which
//     is the motion that reads as a constant rate.
//
// So this module tweens a VIEW rather than the fields: a centre, a zoom held in log space, and
// a rotation. It is an ordinary Tween over an ordinary target (see TweenTarget) - the same
// easings, yoyo, seek, reverse and ownership as anything else - and the target is memoized per
// camera, so a second flight interrupts the first cleanly instead of the two writing over each
// other every frame.
//
// THE PAN AND THE ZOOM ARE NOT INDEPENDENT, which is the third thing, and the one that decides
// whether a flight reads as one movement or as two. How fast the content crosses the SCREEN is
// the world-space speed times the zoom, so a centre moving in a straight line through world
// space crosses the screen at a speed that varies by the whole zoom ratio of the flight. Flying
// in eightfold, the pan is eight times faster at the end than at the start - which looks like
// the zoom happening first and the pan being tacked on after it. Flying out, the two swap.
//
// Holding the SCREEN speed constant instead means the centre must be an affine function of
// 1/zoom rather than of time. That is what `pan: 'screen'` does, and it is the default:
//
//   c(t) = c0 + (c1 - c0) * (w(t) - w0) / (w1 - w0)      where w = 1 / zoom
//
// The two motions then finish together and read as one. It cannot be had by easing the flight
// differently - the zoom and the centre need different curves, and a single curve applied to
// both leaves their ratio exactly as it was. `pan: 'world'` is the straight line, for a caller
// who wants the centre to travel at a steady rate through the scene rather than across the view.

import { Camera2D } from './Camera2D'
import type { AABB } from '../math/AABB'
import type { Vector2Like } from '../math/Vector2'
import { panToAnchor } from '../input/cameraControls'
import { screenToWorld, type Viewport } from '../input/viewport'
import { Tween, type TweenSettings, type TweenTarget } from '../tween/Tween'

/** Smallest zoom the log can be taken of - the same floor the projection guards with. */
const ZOOM_FLOOR = 1e-6

/** A viewport, or a way of asking for one each frame - which a resizable canvas wants. */
export type ViewportSource = Viewport | (() => Viewport)

/** How the centre travels while the zoom is changing under it - see the file header. */
export type PanSpace = 'screen' | 'world'

/** Where a view should end up. Every part is optional; what is left out is left alone. */
export interface CameraDestination {
  /** The world point to bring to the middle of the view. */
  center?: Vector2Like
  /** Viewport pixels per world unit. Travelled geometrically - see the file header. */
  zoom?: number
  /** Degrees, taken literally: 350 to 10 turns the long way round, -10 is the short way. */
  rotation?: number
  /**
   * 'screen' (the default) holds the speed the content crosses the VIEW at, so the pan and the
   * zoom finish together and read as one movement. 'world' moves the centre in a straight line
   * through the scene at a steady world-space rate, which crosses the view at a speed that
   * varies by the flight's whole zoom ratio.
   *
   * They are the same line when the zoom does not change; the difference is only in when along
   * it the centre is at each moment.
   */
  pan?: PanSpace
}

export interface CameraTweenSettings extends TweenSettings, CameraDestination {}

/**
 * A view of a camera through a viewport: what has a centre and a zoom, where a camera alone has
 * only a corner and a scale.
 *
 * The camera stays the single source of truth - nothing is cached here between frames - so each
 * write reads the camera, changes one thing about it and puts the rest back. That is what makes
 * the writes ORDER-INDEPENDENT, which matters because a tween writes its attributes in whatever
 * order they were named: changing the zoom holds the centre, and changing the centre uses
 * whatever the zoom now is, so the frame lands in the same place either way round.
 */
class CameraView implements TweenTarget {
  readonly nodeName = 'Camera2D'
  /** Re-read every frame, so a canvas that resizes mid-flight does not animate to a stale size. */
  viewport: () => Viewport

  constructor(
    private readonly camera: Camera2D,
    viewport: ViewportSource,
  ) {
    this.viewport = viewportGetter(viewport)
  }

  attributeNames(): readonly string[] {
    return ['centerX', 'centerY', 'zoomExponent', 'rotation']
  }

  getAttr(key: string): unknown {
    const { width, height } = this.viewport()
    switch (key) {
      case 'centerX':
        return this.camera.center(width, height).x
      case 'centerY':
        return this.camera.center(width, height).y
      case 'zoomExponent':
        return Math.log2(Math.max(ZOOM_FLOOR, this.camera.zoom))
      case 'rotation':
        return this.camera.rotation
      default:
        return undefined
    }
  }

  setAttr(key: string, value: unknown): this {
    const { width, height } = this.viewport()
    const centre = this.camera.center(width, height)
    switch (key) {
      case 'centerX':
        this.camera.centerOn(value as number, centre.y, width, height)
        break
      case 'centerY':
        this.camera.centerOn(centre.x, value as number, width, height)
        break
      case 'zoomExponent':
        // Two raised to anything is positive, so this path cannot produce a zoom the projection
        // has to defend itself against - which a linear tween through an overshooting curve can.
        this.camera.zoom = 2 ** (value as number)
        this.camera.centerOn(centre.x, centre.y, width, height)
        break
      case 'rotation':
        // Turns about the view centre, so there is nothing to put back.
        this.camera.rotation = value as number
        break
    }
    return this
  }
}

/**
 * One view per camera.
 *
 * Attribute ownership is per target object (see Tween), so this is what makes a second flight
 * take the view off the first rather than the two fighting for the camera every frame. The
 * viewport source is replaced by each call, since a camera is looked at through one viewport at
 * a time and the newest caller is the one that knows which.
 */
const views = new WeakMap<Camera2D, CameraView>()

/**
 * The newest flight for each camera.
 *
 * A screen-uniform pan places the centre from a handler rather than through a tracked
 * attribute, so nothing in the tween machinery can take it away from an older flight the way it
 * takes a tracked attribute. This is what does: an older flight checks whether it is still the
 * one and stops placing the centre when it is not.
 */
const flights = new WeakMap<Camera2D, Tween<TweenTarget>>()

function viewFor(camera: Camera2D, viewport: ViewportSource): CameraView {
  const existing = views.get(camera)
  if (existing) {
    existing.viewport = viewportGetter(viewport)
    return existing
  }
  const view = new CameraView(camera, viewport)
  views.set(camera, view)
  return view
}

function viewportGetter(viewport: ViewportSource): () => Viewport {
  return typeof viewport === 'function' ? viewport : () => viewport
}

/**
 * A tween that moves the view - its centre, its zoom, its rotation. Play it to start it.
 *
 * ```ts
 * cameraTween(camera, viewport, { center: { x: 400, y: 300 }, zoom: 4, duration: 0.8 }).play()
 * cameraTween(camera, viewport, { ...viewForBounds(node.getClientRect(), viewport, 40) }).play()
 * ```
 *
 * The result is an ordinary Tween, so it pauses, reverses, seeks and reports onFinish like any
 * other, and a second one on the same camera takes the view off the first.
 *
 * `viewport` is the CSS size the scene is drawn at - `{ width: canvas.clientWidth, height:
 * canvas.clientHeight }` - or a function returning it, which is what a canvas that can resize
 * mid-flight wants. A camera has no idea what it is being drawn into, and a centre is
 * meaningless without one.
 */
export function cameraTween(camera: Camera2D, viewport: ViewportSource, settings: CameraTweenSettings): Tween<TweenTarget> {
  const { center, zoom, rotation, pan = 'screen', ...rest } = settings
  const view = viewFor(camera, viewport)

  const endZoom = zoom === undefined ? undefined : Math.max(ZOOM_FLOOR, zoom)
  const attributes: Record<string, unknown> = {}
  if (endZoom !== undefined) attributes.zoomExponent = Math.log2(endZoom)
  if (rotation !== undefined) attributes.rotation = rotation

  // Screen-uniform panning is a curve the zoom draws, so it needs a zoom that actually moves.
  // Without one the two spaces describe the same straight line and the centre is tracked like
  // any other attribute.
  const startZoom = Math.max(ZOOM_FLOOR, camera.zoom)
  const follow =
    center !== undefined && endZoom !== undefined && pan === 'screen' && !nearlyEqual(1 / startZoom, 1 / endZoom)

  if (center !== undefined && !follow) {
    attributes.centerX = center.x
    attributes.centerY = center.y
  }

  const tween = new Tween<TweenTarget>({ ...rest, ...attributes, node: view })
  // Recorded whether or not this flight pans, so that the NEXT one displaces it either way.
  flights.set(camera, tween)
  if (!follow || center === undefined) return tween

  // The centre is placed from wherever the zoom has got to, rather than tracked against time.
  // Read once, like every other end of a tween - see Tween's header.
  const size = view.viewport
  const from = camera.center(size().width, size().height)
  const w0 = 1 / startZoom
  const span = 1 / (endZoom as number) - w0

  const carry = rest.onUpdate
  tween.onUpdate = function () {
    // Gated on still being the newest flight, which is what attribute ownership does for a
    // tracked attribute and has to be done by hand for one that is derived.
    if (flights.get(camera) === tween) {
      const progress = (1 / Math.max(ZOOM_FLOOR, camera.zoom) - w0) / span
      const { width, height } = size()
      camera.centerOn(from.x + (center.x - from.x) * progress, from.y + (center.y - from.y) * progress, width, height)
    }
    carry?.call(this)
  }
  return tween
}

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1)
}

/**
 * The centre and zoom that frame a world box in a viewport - "zoom to fit", as a destination
 * rather than as an action.
 *
 * ```ts
 * cameraTween(camera, viewport, { ...viewForBounds(box, viewport, 40), duration: 0.8 }).play()
 * ```
 *
 * `padding` is in viewport pixels, left on every side. The zoom is whichever axis is tighter, and
 * is UNBOUNDED: framing a box a few units across asks for a zoom of several hundred, which is
 * arithmetically right and rarely what an editor wants, so clamp it where a maximum belongs to
 * the application - `Math.min(view.zoom ?? 1, 8)`.
 *
 * A box with no extent - a single point - names no scale, so `zoom` comes back undefined and the
 * tween moves the centre alone.
 */
export function viewForBounds(
  bounds: AABB | { x: number; y: number; width: number; height: number },
  viewport: Viewport,
  padding = 0,
): { center: Vector2Like; zoom?: number } {
  const box =
    'min' in bounds ?
      {
        x: bounds.min.x,
        y: bounds.min.y,
        width: bounds.max.x - bounds.min.x,
        height: bounds.max.y - bounds.min.y,
      }
    : bounds

  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const available = { width: Math.max(1, viewport.width - 2 * padding), height: Math.max(1, viewport.height - 2 * padding) }

  const limits: number[] = []
  if (box.width > 0) limits.push(available.width / box.width)
  if (box.height > 0) limits.push(available.height / box.height)
  return limits.length > 0 ? { center, zoom: Math.min(...limits) } : { center }
}

/**
 * A tween that changes the zoom while holding the world point under a viewport pixel exactly
 * where it is - "zoom toward the cursor", animated. Play it to start it.
 *
 * ```ts
 * zoomCameraAbout(camera, viewport, event.offsetX, event.offsetY, camera.zoom * 2, {
 *   duration: 0.25,
 *   easing: Easings.EaseOut,
 * }).play()
 * ```
 *
 * The anchor is read ONCE, when the tween is built, and every frame puts that same world point
 * back under that same pixel - the rule the pointer gestures follow, and for the same reason
 * (see input/cameraControls.ts). Re-reading it each frame would measure each correction from the
 * previous frame's rounding, and the content would creep out from under the cursor.
 *
 * Only the zoom is tweened; the centre is wherever holding the anchor puts it, which is a curve
 * rather than the straight line cameraTween would draw between the two ends.
 */
export function zoomCameraAbout(
  camera: Camera2D,
  viewport: ViewportSource,
  screenX: number,
  screenY: number,
  zoom: number,
  settings: TweenSettings = {},
): Tween<TweenTarget> {
  const size = viewportGetter(viewport)
  const anchor = screenToWorld(camera, screenX, screenY, size())
  const tween = cameraTween(camera, viewport, { ...settings, zoom })
  if (!anchor) return tween

  // After the zoom is written, not instead of it: the view target holds the CENTRE across a zoom
  // change, and this moves it to whatever holding the anchor instead requires.
  const carry = settings.onUpdate
  tween.onUpdate = function () {
    panToAnchor(camera, size(), screenX, screenY, anchor)
    carry?.call(this)
  }
  return tween
}
