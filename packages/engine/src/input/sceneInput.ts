// The bindings themselves: what a drag, a wheel notch, a pinch, a press and a key actually
// DO, once an application has said which of them it wants (see inputOptions.ts).
//
// Everything here used to live in the host application, and the split it sat on was a real
// one: SceneInputDispatcher reports what a pointer did, and something above it decides what
// that means. That split has not moved - the dispatcher still decides nothing, and every
// binding below still goes through its public events. What has changed is who writes the
// obvious answer. "A wheel notch zooms about the cursor", "a press selects what it landed
// on", "ctrl-drag pans" are not choices most applications want to make; they are the ones
// every canvas application makes identically, and having each of them write two hundred lines
// to arrive there was a tax on starting, not a freedom.
//
// So this is the default policy, in the engine, switched on by name. It is built entirely out
// of the public parts - the dispatcher's events, MarqueeTool, Transformer, panToAnchor and
// zoomAbout - so an application that wants different answers turns the preset off and writes
// its own with exactly the same materials, which is what the example app did before this
// existed and what a serious editor will do again the day its needs diverge.
//
// WHAT A PRESS MEANS, in the 'editor' set, in the order the dispatcher resolves it:
//
//   a transformer handle   resize or rotate the framed set. Nothing else sees the press.
//   a node                 select it (shift extends the selection), and drag it. A press
//                          inside a Group takes the group, unless groupsAsUnits is off.
//   empty space            pull out a rubber band; what it covers becomes the selection. A
//                          click that covered nothing clears it.
//   with ctrl/meta/space   the view instead of the content, wherever it lands.
//
// In the 'view' set there is nothing to grab, so a plain drag pans and a press reports empty
// space - the engine hands the dispatcher a hit-test that always answers null, so a view is
// not a scene with its policy removed but one that never asks the question.
//
// The selection lives IN the Transformer: what is framed is what is selected. A larger editor
// usually keeps its own list (rows in a panel, a locked layer) and pushes a subset here, which
// is why nothing in the engine calls the attached set "the selection" except this file, whose
// whole job is to be the ordinary case.

import type { Vector2, Vector2Like } from '../math/Vector2'
import type { AABB } from '../math/AABB'
import type { Camera2D } from '../camera/Camera2D'
import type { Scene } from '../scene/Scene'
import { Shape } from '../shapes/Shape'
import type { Node } from '../shapes/Node'
import type { PickableNode } from '../scene/picking'
import type { MarqueeEvent, CameraGestureEvent } from '../events/sceneEvents'
import { outermostGroup, type TransformableNode } from '../shapes/Group'
import { Transformer } from '../shapes/Transformer'
import { boxForNodes } from '../shapes/transformerMath'
import { MarqueeOverlay } from './MarqueeOverlay'
import { SceneInputDispatcher } from './SceneInputDispatcher'
import { panToAnchor, zoomAbout } from './cameraControls'
import { screenToWorld, type Viewport } from './viewport'
import { resolveInputOptions, type InputOptions } from './inputOptions'

/**
 * What the bindings need from the renderer - a small enough surface that a test, or a host
 * driving a scene some other way, can supply it without a GPU.
 */
export interface SceneInputHost {
  readonly scene: Scene
  /** Read fresh on every use, so replacing the camera (setCamera) redirects the bindings too. */
  readonly camera: Camera2D
  getZoom(): number
  pick(screenX: number, screenY: number): PickableNode | null
  nodesInBox(from: Vector2Like, to: Vector2Like): Shape[]
  localBoundsOf(node: TransformableNode): AABB
  addFrameListener(listener: (dt: number) => void): () => void
}

/** What an application holds when the engine is handling input for it. */
export interface SceneInput {
  /**
   * The dispatcher underneath. Reach for it to drive input from somewhere other than the
   * canvas (a test, a replay), to hand the view a drag it would otherwise give to content
   * (`grabContent = false`, what a hand tool does), or to start a marquee from a tool of your
   * own.
   */
  readonly dispatcher: SceneInputDispatcher
  /** The selection frame, or null when neither selecting nor transforming was asked for. */
  readonly transformer: Transformer | null
  /** What is currently selected - the set the frame wraps. Empty when nothing is. */
  readonly selection: readonly TransformableNode[]
  /**
   * The nodes this input owns in the scene: the selection frame and the marquee rectangle.
   * They are furniture rather than content, so an application replacing the scene's contents
   * should leave them where they are.
   */
  readonly nodes: readonly Node[]
  /** Frames these nodes, replacing whatever was selected. Also clears, given null or []. */
  select(nodes: readonly TransformableNode[] | TransformableNode | null): void
  clearSelection(): void
  /** Removes every listener, and takes the frame and the rectangle back out of the scene. */
  destroy(): void
}

/** One namespace for every scene listener here, so teardown is a single off(). */
const NS = '.mvpaint-input'

/**
 * The world point a RUN of zoom inputs is aimed at, and everything that has to still be true
 * for the next input to belong to that same run.
 *
 * A wheel notch is not a gesture the way a drag is: there is no press to start it and no
 * release to end it, only a stream of events that either did or did not mean one continuous
 * zoom. So the run is defined by what would make it a different one - see stillAimedAt.
 */
interface ZoomAnchor {
  /**
   * The pixel the anchor was READ at. Kept as the run goes on rather than moved to wherever
   * each later input arrived, so a cursor drifting a pixel at a time cannot walk the anchor
   * across the screen while every individual step stays inside the slack below.
   */
  readonly screenX: number
  readonly screenY: number
  readonly world: Vector2
  /**
   * The camera this binding left behind after the last step, and the viewport it was left in.
   * Anything else that changes what sits under that pixel - a pan, an arrow key, the
   * application's own animation, a fresh camera, a canvas that was resized under a turned
   * view - means the world point above is no longer the one there, and holding it would be a
   * jump rather than the absence of one.
   */
  x: number
  y: number
  zoom: number
  rotation: number
  width: number
  height: number
}

/**
 * How far (CSS px) the cursor may wander mid-run and still count as aimed at the same point.
 * A hand resting on a wheel moves a pixel or two and means nothing by it; moving somewhere
 * else and scrolling again is a new gesture, aimed at whatever is there now. The same figure
 * as the dispatcher's tap threshold, and for the same reason: it is where "did not really
 * move" ends.
 */
const ZOOM_ANCHOR_SLACK = 6

/** Whether the next zoom input is still part of the run this anchor was read for. */
function stillAimedAt(
  held: ZoomAnchor,
  camera: Camera2D,
  view: Viewport,
  screenX: number,
  screenY: number,
): boolean {
  // Exactly equal, not nearly: the question is whether the view is in the state this binding
  // left it in, and any other answer means something else has changed it since.
  return (
    camera.x === held.x &&
    camera.y === held.y &&
    camera.zoom === held.zoom &&
    camera.rotation === held.rotation &&
    view.width === held.width &&
    view.height === held.height &&
    Math.hypot(screenX - held.screenX, screenY - held.screenY) <= ZOOM_ANCHOR_SLACK
  )
}

/**
 * Wires the requested bindings to a canvas and returns the handle to them, or null when the
 * options amount to a static render. Called by the renderer's composition root - an
 * application asks for this through `createSceneRenderer(target, { input: 'editor' })` rather
 * than calling it directly, though calling it directly is a perfectly good way to add input
 * to a renderer that was built without any.
 */
export function attachSceneInput(
  host: SceneInputHost,
  canvas: HTMLCanvasElement,
  options: InputOptions,
): SceneInput | null {
  const resolved = resolveInputOptions(options)
  if (!resolved) return null
  const { camera: cameraInput, objects: objectInput, keyboardTarget } = resolved

  const root = host.scene.root
  const viewport = () => ({ width: canvas.clientWidth, height: canvas.clientHeight })
  const toWorld = (x: number, y: number) => screenToWorld(host.camera, x, y, viewport())

  // --- the furniture ---

  // The frame holds the selection, so it exists for either job. With transforming off it is
  // built without anchors - a border showing what is selected, which cannot be dragged into
  // a resize.
  const transformer =
    objectInput && (objectInput.select || objectInput.transform)
      ? new Transformer({
          ...objectInput.transformer,
          enabledAnchors: objectInput.transform ? objectInput.transformer.enabledAnchors : [],
          rotateEnabled: objectInput.transform ? (objectInput.transformer.rotateEnabled ?? true) : false,
        })
      : null
  if (transformer) root.addChild(transformer)

  const marqueeOverlay =
    objectInput?.marquee && objectInput.marqueeOverlay ? root.addChild(new MarqueeOverlay()) : null

  const dispatcher = new SceneInputDispatcher(canvas, {
    root,
    // A view never asks what is under the pointer. Not a picked result that is then ignored -
    // the question itself is what costs, since a pick walks every shape in the scene.
    pick: objectInput ? (x, y) => host.pick(x, y) : () => null,
    toWorld,
    nodesInBox: objectInput?.marquee ? (from, to) => host.nodesInBox(from, to) : undefined,
    transformer: transformer ?? undefined,
    dragNodes: objectInput?.drag ?? false,
    rotationSnaps: objectInput?.rotationSnaps,
  })

  // --- driving the camera ---

  const clampZoom = (zoom: number) =>
    cameraInput ? Math.min(cameraInput.maxZoom, Math.max(cameraInput.minZoom, zoom)) : zoom

  // ONE ANCHOR PER RUN OF INPUTS, which is the whole of what makes a scroll feel steady.
  //
  // A wheel notch zooms about the world point under the cursor. The notches that follow it -
  // and a trackpad delivers dozens a second - have to zoom about that SAME point, or the view
  // is being re-aimed several times per frame at whatever the last step happened to leave
  // under the cursor. Two things go wrong when each step reads its own anchor:
  //
  //   the arithmetic  each read unprojects through a camera the previous step just wrote, and
  //                   each write is a correction measured from that read, so rounding that
  //                   would have cancelled is fed back in as the next target instead. Over a
  //                   long scroll the content creeps out from under the cursor. See zoomAbout.
  //   the cursor      a hand on a wheel is not still. Re-reading turns every pixel of wobble
  //                   into a re-aim, and at a deep zoom one pixel is a lot of world.
  //
  // So the anchor is read once and held, and every step of the run corrects back to it, at
  // the pixel it was read at. It is dropped when the cursor really travels or when anything
  // other than this zoom moved the view - see stillAimedAt for both.
  //
  // Held across the keyboard's +/- as well as the wheel, since a run of key presses is the
  // same thing arriving through a different door.
  let zoomAnchor: ZoomAnchor | null = null
  const applyZoom = (screenX: number, screenY: number, next: number) => {
    const camera = host.camera
    const view = viewport()
    const held = zoomAnchor
    if (!held || !stillAimedAt(held, camera, view, screenX, screenY)) {
      const world = screenToWorld(camera, screenX, screenY, view)
      const { x, y, zoom, rotation } = camera
      zoomAnchor = world
        ? { screenX, screenY, world, x, y, zoom, rotation, width: view.width, height: view.height }
        : null
    }

    const anchor = zoomAnchor
    if (!anchor) {
      // Nothing under that pixel to hold on to - a camera looking edge-on at the Z=0 plane,
      // which a Camera2D never is. The zoom still applies, about nothing in particular.
      camera.zoom = next > 0 ? next : camera.zoom
      return
    }
    zoomAbout(camera, view, anchor.screenX, anchor.screenY, anchor.world, next)
    anchor.x = camera.x
    anchor.y = camera.y
    anchor.zoom = camera.zoom
    anchor.rotation = camera.rotation
    anchor.width = view.width
    anchor.height = view.height
  }

  if (cameraInput?.pan) {
    root.on(`panmove${NS}`, (event) => {
      const gesture = event as CameraGestureEvent
      panToAnchor(host.camera, viewport(), gesture.point.x, gesture.point.y, gesture.anchor)
    })
  }

  if (cameraInput?.zoom) {
    const sensitivity = cameraInput.wheelSensitivity
    let pinchStartZoom = 1
    root.on(`pinchstart${NS}`, () => {
      pinchStartZoom = host.getZoom()
    })
    root.on(`pinchmove${NS}`, (event) => {
      const gesture = event as CameraGestureEvent
      // A pinch pins the anchor the gesture STARTED on - the dispatcher hands the same one out
      // for every move - rather than whatever is under the midpoint now, so the content follows
      // two fingers spreading apart. Same rule as the wheel above; the dispatcher just has a
      // press and a release to bound the gesture with, so it can hold the anchor itself.
      //
      // Against the zoom the pinch began at, so a spread and a squeeze back cancel exactly.
      zoomAbout(
        host.camera,
        viewport(),
        gesture.point.x,
        gesture.point.y,
        gesture.anchor,
        clampZoom(pinchStartZoom * gesture.scale),
      )
    })
    root.on(`wheel${NS}`, (event) => {
      const raw = event.evt as WheelEvent | undefined
      if (!raw || !event.screen) return
      applyZoom(event.screen.x, event.screen.y, clampZoom(host.getZoom() * Math.exp(-raw.deltaY * sensitivity)))
    })
  }

  // --- what a press means ---

  // A press inside a group takes the group. Which node a press SELECTS is policy - a pick
  // reports the shape that is really there - and this is the ordinary answer, switchable.
  const selectionTarget = (hit: Shape): TransformableNode =>
    (objectInput?.groupsAsUnits ? outermostGroup(hit) : null) ?? hit

  if (transformer && objectInput?.select) {
    // On the press rather than the click, so dragging a shape picks it up immediately.
    root.on(`pointerdown${NS}`, (event) => {
      const hit = event.target
      if (hit === root || !(hit instanceof Shape)) return
      const target = selectionTarget(hit)
      if ((event.evt as PointerEvent | undefined)?.shiftKey) transformer.add(target)
      else if (!transformer.has(target)) transformer.attach([target])
    })

    // A click that hit nothing clears the selection; with shift held it leaves it alone,
    // because shift means "and also" everywhere else in this file.
    root.on(`click${NS} tap${NS}`, (event) => {
      if (event.target !== root) return
      if (!(event.evt as PointerEvent | undefined)?.shiftKey) transformer.clear()
    })
  }

  // --- the rubber band ---

  let marqueeAdds = false
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  const cancelHold = () => {
    if (holdTimer !== null) clearTimeout(holdTimer)
    holdTimer = null
  }
  // Moving before the hold fires means a pan was meant, not a rectangle.
  //
  // Listened for on the CANVAS rather than on the scene root, because this asks only whether
  // the finger moved - never what it moved over. A scene 'pointermove' is a hover-class event,
  // so registering one anywhere makes the dispatcher resolve a hover target on every single
  // move, and resolving one means hit-testing the whole scene (see hoverIsIdle). Paying for an
  // answer this handler does not even read would be a tax on every scene in the application.
  const cancelHoldOnMove = () => {
    if (holdTimer !== null && !dispatcher.marquee.active) cancelHold()
  }

  if (objectInput?.marquee) {
    root.on(`pointerdown${NS}`, (event) => {
      // Only a press that reached the root itself landed on empty space; anything over a
      // shape has that shape as its target.
      if (event.target !== root || !event.world) return
      // Not while the press is asking for the VIEW - ctrl or space held. Without this the
      // rectangle starts anyway and suppresses the pan it was meant to make way for (see
      // SceneInputDispatcher.updateGesture).
      if (!dispatcher.grabContent) return
      marqueeAdds = (event.evt as PointerEvent | undefined)?.shiftKey ?? false

      if ((event.evt as PointerEvent | undefined)?.pointerType === 'touch') {
        // A finger has no spare button, so a bare drag keeps panning and a held finger is
        // what asks for a rectangle instead.
        const world = event.world
        cancelHold()
        holdTimer = setTimeout(() => {
          holdTimer = null
          if (typeof navigator !== 'undefined') navigator.vibrate?.(12)
          dispatcher.beginMarquee(world)
        }, objectInput.touchHoldDelay)
      } else {
        dispatcher.beginMarquee(event.world)
      }
    })
    canvas.addEventListener('pointermove', cancelHoldOnMove)
    root.on(`pointerup${NS} pointercancel${NS}`, cancelHold)

    if (marqueeOverlay) {
      // No markGeometryDirty() on any of it - every marquee part is a permanent, unit-quad
      // slot in the mesh batcher (see MarqueeOverlay), so pulling one out never changes the
      // batcher's shape set.
      root.on(`marqueestart${NS} marqueemove${NS}`, (event) => {
        const { from, to } = event as MarqueeEvent
        marqueeOverlay.update({ from, to }, host.getZoom())
      })
    }

    root.on(`marqueeend${NS}`, (event) => {
      marqueeOverlay?.update(null, host.getZoom())
      if (!transformer || !objectInput.select) return
      const covered = ((event as MarqueeEvent).nodes ?? []) as Shape[]
      if (covered.length === 0 && !marqueeAdds) return
      // Same rule as a press: a rectangle that catches part of a group has caught the group.
      // Deduplicated, since several members map to the same one.
      const targets = [...new Set(covered.map(selectionTarget))]
      if (marqueeAdds) for (const node of targets) transformer.add(node)
      else transformer.attach(targets)
    })
  }

  // --- the keyboard, and the two ways to ask for the view instead of the content ---

  const previousCursor = canvas.style.cursor
  let spaceHeld = false
  let viewKeyHeld = false
  const refreshGrab = () => {
    const grab = !(spaceHeld || viewKeyHeld)
    if (dispatcher.grabContent === grab) return
    dispatcher.grabContent = grab
    canvas.style.cursor = grab ? previousCursor : 'grab'
  }

  // The press itself is what decides, not a remembered keystroke: a keyup that arrives while
  // another window has focus is never seen, and a modifier believed held forever would leave
  // the canvas unable to select anything. Capture phase, so this has already run by the time
  // the canvas's own pointerdown listener resolves the press. Meta as well as Control, so the
  // Mac chord is the one Mac users expect.
  //
  // Only where there is content to grab: in a view every drag pans already.
  const grabModifiers = Boolean(objectInput && cameraInput?.pan)
  const onPointerDownCapture = (event: PointerEvent) => {
    viewKeyHeld = event.ctrlKey || event.metaKey
    refreshGrab()
  }

  const wantsKeys = Boolean(cameraInput?.keyboard || (transformer && objectInput?.select))
  const onKeyDown = (event: KeyboardEvent) => {
    if (isEditing(keyboardTarget)) return
    if (event.key === 'Escape' && transformer && objectInput?.select) {
      transformer.clear()
      return
    }
    if (!cameraInput?.keyboard) return
    if (event.key === ' ' && grabModifiers) {
      spaceHeld = true
      refreshGrab()
      event.preventDefault()
      return
    }
    // Only for the cursor: the press above is what actually decides.
    if (event.key === 'Control' || event.key === 'Meta') {
      if (!grabModifiers) return
      viewKeyHeld = true
      refreshGrab()
      return
    }

    const view = viewport()
    const centre = { x: view.width / 2, y: view.height / 2 }
    // A fixed number of SCREEN pixels per press, so a key-pan feels the same however far the
    // view is zoomed in.
    const step = cameraInput.keyPanStep / Math.max(1e-6, host.camera.zoom)
    // Each key moves the view the way it points. The scene is y-down, so moving the view UP is
    // a smaller camera y - camera.y is the top edge of what is on screen (see Camera2D).
    switch (event.key) {
      case 'ArrowLeft': if (!cameraInput.pan) return; host.camera.x -= step; break
      case 'ArrowRight': if (!cameraInput.pan) return; host.camera.x += step; break
      case 'ArrowUp': if (!cameraInput.pan) return; host.camera.y -= step; break
      case 'ArrowDown': if (!cameraInput.pan) return; host.camera.y += step; break
      case '+':
      case '=': if (!cameraInput.zoom) return; applyZoom(centre.x, centre.y, clampZoom(host.getZoom() * cameraInput.keyZoomStep)); break
      case '-':
      case '_': if (!cameraInput.zoom) return; applyZoom(centre.x, centre.y, clampZoom(host.getZoom() / cameraInput.keyZoomStep)); break
      default: return
    }
    event.preventDefault()
  }
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === ' ') spaceHeld = false
    else if (event.key === 'Control' || event.key === 'Meta') viewKeyHeld = false
    else return
    refreshGrab()
  }

  if (keyboardTarget && wantsKeys) {
    keyboardTarget.addEventListener('keydown', onKeyDown)
    keyboardTarget.addEventListener('keyup', onKeyUp)
  }
  if (keyboardTarget && grabModifiers) {
    keyboardTarget.addEventListener('pointerdown', onPointerDownCapture, { capture: true })
  }

  // --- per frame: the frame follows what it wraps ---
  //
  // Once a frame, after the application's own onFrame, because the selection may have been
  // moved by a drag, spun by an animation, or not touched at all - one code path for all
  // three. It is also the only thing here that costs anything per frame, which is why it is
  // registered only when there is a frame to fit.
  const stopFrames = transformer
    ? host.addFrameListener(() => {
        const selection = transformer.nodes
        const box = selection.length > 0 ? boxForNodes(selection, (node) => host.localBoundsOf(node)) : null
        transformer.update(box, host.getZoom())
      })
    : null

  return {
    dispatcher,
    transformer,
    get selection() {
      return transformer?.nodes ?? []
    },
    get nodes() {
      const furniture: Node[] = []
      if (transformer) furniture.push(transformer)
      if (marqueeOverlay) furniture.push(marqueeOverlay)
      return furniture
    },
    select(nodes) {
      if (!transformer) return
      if (nodes === null) transformer.attach([])
      else if (Array.isArray(nodes)) transformer.attach(nodes as readonly TransformableNode[])
      else transformer.attach([nodes as TransformableNode])
    },
    clearSelection() {
      transformer?.clear()
    },
    destroy() {
      cancelHold()
      stopFrames?.()
      root.off(NS)
      canvas.removeEventListener('pointermove', cancelHoldOnMove)
      if (keyboardTarget) {
        keyboardTarget.removeEventListener('keydown', onKeyDown)
        keyboardTarget.removeEventListener('keyup', onKeyUp)
        keyboardTarget.removeEventListener('pointerdown', onPointerDownCapture, { capture: true })
      }
      dispatcher.destroy()
      // DESTROYED, not merely removed. Two things outlive a removal: the frame goes on
      // holding whatever was selected - which is a reference to application content, and
      // through its parents to the whole scene - and any listener an application put on it
      // stays counted in the global census (events/listenerCensus.ts), which reads high and
      // never comes down again, so every torn-down renderer would leave the scene paying to
      // dispatch an event type nothing is listening for. destroy() drops both.
      transformer?.clear()
      transformer?.destroy()
      marqueeOverlay?.destroy()
      canvas.style.cursor = previousCursor
    },
  }
}

/**
 * Whether the keystroke belongs to something being typed into, in which case the canvas keeps
 * its hands off it. Asked of the document the keyboard target belongs to, so a canvas hosted
 * in an iframe answers about ITS document rather than the top one.
 */
function isEditing(target: unknown): boolean {
  const doc = documentOf(target)
  const el = doc?.activeElement as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}

function documentOf(target: unknown): Document | null {
  const owner = (target as { document?: Document } | null)?.document
  if (owner) return owner
  return typeof document === 'undefined' ? null : document
}
