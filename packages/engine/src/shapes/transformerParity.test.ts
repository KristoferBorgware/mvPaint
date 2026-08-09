// What the Transformer exposes and how its handles behave, measured against Konva's
// Transformer - the reference this engine's manipulation frame is shaped after, so that an
// application ported from one to the other finds the same attributes meaning the same things.
// Run with:
//   npx vitest run packages/engine/src/shapes/transformerParity.test.ts
//
// The frame and the gesture are one story and are tested together here, even though they live
// in two modules: what `keepRatio` means is only observable by dragging a corner, and what
// `enabledAnchors` means is only observable by asking what can be grabbed. The dispatcher is
// driven through a stub canvas - no DOM, no GPU.
//
// Where this engine diverges from Konva on purpose, the divergence is asserted too, so that a
// deliberate difference reads as a decision rather than as a gap: anchors are sized in screen
// pixels, `detach` takes an optional node, and drag/transform events carry the whole set.

import { expect, it } from 'vitest'
import { Container } from './Container'
import { Rect, type RectOptions } from './Rect'
import { Transformer, type TransformerOptions } from './Transformer'
import { Vector2 } from '../math/Vector2'
import { degToRad } from '../math/angle'
import { SceneInputDispatcher } from '../input/SceneInputDispatcher'
import { resetListenerCensus } from '../events/listenerCensus'
import { boxForNodes, type OrientedBox } from './transformerMath'
import type { Shape } from './Shape'
import type { TransformableNode } from './Group'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps

/** A Rect centred on its own position, so the box around it is the box around (x, y). */
const centredRect = (options: RectOptions = {}): Rect =>
  new Rect({ ...options, offsetX: (options.width ?? 1) / 2, offsetY: (options.height ?? 1) / 2 })

/**
 * A scene with a frame around some rects, and the two things a test does to it: drive pointer
 * events, and re-fit the frame the way a renderer would once a frame.
 *
 * `padding` is zeroed by default so a handle sits exactly on the box corner and a test can
 * name the world point it presses without arithmetic.
 */
function harness(options: TransformerOptions = {}, sizes: readonly { x: number; y: number; rotation?: number }[] = [{ x: 0, y: 0 }]) {
  const listeners = new Map<string, ((e: never) => void)[]>()
  const canvas = {
    addEventListener: (type: string, fn: (e: never) => void) =>
      listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type: string, fn: (e: never) => void) =>
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== fn)),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    clientWidth: 800,
    clientHeight: 600,
    style: { cursor: '', touchAction: '' },
  }

  const root = new Container()
  const rects = sizes.map((at) =>
    root.addChild(centredRect({ x: at.x, y: at.y, rotation: at.rotation ?? 0, width: 100, height: 100 })),
  )
  const transformer = new Transformer({ padding: 0, ...options })
  root.addChild(transformer)
  transformer.attach(rects)

  // What a press away from the handles lands on. Empty until a test says otherwise, so the
  // gesture tests below are never competing with a node drag.
  let pickTarget: Shape | null = null
  const dispatcher = new SceneInputDispatcher(canvas as unknown as HTMLCanvasElement, {
    root,
    pick: () => pickTarget,
    toWorld: (x, y) => new Vector2(x, y),
    transformer,
  })

  /** One frame of the renderer's per-frame refit - see sceneInput's frame listener. */
  const fit = (): OrientedBox | null => {
    const box = boxForNodes(
      transformer.nodes,
      (node) => (node as Rect).localBounds(),
      transformer.fitRotation(),
    )
    transformer.update(box, 1)
    return box
  }

  const send = (type: string, x: number, y: number, extra: Record<string, unknown> = {}): void => {
    const event = {
      pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y,
      shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      preventDefault: () => {}, type, ...extra,
    } as never
    for (const handler of [...(listeners.get(type) ?? [])]) handler(event)
  }

  /** A whole handle gesture: press where the handle is, drag to a point, let go. */
  const drag = (from: { x: number; y: number }, to: { x: number; y: number }, modifiers: Record<string, unknown> = {}): void => {
    send('pointerdown', from.x, from.y, modifiers)
    send('pointermove', to.x, to.y, modifiers)
    send('pointerup', to.x, to.y, modifiers)
    fit()
  }

  fit()
  return {
    root, rects, rect: rects[0], transformer, dispatcher, canvas, fit, send, drag,
    setPick: (shape: Shape | null) => {
      pickTarget = shape
    },
  }
}

/** The determinant of a node's own 2x2, whose SIGN is what a mirror changes. */
const isMirrored = (node: Rect): boolean => node.scaleX * node.scaleY < 0

/** One of the frame's own parts, by the name it was built with. */
function partNamed(parent: Container, name: string): Shape {
  let found: Shape | null = null
  parent.traversePreOrder((n) => {
    if ((n as Shape).name === name) found = n as Shape
  })
  return found! as Shape
}

// --- keepRatio and shift ---
//
// Konva's rule is `keepRatio() || shiftKey`: shift ASKS for the lock, so with the lock already
// on - the default, here and there - holding shift changes nothing at all. The tempting
// alternative, letting shift inverting the setting, turns the one gesture every user knows
// (hold shift to scale proportionally) into its opposite on a default-configured frame.

it('keepRatio: shift asks for the aspect lock rather than toggling it', () => {
  const free = harness({ keepRatio: false })
  free.drag({ x: 50, y: 50 }, { x: 150, y: 60 })
  assert(!near(free.rect.scaleX, free.rect.scaleY, 0.05), 'unlocked, a corner scales each axis by its own amount')

  const forced = harness({ keepRatio: false })
  forced.drag({ x: 50, y: 50 }, { x: 150, y: 60 }, { shiftKey: true })
  assert(near(forced.rect.scaleX, forced.rect.scaleY), 'shift locks the ratio on a frame configured without it')

  const locked = harness({ keepRatio: true })
  locked.drag({ x: 50, y: 50 }, { x: 150, y: 60 }, { shiftKey: true })
  assert(near(locked.rect.scaleX, locked.rect.scaleY), 'and holding it on a frame that already locks changes nothing')
})

it('keepRatio applies to corners only, whatever shift says', () => {
  const h = harness({ keepRatio: true })
  h.drag({ x: 50, y: 0 }, { x: 150, y: 0 }, { shiftKey: true })
  assert(near(h.rect.scaleX, 2), 'the middle-right handle scales x')
  assert(near(h.rect.scaleY, 1), 'and leaves y alone - one axis is what an edge handle means')
})

// --- enabledAnchors / resizeEnabled ---
//
// The set is live: what is drawn and what can be grabbed come from the same list, read at the
// moment each is needed. A name added later has a handle to show, and one removed stops being
// grabbable at the instant it stops being visible.

it('enabledAnchors: changing the set moves what is drawn and what is grabbable together', () => {
  const h = harness()
  assert(h.transformer.anchorAt(50, 50) === 'bottom-right', 'every anchor is grabbable to begin with')

  h.transformer.enabledAnchors = ['top-left']
  h.fit()
  assert(h.transformer.anchorAt(50, 50) === null, 'a handle taken out of the set cannot be grabbed')
  assert(near(partNamed(h.transformer, '__transformer-bottom-right').scaleX, 0), 'and is not drawn either')
  assert(h.transformer.anchorAt(-50, -50) === 'top-left', 'the one left in still can be')
  assert(partNamed(h.transformer, '__transformer-top-left').scaleX > 0, 'and is drawn')

  h.transformer.enabledAnchors = ['top-left', 'bottom-right']
  h.fit()
  assert(h.transformer.anchorAt(50, 50) === 'bottom-right', 'a handle put back is grabbable again')
  assert(partNamed(h.transformer, '__transformer-bottom-right').scaleX > 0, 'and drawn again')
})

it('resizeEnabled: false leaves the border and the rotate handle', () => {
  const h = harness({ resizeEnabled: false })
  assert(h.transformer.anchorAt(50, 50) === null, 'no resize handle can be grabbed')
  assert(h.transformer.anchorAt(0, -74) === 'rotate', 'but the rotate handle still can')
  assert(partNamed(h.transformer, '__transformer-top').scaleX > 0, 'and the border is still drawn')
})

// --- the frame's own transform ---
//
// The parts are placed in WORLD coordinates, so anything the frame's own matrix contributed
// would be applied to them twice. localMatrix() is identity for that reason, which leaves
// `rotation` free to mean what it means on a Konva transformer: the angle of the FRAME.

it('rotation: the frame carries its own angle and never applies it twice', () => {
  const h = harness()
  h.transformer.x = 500
  h.transformer.scaleX = 3
  const m = h.transformer.localMatrix().m
  assert(m[0] === 1 && m[5] === 1 && m[12] === 0 && m[13] === 0, 'whatever is written to the frame\'s own transform, it contributes identity')

  h.transformer.rotation = 45
  h.fit()
  assert(near(h.transformer.rotation, 0), 'with one node framed, the frame reports that node\'s angle')
  assert(near(partNamed(h.transformer, '__transformer-top').x, 0), 'and its parts stay on the node')
  assert(near(partNamed(h.transformer, '__transformer-top').y, -50), 'rather than swinging about the scene origin')
})

// Only where the frame holds an angle of its own - a set borrowing its first member's takes
// that node's, and what is written to the frame is not consulted.
it('rotation: where the frame holds its own angle, the angle written is the angle fitted', () => {
  const h = harness({ useFirstNodeRotation: false }, [{ x: -100, y: 0 }, { x: 100, y: 0 }])
  h.transformer.rotation = 45
  const box = h.fit()
  assert(near(box!.rotation, degToRad(45)), 'the box is measured along the frame\'s own axes')
  assert(near(h.transformer.rotation, 45), 'and reads back in degrees, like every other angle')
})

// --- where the frame's axes come from ---
//
// One node is hugged unconditionally, which is the whole point of a frame around a single
// shape. A SET has no one angle of its own, so useFirstNodeRotation decides between borrowing
// the first member's and holding an upright angle the frame carries itself. This is a
// deliberate divergence: Konva frames a set upright always, and has no equivalent of the
// default here.

it('a lone node is always hugged, whatever the flag says', () => {
  const on = harness({ useFirstNodeRotation: true }, [{ x: 0, y: 0, rotation: 30 }])
  assert(near(on.transformer.fitRotation(), degToRad(30)), 'a lone node lends the frame its angle')

  const off = harness({ useFirstNodeRotation: false }, [{ x: 0, y: 0, rotation: 30 }])
  assert(near(off.transformer.fitRotation(), degToRad(30)), 'and still does with the flag off - it speaks only for a set')
})

it('useFirstNodeRotation: a set borrows its first member\'s angle by default', () => {
  const h = harness({}, [{ x: -100, y: 0, rotation: 30 }, { x: 100, y: 0 }])
  assert(near(h.transformer.fitRotation(), degToRad(30)), 'the frame takes the first member\'s angle')

  h.transformer.attach([h.rects[1], h.rects[0]])
  assert(near(h.transformer.fitRotation(), 0), 'so reordering the set changes the frame - the price of hugging it')

  const upright = harness({ useFirstNodeRotation: false }, [{ x: -100, y: 0, rotation: 30 }, { x: 100, y: 0 }])
  assert(near(upright.transformer.fitRotation(), 0), 'switched off, a set is framed along the world axes')
  upright.transformer.attach([upright.rects[1], upright.rects[0]])
  assert(near(upright.transformer.fitRotation(), 0), 'and reordering it changes nothing')
})

it('a set framed upright still turns with a rotate drag, and stays turned', () => {
  const h = harness({ useFirstNodeRotation: false }, [{ x: -100, y: 0 }, { x: 100, y: 0 }])
  // The rotate handle sits above the top edge of a box spanning both rects.
  h.send('pointerdown', 0, -50 - 24)
  h.send('pointermove', 74, 0) // a quarter turn about the box centre
  h.send('pointerup', 74, 0)
  assert(near(h.transformer.rotation, 90, 0.5), 'the frame took the angle the drag turned it through')

  const box = h.fit()
  assert(near(box!.rotation, degToRad(90), 0.01), 'and the next refit measures along it rather than snapping upright')
})

// --- rotationSnaps ---
//
// Degrees, on the frame, which is where a Konva application looks for them.

it('rotationSnaps: degrees on the frame, taken within the tolerance', () => {
  const h = harness({ rotationSnaps: [0, 90, 180, 270], rotationSnapTolerance: 7 })
  const start = { x: 0, y: -74 }
  const angle = degToRad(-90 + 87) // 87 degrees round from the handle's own position
  h.drag(start, { x: Math.cos(angle) * 74, y: Math.sin(angle) * 74 })
  assert(near(h.rect.rotation, 90, 0.01), 'a drag that lands within 7 degrees of a snap takes it')

  const wide = harness({ rotationSnaps: [0, 90, 180, 270], rotationSnapTolerance: 7 })
  const off = degToRad(-90 + 60)
  wide.drag(start, { x: Math.cos(off) * 74, y: Math.sin(off) * 74 })
  assert(near(wide.rect.rotation, 60, 0.01), 'one that lands outside every tolerance keeps the angle it was dragged to')
})

// --- flipEnabled ---

// Read off the determinant rather than off scaleX, because a corner dragged clean through the
// opposite one negates BOTH axes - which is a half turn, not a mirror, and decomposes as one.
// Only an odd number of negated axes is a flip, and that is what the sign of the product says.
it('flipEnabled: false stops a drag past the fixed point from mirroring', () => {
  const flips = harness()
  flips.drag({ x: 50, y: 0 }, { x: -150, y: 0 })
  assert(isMirrored(flips.rect), 'by default an edge handle dragged across mirrors the nodes')

  const held = harness({ flipEnabled: false })
  held.drag({ x: 50, y: 0 }, { x: -150, y: 0 })
  assert(!isMirrored(held.rect), 'switched off, the box shrinks to nothing and stops there instead')
  assert(held.rect.scaleX > 0 && held.rect.scaleX < 0.01, 'held just clear of zero, where the matrix would collapse')
})

// --- centeredScaling ---

it('centeredScaling: scales about the box centre, as alt does for one gesture', () => {
  const corner = harness()
  corner.drag({ x: 50, y: 50 }, { x: 150, y: 150 })
  const moved = corner.fit()!
  assert(!near(moved.cx, 0, 1), 'ordinarily the opposite corner is what stays put, so the centre travels')

  const centred = harness({ centeredScaling: true })
  centred.drag({ x: 50, y: 50 }, { x: 150, y: 150 })
  const held = centred.fit()!
  assert(near(held.cx, 0, 1e-6) && near(held.cy, 0, 1e-6), 'with it on the centre is what stays put')

  const withAlt = harness()
  withAlt.drag({ x: 50, y: 50 }, { x: 150, y: 150 }, { altKey: true })
  const byAlt = withAlt.fit()!
  assert(near(byAlt.cx, 0, 1e-6), 'and alt asks for the same thing for the length of one drag')
})

// --- boundBoxFunc ---

it('boundBoxFunc: the box it returns is the box the nodes land on', () => {
  const h = harness({
    boundBoxFunc: (_old, next) => (Math.abs(next.width) > 120 ? { ...next, width: 120 } : next),
  })
  h.drag({ x: 50, y: 50 }, { x: 500, y: 500 })
  const box = h.fit()!
  assert(near(box.halfW, 60, 0.01), 'a width the constraint capped is the width the nodes take')
  assert(box.halfH > 100, 'and the axis it left alone follows the pointer')
})

it('boundBoxFunc: returning the old box refuses the gesture outright', () => {
  const h = harness({ boundBoxFunc: (old) => old })
  h.drag({ x: 50, y: 50 }, { x: 500, y: 500 })
  assert(near(h.rect.scaleX, 1) && near(h.rect.scaleY, 1), 'the nodes are left exactly as they were')
})

it('boundBoxFunc: a rotation passes through it too', () => {
  const seen: number[] = []
  const h = harness({
    boundBoxFunc: (_old, next) => {
      seen.push(next.rotation)
      return next
    },
  })
  const angle = degToRad(-90 + 45)
  h.drag({ x: 0, y: -74 }, { x: Math.cos(angle) * 74, y: Math.sin(angle) * 74 })
  assert(seen.length > 0, 'the constraint is consulted on a rotate drag as well as a resize')
  assert(near(seen[seen.length - 1], degToRad(45), 0.01), 'and the box it is shown carries the angle in radians')
})

// --- anchorDragBoundFunc ---

it('anchorDragBoundFunc: constrains where the drag is read from', () => {
  const h = harness({
    anchorDragBoundFunc: (_old, next) => ({ x: Math.round(next.x / 25) * 25, y: Math.round(next.y / 25) * 25 }),
  })
  h.drag({ x: 50, y: 50 }, { x: 137, y: 137 })
  const box = h.fit()!
  assert(near(box.halfW, 87.5, 0.01), 'the pointer is snapped to the grid before the resize reads it')
})

// --- the attached set ---

it('detach: with no argument it empties the set, with one it drops that node', () => {
  const h = harness({}, [{ x: -100, y: 0 }, { x: 100, y: 0 }])
  h.transformer.detach(h.rects[0])
  assert(h.transformer.nodes.length === 1, 'named, one node leaves')
  h.transformer.detach()
  assert(h.transformer.nodes.length === 0, 'unnamed, the whole set does')
})

it('nodes: assigning the set is the same as attaching it', () => {
  const h = harness({}, [{ x: 0, y: 0 }])
  const other = new Rect({ x: 200, y: 0, width: 10, height: 10 })
  h.root.addChild(other)
  h.transformer.nodes = [other]
  assert(h.transformer.nodes.length === 1 && h.transformer.nodes[0] === other, 'the set is replaced wholesale')
  assert(!h.transformer.has(h.rect), 'and what was there before is no longer framed')
})

// --- gesture state ---

it('getActiveAnchor / isTransforming / stopTransform', () => {
  const h = harness()
  assert(h.transformer.getActiveAnchor() === null, 'no handle is held between gestures')
  assert(!h.transformer.isTransforming(), 'and nothing is being transformed')

  h.send('pointerdown', 50, 50)
  assert(h.transformer.getActiveAnchor() === 'bottom-right', 'the handle a press took hold of is reported')
  assert(h.transformer.isTransforming(), 'and the frame says so')

  h.send('pointermove', 150, 150)
  h.transformer.stopTransform()
  assert(h.transformer.getActiveAnchor() === null, 'stopping lets the handle go')
  assert(near(h.rect.scaleX, 2), 'and keeps what the gesture had done by then')
})

// --- events ---
//
// Konva raises these on the transformer as well as on each node; this engine does both, and
// carries the whole set on every one of them so a handler on any single node can see what
// moved with it.

it('transform events reach the frame and the nodes, carrying the set and the raw event', () => {
  resetListenerCensus()
  const h = harness()
  const onFrame: string[] = []
  const onNode: string[] = []
  const sawNodes: (readonly TransformableNode[])[] = []
  let sawEvt: unknown = null

  for (const type of ['transformstart', 'transform', 'transformend']) {
    h.transformer.on(type, (e) => {
      onFrame.push(type)
      sawNodes.push((e as unknown as { nodes: readonly TransformableNode[] }).nodes)
      sawEvt = e.evt
    })
    h.rect.on(type, () => onNode.push(type))
  }

  h.drag({ x: 50, y: 50 }, { x: 150, y: 150 })

  assert(onFrame.includes('transformstart'), 'the frame hears the gesture start')
  assert(onFrame.includes('transform'), 'and each move')
  assert(onFrame.includes('transformend'), 'and the end')
  assert(onNode.join() === onFrame.join(), 'the nodes hear exactly the same sequence')
  assert(sawNodes.every((set) => set.length === 1 && set[0] === h.rect), 'each event carries the set being transformed')
  assert((sawEvt as { type?: string } | null)?.type === 'pointerup', 'and the pointer event that drove it')
  resetListenerCensus()
})

it('drag events reach the frame when what is dragged is what it frames', () => {
  resetListenerCensus()
  const h = harness()
  h.rect.draggable = true
  const onFrame: string[] = []
  for (const type of ['dragstart', 'dragmove', 'dragend']) {
    h.transformer.on(type, () => onFrame.push(type))
  }

  // Away from every handle, so the press takes hold of the node rather than the frame.
  h.setPick(h.rect)
  h.send('pointerdown', 0, 0)
  h.send('pointermove', 60, 0)
  h.send('pointerup', 60, 0)

  assert(onFrame.join() === 'dragstart,dragmove,dragend', 'the frame hears the whole drag')
  assert(near(h.rect.x, 60), 'which really did move the node it frames')
  resetListenerCensus()
})

// --- cursors ---

it('a handle says what it will do on hover, before anything is pressed', () => {
  const h = harness()
  h.send('pointermove', 50, 50)
  assert(h.canvas.style.cursor === 'nwse-resize', 'hovering a corner shows that corner\'s cursor')

  h.send('pointermove', 50, 0)
  assert(h.canvas.style.cursor === 'ew-resize', 'and moving to an edge handle shows that one')

  h.send('pointermove', 0, -74)
  assert(h.canvas.style.cursor === 'grab', 'the rotate handle offers an open hand')
  h.send('pointerdown', 0, -74)
  assert(h.canvas.style.cursor === 'grabbing', 'which closes while it is turning')
  h.send('pointerup', 0, -74)

  h.send('pointermove', 0, 0)
  assert(h.canvas.style.cursor === '', 'and away from every handle the pointer gets its own cursor back')
})

it('the resize cursor turns with the box', () => {
  const upright = harness()
  upright.send('pointerdown', 50, 50)
  assert(upright.canvas.style.cursor === 'nwse-resize', 'a bottom-right handle on an upright box points down-right')
  upright.send('pointerup', 50, 50)

  upright.send('pointerdown', 50, 0)
  assert(upright.canvas.style.cursor === 'ew-resize', 'and a middle-right one points along x')
  upright.send('pointerup', 50, 0)

  // A quarter turn puts the bottom-right corner where the bottom-left one was.
  const turned = harness({}, [{ x: 0, y: 0, rotation: 90 }])
  turned.send('pointerdown', -50, 50)
  assert(turned.canvas.style.cursor === 'nesw-resize', 'a turned box turns its cursors with it')
  turned.send('pointerup', -50, 50)
})

// --- the divergences kept on purpose ---

it('anchors are sized in screen pixels, so a zoomed view does not bloat them', () => {
  // The OUTER disc, which is the one drawn at the full anchor size - the inner one is pulled
  // in by the ring thickness on each side. See Transformer.makeAnchor.
  const h = harness({ anchorSize: 10 })
  h.transformer.update({ cx: 0, cy: 0, halfW: 50, halfH: 50, rotation: 0 }, 4)
  assert(near(partNamed(h.transformer, '__transformer-bottom-right-border').scaleX, 10 / 4), 'the world size is the screen size divided by the zoom')

  h.transformer.update({ cx: 0, cy: 0, halfW: 50, halfH: 50, rotation: 0 }, 1)
  assert(near(partNamed(h.transformer, '__transformer-bottom-right-border').scaleX, 10), 'so at zoom 1 it is the number given')
})
