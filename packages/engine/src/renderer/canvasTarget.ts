// Where the picture goes - said in whichever form the application already has to hand.
//
// A renderer needs exactly one thing before it can start: a canvas element. Getting hold of
// one is not interesting work, and every host was writing the same three lines to do it -
// query the document, assert the type, hope the element exists. So this takes the four forms
// the answer actually comes in and returns the canvas:
//
//   an HTMLCanvasElement   use it as it is. The form a framework host already has, from a
//                          ref or a callback, and the one every other case reduces to.
//   a CSS selector string  '#board', 'canvas', '.stage > canvas' - resolved against the
//                          document. A selector naming a canvas uses it; one naming anything
//                          else treats that element as the CONTAINER and builds a canvas
//                          inside it, sized to fill it. That is what lets the page decide the
//                          size in CSS, which is where a page's layout belongs.
//   any other element      the same container case, for a host holding the element rather
//                          than a selector for it.
//   null (or nothing)      no page furniture at all: a canvas is created over the whole
//                          viewport. For a sketch, a test page, a demo - the case where
//                          writing the HTML first is the only thing standing between an idea
//                          and seeing it drawn.
//
// A created canvas is `display: block` because an inline element sits on a text baseline and
// leaves a few stubborn pixels below itself, which reads as a mysterious scrollbar. Its size
// is CSS, never width/height attributes: the backing store is the CanvasResizer's business
// (device pixel ratio, resize observation), and setting the attributes here would fight it.
//
// Nothing about this is required - passing a canvas is still the honest, explicit thing to
// do, and is what a React or Vue host will keep doing.

/** Anything createSceneRenderer() will accept as "draw here". See resolveCanvas(). */
export type CanvasTarget = HTMLCanvasElement | HTMLElement | string | null | undefined

/**
 * The canvases this module built, so a renderer can take its own back out of the document
 * when it is destroyed - see engineOwnsCanvas().
 *
 * A WeakSet rather than a Set: membership must not be a reason for a canvas to stay alive.
 * A page that builds and tears down renderers would otherwise accumulate a dead element per
 * cycle here, which is the exact leak the flag exists to prevent.
 */
const built = new WeakSet<HTMLCanvasElement>()

/**
 * Whether this canvas was created by resolveCanvas() rather than supplied by the caller.
 *
 * It decides who cleans up. A canvas the application passed in belongs to the application and
 * is left exactly as it was; one the engine created has no other reference anywhere, so
 * leaving it in the document on destroy would strand an element - and the GPU context bound
 * to it - with nothing able to reach either again.
 */
export function engineOwnsCanvas(canvas: HTMLCanvasElement): boolean {
  return built.has(canvas)
}

/** The part of `document` this needs - so a canvas can be built in another one (see below). */
interface DocumentLike {
  querySelector(selectors: string): Element | null
  createElement(tagName: string): HTMLElement
  readonly body: HTMLElement | null
}

/** Duck-typed rather than `instanceof`: an element from another document or an iframe is
 *  still a canvas, and its constructor is a different HTMLCanvasElement than this realm's. */
function isCanvas(value: object): value is HTMLCanvasElement {
  return (value as Element).tagName === 'CANVAS'
}

function isElement(value: unknown): value is HTMLElement {
  return typeof value === 'object' && value !== null && typeof (value as Element).tagName === 'string'
}

/**
 * The canvas a target names, creating one where the target names a place rather than an
 * element. See CanvasTarget above for the four forms.
 *
 * `doc` is the document to resolve and create in, defaulting to the ambient one. Pass it for
 * a canvas that lives in an iframe or a popped-out window, whose `document` is not this one.
 *
 * Throws with a sentence naming the problem - a selector that matched nothing, or no document
 * at all (a server render) - rather than returning null for the renderer to fall over on
 * later.
 */
export function resolveCanvas(target?: CanvasTarget, doc?: DocumentLike): HTMLCanvasElement {
  if (isElement(target) && isCanvas(target)) return target

  const owner = doc ?? (typeof document === 'undefined' ? null : (document as unknown as DocumentLike))
  if (!owner) {
    throw new Error(
      'There is no document to draw in. Pass an HTMLCanvasElement, or run this where a DOM exists.',
    )
  }

  if (typeof target === 'string') {
    const found = owner.querySelector(target)
    if (!found) throw new Error(`No element matches the selector ${JSON.stringify(target)}.`)
    if (isCanvas(found)) return found
    return appendCanvas(owner, found as HTMLElement)
  }

  if (isElement(target)) return appendCanvas(owner, target)

  // No target at all: cover the viewport, so a page with no CSS still shows a full window of
  // scene rather than a zero-height element that draws nothing and explains nothing.
  const body = owner.body
  if (!body) throw new Error('The document has no <body> to put a canvas in.')
  const canvas = appendCanvas(owner, body)
  canvas.style.position = 'fixed'
  canvas.style.left = '0'
  canvas.style.top = '0'
  return canvas
}

/** A canvas filling `parent`, whose own size the page's CSS decides. */
function appendCanvas(owner: DocumentLike, parent: HTMLElement): HTMLCanvasElement {
  const canvas = owner.createElement('canvas') as HTMLCanvasElement
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  parent.appendChild(canvas)
  built.add(canvas)
  return canvas
}
