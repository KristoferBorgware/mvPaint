// What "handle input" is allowed to mean - the vocabulary, and its defaults.
//
// Input is OPT-IN. A renderer given no `input` option listens to nothing at all: no pointer
// listeners on the canvas, no keys on the window, no hit-testing, and not one scene event
// raised. That is a real mode, not an unfinished one - a chart, a thumbnail, a background, a
// print preview. The camera is still an ordinary object the application can move whenever it
// likes, so "static" means nothing REACTS to a pointer, not that nothing moves.
//
// Past that there are two kinds of interaction, and they are separate because applications
// genuinely want one without the other:
//
//   camera   the view. Drag to pan, wheel and pinch to zoom, arrows and +/- from the
//            keyboard. Touches nothing in the scene.
//   objects  the content. Hit-testing, hover and click events on nodes, dragging them,
//            selecting them, the resize/rotate frame, the rubber band.
//
// 'view' is camera alone: the reader's set. Nothing is ever picked - the engine hands the
// dispatcher a hit-test that always answers "empty space" rather than one it politely ignores
// the result of - so a pointer move over a hundred thousand shapes costs nothing, and no
// listener anywhere can accidentally reach a node the host did not mean to expose.
//
// 'editor' is both: the author's set.
//
// The object form is for everything in between, and can turn individual behaviours off:
// { objects: { drag: false } } picks and selects but never moves anything;
// { camera: { zoom: false } } pans a fixed-scale view. Each field's default is the behaviour
// its preset would have given, so an option object only ever states what differs.

import type { TransformerOptions } from '../shapes/Transformer'

/** The two ready-made sets. See the header: 'view' is the camera alone, 'editor' is both. */
export type InputPreset = 'view' | 'editor'

/**
 * The bits of an event target this needs. Written as METHODS rather than function-typed
 * properties on purpose: methods compare bivariantly, which is what lets `window` - whose
 * listeners are typed against the DOM's own Event - satisfy it.
 */
export interface InputEventHost {
  addEventListener(type: string, handler: (event: never) => void, options?: { capture?: boolean }): void
  removeEventListener(type: string, handler: (event: never) => void, options?: { capture?: boolean }): void
}

/** Driving the view. Every field defaults to the behaviour both presets give it. */
export interface CameraInputOptions {
  /** Dragging moves the view - always in 'view', and with ctrl/space held in 'editor'. Default true. */
  pan?: boolean
  /** Wheel and pinch zoom, about the pointer rather than the corner. Default true. */
  zoom?: boolean
  /** Arrows pan, +/- zoom, space grabs the view. Default true. */
  keyboard?: boolean
  /** How far the view may zoom out. Default 0.05. */
  minZoom?: number
  /** How far it may zoom in. Default 10. */
  maxZoom?: number
  /** Zoom per pixel of wheel delta, exponentially. Default 0.002 - about 18% per notch. */
  wheelSensitivity?: number
  /** Zoom factor per +/- press. Default 1.2. */
  keyZoomStep?: number
  /** Screen pixels per arrow press, so a key-pan feels the same at any zoom. Default 40. */
  keyPanStep?: number
}

/** Working on the content. Every field defaults to what 'editor' gives it. */
export interface ObjectInputOptions {
  /** Pressing a node and dragging moves it. Default true. */
  drag?: boolean
  /**
   * Pressing selects, shift extends, a click on empty space clears - and the selection is
   * what the frame wraps. Default true. Off leaves node events, hover and dragging intact,
   * and leaves the frame to be driven from code (`input.select(...)`) by an application that
   * decides for itself what a press means.
   */
  select?: boolean
  /** The resize/rotate frame around the selection. Default true. */
  transform?: boolean
  /** Dragging out a rectangle over empty space selects what it covers. Default true. */
  marquee?: boolean
  /** Draw that rectangle. Default true - off leaves the gesture, for a host drawing its own. */
  marqueeOverlay?: boolean
  /**
   * A press inside a Group selects the whole group rather than the shape it landed on.
   * Default true, which is what makes a group feel like one object; off lets a press reach
   * the shape actually under it.
   */
  groupsAsUnits?: boolean
  /** How long a finger must rest before it pulls a rectangle instead of panning (ms). Default 450. */
  touchHoldDelay?: number
  /** Angles (degrees) a rotate drag settles onto. Default: every 45. */
  rotationSnaps?: readonly number[]
  /** Passed to the Transformer the engine builds - colours, anchor size, keepRatio. */
  transformer?: TransformerOptions
}

/** The long form: which halves, and where the keyboard is heard. */
export interface SceneInputOptions {
  /** true (the default) for the standard camera bindings, false for none, or an object to tune them. */
  camera?: boolean | CameraInputOptions
  /** true for the full editor set, false (the default) for a view, or an object to tune it. */
  objects?: boolean | ObjectInputOptions
  /**
   * Where key events are listened for. Defaults to the window; null turns the keyboard off
   * entirely, which is what an application embedding the canvas in a larger page - where
   * space and the arrow keys already mean something - will want.
   */
  keyboardTarget?: InputEventHost | null
}

/**
 * What `createSceneRenderer`'s `input` option takes: a preset, a switch, or the long form.
 * Omitted, null or false is a static render.
 */
export type InputOptions = InputPreset | boolean | SceneInputOptions | null | undefined

const DEFAULT_CAMERA: Required<CameraInputOptions> = {
  pan: true,
  zoom: true,
  keyboard: true,
  minZoom: 0.05,
  maxZoom: 10,
  wheelSensitivity: 0.002,
  keyZoomStep: 1.2,
  keyPanStep: 40,
}

/** The 45-degree marks, which is what makes it possible to get something upright by hand. */
const DEFAULT_ROTATION_SNAPS: readonly number[] = [0, 45, 90, 135, 180, 225, 270, 315]

const DEFAULT_OBJECTS: Required<Omit<ObjectInputOptions, 'transformer'>> & { transformer: TransformerOptions } = {
  drag: true,
  select: true,
  transform: true,
  marquee: true,
  marqueeOverlay: true,
  groupsAsUnits: true,
  touchHoldDelay: 450,
  rotationSnaps: DEFAULT_ROTATION_SNAPS,
  transformer: {},
}

export type ResolvedCameraInput = Required<CameraInputOptions>
export type ResolvedObjectInput = typeof DEFAULT_OBJECTS

/** Both halves settled, with every default filled in. */
export interface ResolvedInputOptions {
  camera: ResolvedCameraInput | null
  objects: ResolvedObjectInput | null
  keyboardTarget: InputEventHost | null
}

/** The window, when there is one - the default place to hear keys. */
function ambientKeyboardTarget(): InputEventHost | null {
  return typeof window === 'undefined' ? null : (window as unknown as InputEventHost)
}

/**
 * Settles the option into the two halves, or null for a static render.
 *
 * Pure, and the whole of the vocabulary's meaning: what a preset expands to, what each
 * default is, and which combinations amount to no input at all - a camera half and an object
 * half both switched off is a static render however it was asked for.
 */
export function resolveInputOptions(input: InputOptions): ResolvedInputOptions | null {
  if (input === undefined || input === null || input === false) return null

  const spec: SceneInputOptions =
    input === true || input === 'editor'
      ? { camera: true, objects: true }
      : input === 'view'
        ? { camera: true, objects: false }
        : input

  const camera = resolveHalf(spec.camera ?? true, DEFAULT_CAMERA)
  const objects = resolveHalf(spec.objects ?? false, DEFAULT_OBJECTS)
  if (!camera && !objects) return null

  return {
    camera,
    objects,
    keyboardTarget: spec.keyboardTarget === undefined ? ambientKeyboardTarget() : spec.keyboardTarget,
  }
}

/** true -> the defaults, false -> off, an object -> the defaults with its fields over them. */
function resolveHalf<T extends object>(value: boolean | Partial<T>, defaults: T): T | null {
  if (value === false) return null
  if (value === true) return { ...defaults }
  return { ...defaults, ...stripUndefined(value) }
}

/** So `{ zoom: undefined }` means "unstated" rather than "off" - what a spread would do. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key as keyof T] = entry as T[keyof T]
  }
  return out
}
