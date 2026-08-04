// Self-test for the node-drag math (draggedPosition) and how SceneInputDispatcher resolves
// a press. The pan/zoom/pick math it builds on (screenToWorld, panToAnchor, zoomToward) is
// exercised in camera/camera.test.ts, where the camera those functions read lives.
//
// The dispatcher is mostly event wiring over the pure math above, but the ORDER in which it
// resolves a press is behaviour in its own right: what a press means has to be settled
// before it is reported, or an application acting on the report changes the state the
// gesture is about to use. It is driven here through a stub canvas that just collects the
// listeners it registers - no DOM, no GPU. Run with:
//   npx vitest run packages/engine/src/input/input.test.ts

import { expect, it } from 'vitest'
import { Container } from '../shapes/Container'
import { Group } from '../shapes/Group'
import { Rect , type RectOptions } from '../shapes/Rect'
import { AABB } from '../math/AABB'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Vector2 } from '../math/Vector2'
import { Vector3 } from '../math/Vector3'
import { Camera2D } from '../camera/Camera2D'
import { Scene } from '../scene/Scene'
import { draggedPosition } from './nodeDrag'
import { screenToWorld } from './viewport'
import { SceneInputDispatcher } from './SceneInputDispatcher'
import { attachSceneInput, type SceneInputHost } from './sceneInput'
import { resolveInputOptions, type InputEventHost } from './inputOptions'
import { engineOwnsCanvas, resolveCanvas } from '../systems/canvasTarget'
import { Transformer } from '../shapes/Transformer'
import { MarqueeOverlay } from './MarqueeOverlay'
import { boxForNodes } from '../shapes/transformerMath'
import { Circle } from '../shapes/Circle'
import { listenerCount, resetListenerCensus } from '../events/listenerCensus'
import type { Shape } from '../shapes/Shape'
import type { RGBA } from '../render/color'
import type { TransformableNode } from '../shapes/Group'

/**
 * Every check in this file goes through here, so each one reads as the sentence it is making
 * and vitest reports that sentence when it stops being true.
 */
function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps

/**
 * A Rect CENTRED on (x, y). A Rect's own origin is its top-left corner (see Shape's
 * header), so this applies the pivot offset that puts its middle back on the position -
 * which is the frame the geometry below is written in.
 */
const centredRect = (options: RectOptions = {}): Rect =>
  new Rect({ ...options, offsetX: (options.width ?? 1) / 2, offsetY: -(options.height ?? 1) / 2 })

/**
 * A canvas stand-in, and a way to drive it: the dispatcher only ever adds listeners, captures
 * the pointer, sets a cursor and measures the element, and its coordinates are already client
 * coordinates here.
 */
function stubCanvas(width = 800, height = 600) {
  // A LIST per type, not one handler: a canvas really does take several - the dispatcher's
  // own pointermove and the marquee's hold-cancel are both on this element - and a stub that
  // kept only the last would silently unregister the first.
  const listeners = new Map<string, ((e: never) => void)[]>()
  const element = {
    addEventListener: (type: string, fn: (e: never) => void) =>
      listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type: string, fn: (e: never) => void) =>
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== fn)),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    clientWidth: width,
    clientHeight: height,
    style: { cursor: '', touchAction: '' },
  }
  const send = (type: string, x: number, y: number, extra: Record<string, unknown> = {}): void => {
    const event = {
      pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y,
      shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      preventDefault: () => {}, type, ...extra,
    } as never
    for (const handler of [...(listeners.get(type) ?? [])]) handler(event)
  }
  const listenerCount = () => [...listeners.values()].reduce((total, entries) => total + entries.length, 0)
  return { element: element as unknown as HTMLCanvasElement, send, listenerCount }
}

/** Somewhere to hear keys that is not a window, since there is no window here. */
function stubKeyboard() {
  const listeners = new Map<string, ((e: never) => void)[]>()
  const target: InputEventHost = {
    addEventListener(type, handler) {
      listeners.set(type, [...(listeners.get(type) ?? []), handler])
    },
    removeEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== handler))
    },
  }
  const press = (key: string): void => {
    for (const handler of listeners.get('keydown') ?? []) handler({ key, preventDefault: () => {} } as never)
  }
  const listenerCount = () => [...listeners.values()].reduce((total, entries) => total + entries.length, 0)
  return { target, press, listenerCount }
}

interface FakeHost extends SceneInputHost {
  camera: Camera2D
  nodesInBox: () => Shape[]
  /** How many per-frame subscriptions the input took out - zero unless it needs one. */
  frameListeners: number
}

/** The renderer surface the bindings read, without a renderer: a scene, a camera and a pick. */
function fakeHost(scene: Scene, pick: () => Shape | null): FakeHost {
  const camera = new Camera2D()
  const host: FakeHost = {
    scene,
    camera,
    getZoom: () => camera.zoom,
    pick,
    nodesInBox: () => [],
    localBoundsOf: (node: TransformableNode) => (node as Rect).localBounds() ?? new AABB(),
    frameListeners: 0,
    addFrameListener: (listener) => {
      host.frameListeners++
      frameTicks.push(listener)
      return () => {
        host.frameListeners--
      }
    },
  }
  return host
}

/** Every frame callback the tests below have handed out, so one can be driven by hand. */
const frameTicks: ((dt: number) => void)[] = []

//     relative to whatever transform its parent imposes ---
it('draggedPosition: a node follows the pointer in WORLD space, while its own x/y stay', () => {
    // A container whose local transform the test sets directly, so a node can be parented
    // under an arbitrary rotate/scale/flip frame without a whole scene.
    class TransformGroup extends Container {
      matrix = Matrix4x4.identity()
      override localMatrix(): Matrix4x4 {
        return this.matrix
      }
    }

    // No parent: the world delta applies to x/y unchanged.
    const loose = centredRect({ x: 10, y: 20 })
    const moved = draggedPosition(loose, 10, 20, { x: 0, y: 0 }, { x: 5, y: -3 })
    assert(near(moved.x, 15) && near(moved.y, 17), 'an unparented node takes the world delta directly')

    // A parent's TRANSLATION must not leak into the delta - it's a direction, not a point.
    // (Getting this wrong would fling the node by the parent's offset on the first move.)
    const translated = new TransformGroup()
    translated.matrix = Matrix4x4.translation(new Vector3(1000, -500, 0))
    const inTranslated = translated.addChild(centredRect({ x: 0, y: 0 }))
    const t = draggedPosition(inTranslated, 0, 0, { x: 0, y: 0 }, { x: 5, y: -3 })
    assert(near(t.x, 5) && near(t.y, -3), "a parent's translation does not offset the drag delta")

    // A parent's SCALE divides the world delta: 2x parent means 10 world units of drag is
    // only 5 units in the child's own coordinates.
    const scaled = new TransformGroup()
    scaled.matrix = Matrix4x4.scaling(new Vector3(2, 2, 1))
    const inScaled = scaled.addChild(centredRect({ x: 0, y: 0 }))
    const s = draggedPosition(inScaled, 0, 0, { x: 0, y: 0 }, { x: 10, y: 10 })
    assert(near(s.x, 5) && near(s.y, 5), "a parent's scale divides the drag delta")

    // A Y-flipping parent (what the SVG loader's root matrix does) inverts dy: dragging
    // the pointer UP in world space must still move the node up on screen.
    const flipped = new TransformGroup()
    flipped.matrix = Matrix4x4.scaling(new Vector3(1, -1, 1))
    const inFlipped = flipped.addChild(centredRect({ x: 0, y: 0 }))
    const f = draggedPosition(inFlipped, 0, 0, { x: 0, y: 0 }, { x: 4, y: 10 })
    assert(near(f.x, 4) && near(f.y, -10), "a parent's Y flip inverts the drag delta's y")

    // The invariant that actually matters, under a combined translate+rotate+scale parent:
    // applying the result moves the node by EXACTLY the world-space drag delta, which is
    // what keeps the grabbed point of the shape under the pointer.
    const gnarly = new TransformGroup()
    gnarly.matrix = Matrix4x4.translation(new Vector3(30, -15, 0))
      .mul(Matrix4x4.rotationZ(0.9))
      .mul(Matrix4x4.scaling(new Vector3(1.7, 0.4, 1)))
    const child = gnarly.addChild(centredRect({ x: 7, y: -2 }))
    const origin = new Vector3(0, 0, 0)

    const worldBefore = child.worldMatrix().transformPoint(origin)
    const anchor = { x: 3, y: 4 }
    const dragged = draggedPosition(child, child.x, child.y, anchor, { x: anchor.x + 12, y: anchor.y - 5 })
    child.x = dragged.x
    child.y = dragged.y
    const worldAfter = child.worldMatrix().transformPoint(origin)
    assert(
      near(worldAfter.x - worldBefore.x, 12) && near(worldAfter.y - worldBefore.y, -5),
      'the node moves by exactly the world drag delta, whatever its parent transform',
    )

    // Resolved from the fixed drag-start values, never accumulated: dragging the pointer
    // through a long path of intermediate positions (each one applied to the node, as a
    // real pointermove stream would) must land exactly where a single jump to the final
    // position would - i.e. the world offset still equals the total pointer delta, with no
    // drift accumulated across the steps.
    const dragStart = { x: child.x, y: child.y }
    const beforeStepping = child.worldMatrix().transformPoint(origin)
    const path = [
      { x: 6, y: 2 },
      { x: 19, y: -8 },
      { x: 33, y: 17 },
      { x: 40, y: 25 },
    ]
    for (const step of path) {
      const mid = draggedPosition(child, dragStart.x, dragStart.y, anchor, {
        x: anchor.x + step.x,
        y: anchor.y + step.y,
      })
      child.x = mid.x
      child.y = mid.y
    }
    const afterStepping = child.worldMatrix().transformPoint(origin)
    const total = path[path.length - 1]
    assert(
      near(afterStepping.x - beforeStepping.x, total.x) && near(afterStepping.y - beforeStepping.y, total.y),
      'a stepped drag lands exactly on the total pointer delta - no accumulated drift',
    )
})

it('draggable: on by default (a drag only ever reaches a pickable node), opt-out per node', () => {
    assert(centredRect().draggable, 'a shape is draggable by default')
    assert(!centredRect({ draggable: false }).draggable, 'draggable can be turned off per node')
})

//
// Reproduces the reported failure directly. A circle is selected and its rotate handle is
// pressed; the handle happens to sit over an image stacked behind it. The press must belong
// to the handle, so nothing about the selection may change - if the press were reported
// against the shape behind it first, an application that selects on press would swap the
// selection out from under the gesture, and since the frame is refit once a frame rather
// than on attach, the newly selected shape would then be rotated about the OLD selection's
// centre.
it('resolving a press: a transformer handle is not the shape behind it', () => {
    // A canvas stand-in: the dispatcher only ever adds listeners, captures the pointer, and
    // sets a cursor on it, and its own coordinates are already client coordinates here.
    const listeners = new Map<string, (e: never) => void>()
    const canvas = {
      addEventListener: (type: string, fn: (e: never) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      hasPointerCapture: () => false,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      style: { cursor: '' },
    }

    const root = new Container()
    const circle = new Circle({ name: 'circle', x: 0, y: 0, radius: 40 })
    const behind = centredRect({ name: 'behind', x: 0, y: 0, width: 400, height: 400 })
    root.addChild(behind)
    root.addChild(circle)

    const transformer = new Transformer()
    root.addChild(transformer)
    transformer.attach([circle])
    // What the renderer does once a frame: fit the frame around the selection.
    const box = { cx: 0, cy: 0, halfW: 40, halfH: 40, rotation: 0 }
    transformer.update(box, 1)

    const rotateAnchor = { x: 0, y: 76 } // above the top edge, where the rotate handle sits
    assert(transformer.anchorAt(rotateAnchor.x, rotateAnchor.y) === 'rotate', 'the rotate handle is where the test presses')

    resetListenerCensus()
    const dispatcher = new SceneInputDispatcher(canvas as unknown as HTMLCanvasElement, {
      root,
      // Everything under the pointer is the shape stacked behind - the situation that made
      // the failure visible.
      pick: () => behind,
      toWorld: (x, y) => new Vector2(x, y),
      transformer,
    })

    const presses: string[] = []
    root.on('pointerdown', (e) => {
      presses.push((e.target as { name?: string }).name ?? 'root')
      // The ordinary application policy: a press selects what it landed on.
      const hit = e.target as Shape
      if (hit !== (root as unknown as Shape)) transformer.attach([hit])
    })

    const press = (type: string, x: number, y: number) =>
      listeners.get(type)?.({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y, shiftKey: false, altKey: false, preventDefault: () => {}, type } as never)

    press('pointerdown', rotateAnchor.x, rotateAnchor.y)
    assert(presses.length === 0, 'pressing a handle reports no press against the shape behind it')
    assert(transformer.nodes.length === 1 && transformer.nodes[0] === circle, 'so the selection is left exactly as it was')

    // And the gesture that follows transforms what was selected, about its own centre.
    press('pointermove', 76, 0) // a quarter turn round the box centre
    assert(transformer.nodes[0] === circle, 'the rotation stays on the selected node')
    assert(Math.abs(circle.rotation) > 0.5, 'which really did rotate')
    assert(near(behind.rotation, 0), 'and the shape behind was not touched')

    press('pointerup', 76, 0)
    assert(presses.length === 0, 'releasing a handle is not a press or a click on anything either')

    // A press that is NOT on a handle still reports normally - the fix must not swallow the
    // ordinary case it sits in front of.
    press('pointerdown', 200, 200)
    assert(presses.length === 1 && presses[0] === 'behind', 'a press away from the handles reports as usual')
    press('pointerup', 200, 200)
    dispatcher.destroy()
    resetListenerCensus()
})

//
// This is the one place grouping is mechanism rather than policy: a group is meant to feel
// like one object under the pointer, so a drag that lands on a shape inside it moves the
// whole assembly, and the shape's own x/y never change. Which node a CLICK selects stays
// the application's business - the dispatcher still reports the press on the shape.
it('a press inside a group takes hold of the GROUP', () => {
    const listeners = new Map<string, (e: never) => void>()
    const canvas = {
      addEventListener: (type: string, fn: (e: never) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      hasPointerCapture: () => false,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      style: { cursor: '' },
    }

    const root = new Container()
    const group = root.addChild(new Group({ name: 'assembly' }))
    const part = group.addChild(centredRect({ name: 'part', x: 0, y: 0, width: 40, height: 40 }))

    resetListenerCensus()
    const dispatcher = new SceneInputDispatcher(canvas as unknown as HTMLCanvasElement, {
      root,
      pick: () => part,
      toWorld: (x, y) => new Vector2(x, y),
    })
    const send = (type: string, x: number, y: number) =>
      listeners.get(type)?.({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y, shiftKey: false, altKey: false, preventDefault: () => {}, type } as never)

    const pressed: string[] = []
    root.on('pointerdown', (e) => pressed.push((e.target as { name?: string }).name ?? 'root'))

    send('pointerdown', 0, 0)
    send('pointermove', 50, 30)
    assert(pressed[0] === 'part', 'the press is still reported on the shape - a pick tells the truth about what is there')
    assert(near(group.x, 50) && near(group.y, 30), 'but the drag moved the GROUP')
    assert(part.x === 0 && part.y === 0, 'and left the shape exactly where it was inside it')
    send('pointerup', 50, 30)

    // A group that has opted out is not a handle: the drag falls back to the shape itself.
    group.draggable = false
    send('pointerdown', 50, 30)
    send('pointermove', 60, 30)
    assert(near(group.x, 50), 'a non-draggable group does not move')
    assert(near(part.x, 10), 'the shape inside it does')
    send('pointerup', 60, 30)

    // ...and a shape that has opted out inside a group that has NOT still moves the group,
    // because the group is what was grabbed, not the shape.
    group.draggable = true
    part.draggable = false
    part.x = 0
    send('pointerdown', 50, 30)
    send('pointermove', 90, 30)
    assert(near(group.x, 90), 'a non-draggable shape is still a handle on its draggable group')
    assert(part.x === 0, 'and does not move itself')
    send('pointerup', 90, 30)

    dispatcher.destroy()
    resetListenerCensus()
})

it('the transformer wraps a group as one node, framed by what the group holds', () => {
    const root = new Container()
    const group = root.addChild(new Group({ x: 100, y: 0 }))
    group.addChild(centredRect({ x: -20, y: 0, width: 20, height: 20 }))
    group.addChild(centredRect({ x: 20, y: 0, width: 20, height: 20 }))

    const transformer = new Transformer()
    root.addChild(transformer)
    transformer.attach([group])
    assert(transformer.has(group), 'a group can be attached like any other node')

    const box = boxForNodes(transformer.nodes, (node) => (node instanceof Group ? node.bounds() : node.localBounds()))
    assert(box !== null, 'and the frame fits around it')
    // The two rects span -30..30 in the group's own space, and the group sits at x = 100.
    assert(near(box!.cx, 100) && near(box!.halfW, 30), 'over the extent of everything the group holds, in world space')
    assert(near(box!.halfH, 10), 'on both axes')

    // Adding to the group changes what the frame would cover, with nothing to invalidate.
    // The new rect is centred on y = -100, so it spans -110..-90 and the union runs -110..10.
    group.addChild(centredRect({ x: 0, y: -100, width: 20, height: 20 }))
    const grown = boxForNodes(transformer.nodes, (node) => (node instanceof Group ? node.bounds() : node.localBounds()))
    assert(near(grown!.halfH, 60), 'and a group that gained a member is measured bigger next time it is asked')
    assert(near(grown!.cy, -50), 'recentred on the new extent, with nothing told to invalidate anything')
})

//
// Resolving a hover target means picking, and a pick walks the whole scene. That is the one
// unbounded thing a pointer move can set off, so it must not happen while a gesture owns
// the pointer - nothing is pointing at anything then, and the answer is thrown away. At a
// hundred thousand shapes it was a quarter of a second per move, which is what turned a pan
// into a slideshow; the count below is what keeps it from creeping back.
it('a gesture never pays to find out what is under the pointer', () => {
    const listeners = new Map<string, (e: never) => void>()
    const canvas = {
      addEventListener: (type: string, fn: (e: never) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      hasPointerCapture: () => false,
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      style: { cursor: '' },
    }

    const root = new Container()
    const shape = root.addChild(centredRect({ name: 'target', x: 0, y: 0, width: 200, height: 200 }))

    resetListenerCensus()
    let picks = 0
    const dispatcher = new SceneInputDispatcher(canvas as unknown as HTMLCanvasElement, {
      root,
      pick: () => {
        picks++
        return shape
      },
      toWorld: (x, y) => new Vector2(x, y),
    })
    const send = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
      listeners.get(type)?.({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0, clientX: x, clientY: y, shiftKey: false, altKey: false, preventDefault: () => {}, type, ...extra } as never)

    // With nothing listening for a hover-class event, a move costs no pick at all - the
    // pre-existing guarantee, restated here because everything below builds on it.
    send('pointermove', 10, 10)
    assert(picks === 0, 'a move hit-tests nothing when no hover listener exists')

    // One hover listener switches that on. This is the trap: the handler below never reads
    // e.target, but registering it is what makes every move resolve one.
    root.on('pointermove', () => {})
    picks = 0
    send('pointermove', 20, 20)
    send('pointermove', 30, 30)
    assert(picks === 2, 'a hover listener puts the hit-test back, one per move')

    // Now hold the button down. Every move from here belongs to a gesture, and none of them
    // may hit-test however far the pointer travels.
    picks = 0
    send('pointerdown', 40, 40, { buttons: 1 })
    const picksFromPress = picks
    for (let i = 0; i < 25; i++) send('pointermove', 40 + i * 4, 40 + i * 3, { buttons: 1 })
    assert(picks === picksFromPress, 'twenty-five moves during a gesture hit-test exactly zero times')

    // ...and it comes straight back when the button does, so hovering still works after.
    send('pointerup', 140, 115, { buttons: 0 })
    picks = 0
    send('pointermove', 150, 120)
    assert(picks === 1, 'the hit-test returns the moment the gesture ends')

    // A marquee is the same: the rectangle answers what it covered, once, at the end.
    dispatcher.beginMarquee(new Vector2(0, 0))
    picks = 0
    for (let i = 0; i < 10; i++) send('pointermove', i * 10, i * 10)
    assert(picks === 0, 'nor does a move during a marquee')

    dispatcher.destroy()
    resetListenerCensus()
})

//
// The dispatch this is about is the ordinary one: an application drives camera zoom from
// root.on('wheel'), reads the delta, and never asks what the pointer was over. Naming that
// node means walking every shape in the scene front to back, which at a hundred thousand of
// them is the whole frame - spent on an answer that is thrown away.
it('a wheel does not hit-test the scene to find out nobody asked', () => {
    resetListenerCensus()
    const root = new Container('root')
    const shape = root.addChild(new Rect({ name: 'under-the-pointer', width: 10, height: 10 }))

    let picks = 0
    const dispatcher = new SceneInputDispatcher(null, {
      root,
      pick: () => {
        picks++
        return shape
      },
    })

    // A listener on the root: everything bubbles there, so what was hit cannot change who is
    // called. The only thing it could change is what `target` says - and this one never looks.
    let seen = 0
    root.on('wheel', () => {
      seen++
    })
    dispatcher.wheel({ pointerId: -1, pointerType: 'mouse' }, { x: 5, y: 5 })
    assert(seen === 1, 'the handler still runs')
    assert(picks === 0, 'and the scene was never hit-tested to get there')

    // Reading target is what the hit-test was ever for, so asking still answers - the work is
    // deferred, not dropped.
    let target: unknown = null
    root.on('wheel', (e) => {
      target = e.target
    })
    dispatcher.wheel({ pointerId: -1, pointerType: 'mouse' }, { x: 5, y: 5 })
    assert(target === shape, 'a handler that asks for target gets exactly what it always got')
    assert(picks === 1, 'which costs the one hit-test, and only when asked')

    // ...once per event, however many handlers ask.
    picks = 0
    root.on('wheel', (e) => {
      target = e.target
    })
    dispatcher.wheel({ pointerId: -1, pointerType: 'mouse' }, { x: 5, y: 5 })
    assert(picks === 1, 'and once per event however many handlers read it')
})

it('...but a listener further down the tree is picked for eagerly, as it must be', () => {
    resetListenerCensus()
    const root = new Container('root')
    const shape = root.addChild(new Rect({ name: 'listening', width: 10, height: 10 }))

    let picks = 0
    const dispatcher = new SceneInputDispatcher(null, {
      root,
      pick: () => {
        picks++
        return shape
      },
    })

    // Now the hit DOES decide who is called: this handler runs only if the pointer was over
    // this node. There is nothing to defer - the dispatch path is the answer.
    let reached = 0
    shape.on('wheel', () => {
      reached++
    })
    dispatcher.wheel({ pointerId: -1, pointerType: 'mouse' }, { x: 5, y: 5 })
    assert(reached === 1, 'a wheel listener on a shape hears the event')
    assert(picks === 1, 'and the hit-test that routed it ran up front, because the route depends on it')

    // A type nobody listens for still costs nothing at all, which is the older guard and stays.
    picks = 0
    dispatcher.contextMenu({ pointerId: -1, pointerType: 'mouse' }, { x: 5, y: 5 })
    assert(picks === 0, 'and a type with no listeners anywhere is not dispatched or picked')
    resetListenerCensus()
})

//
// Four forms in, one canvas out. The interesting halves are the two that CREATE one: a
// selector naming something that is not a canvas means "put one in here", and no target at
// all means "put one over the window" - which is what makes a page with no HTML of its own a
// legitimate way to start.
it('the canvas a target names', () => {
    class FakeElement {
      readonly style: Record<string, string> = {}
      readonly children: FakeElement[] = []
      constructor(readonly tagName: string) {}
      appendChild(child: FakeElement): void {
        this.children.push(child)
      }
    }

    const body = new FakeElement('BODY')
    const existing = new FakeElement('CANVAS')
    const container = new FakeElement('DIV')
    const doc = {
      querySelector: (selector: string) =>
        (selector === '#board' ? existing : selector === '#stage' ? container : null) as unknown as Element | null,
      createElement: (tag: string) => new FakeElement(tag.toUpperCase()) as unknown as HTMLElement,
      body: body as unknown as HTMLElement,
    }

    const byElement = resolveCanvas(existing as unknown as HTMLCanvasElement, doc)
    assert(byElement === (existing as unknown as HTMLCanvasElement), 'a canvas element is used as it is')

    const bySelector = resolveCanvas('#board', doc)
    assert(bySelector === (existing as unknown as HTMLCanvasElement), 'a selector naming a canvas resolves to it')

    const built = resolveCanvas('#stage', doc) as unknown as FakeElement
    assert(built.tagName === 'CANVAS', 'a selector naming anything else builds a canvas')
    assert(container.children[0] === built, 'inside that element')
    assert(built.style.width === '100%' && built.style.height === '100%', 'filling it, sized by the page CSS')
    assert(built.style.display === 'block', "and block, so it doesn't sit on a text baseline")

    const overTheWindow = resolveCanvas(null, doc) as unknown as FakeElement
    assert(body.children[0] === overTheWindow, 'no target at all puts one in the body')
    // Who cleans up: a canvas the engine built is the engine's to remove when the renderer is
    // destroyed, and one the caller supplied is left exactly as it was found.
    assert(engineOwnsCanvas(built as unknown as HTMLCanvasElement), 'a canvas the engine built is marked as its own')
    assert(!engineOwnsCanvas(existing as unknown as HTMLCanvasElement), 'one the caller supplied is not')
    assert(overTheWindow.style.position === 'fixed', 'covering the viewport, so a page with no CSS still shows a scene')

    let refused = ''
    try {
      resolveCanvas('#nothing-here', doc)
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error)
    }
    assert(refused.includes('#nothing-here'), 'a selector that matches nothing says so, naming it')
})

//
// The vocabulary's whole meaning, and the one part of it that is pure: which presets expand
// to what, which combinations amount to no input at all, and that an option object states
// only what differs from the preset it sits in.
it('what "handle input" was asked for', () => {
    assert(resolveInputOptions(undefined) === null, 'no option at all is a static render')
    assert(resolveInputOptions(null) === null, 'and so is null, explicitly')
    assert(resolveInputOptions(false) === null, 'and false')
    assert(
      resolveInputOptions({ camera: false, objects: false }) === null,
      'as is a long form with both halves off - a static render however it was asked for',
    )

    const view = resolveInputOptions('view')
    assert(view?.camera !== null && view?.objects === null, "'view' is the camera alone")
    assert(view?.camera?.pan === true && view?.camera?.zoom === true, 'panning and zooming')

    const editor = resolveInputOptions('editor')
    assert(editor?.camera !== null && editor?.objects !== null, "'editor' is both halves")
    assert(editor?.objects?.select === true && editor?.objects?.marquee === true, 'with the full object set')
    assert(resolveInputOptions(true)?.objects !== null, 'and true means the same as editor')

    // An option object is the preset's defaults with its own fields over them - so turning one
    // behaviour off does not quietly turn the other twelve off with it.
    const partial = resolveInputOptions({ objects: { drag: false } })
    assert(partial?.objects?.drag === false, 'a stated field takes effect')
    assert(partial?.objects?.select === true, 'and the rest of the half keeps its defaults')
    assert(partial?.camera?.zoom === true, 'as does the half that was not mentioned')
    assert(partial?.objects?.transformer !== undefined, 'including the ones that are objects themselves')

    // undefined is "unstated", not "off" - what a plain spread would have got wrong.
    const unstated = resolveInputOptions({ camera: { zoom: undefined } })
    assert(unstated?.camera?.zoom === true, 'an undefined field means unstated, not off')
})

//
// The point of the 'view' set is not that its policy ignores the hit - it is that the
// question is never asked. A pick walks every shape in the scene, so on a large one the
// difference between "picked and discarded" and "never picked" is the whole frame.
it('a view never asks what is under the pointer', () => {
    resetListenerCensus()
    const scene = new Scene()
    const shape = scene.root.addChild(centredRect({ name: 'content', x: 0, y: 0, width: 400, height: 400 }))

    let picks = 0
    const host = fakeHost(scene, () => {
      picks++
      return shape
    })
    const canvas = stubCanvas()
    const input = attachSceneInput(host, canvas.element, 'view')
    assert(input !== null, 'a view does set input up')
    assert(input?.transformer === null, 'but with no selection frame - there is nothing to select')

    // A drag straight over the shape. In an editor this would pick it up; here it moves the view.
    canvas.send('pointerdown', 100, 100)
    canvas.send('pointermove', 150, 100)
    canvas.send('pointerup', 150, 100)

    assert(picks === 0, 'a whole press-drag-release over a shape hit-tests exactly zero times')
    assert(shape.x === 0 && shape.y === 0, 'so nothing in the scene moved')
    assert(near(host.camera.x, -50), 'the view did - dragging right by 50 pulls the camera 50 left')
    assert(input?.selection.length === 0, 'and nothing is selected, because nothing can be')

    input?.destroy()
    resetListenerCensus()
})

//
// A wheel notch aims the zoom at the world point under the cursor. A RUN of them - and a
// trackpad sends dozens a second - has to go on aiming at that SAME point. Reading it afresh
// per notch re-aims at wherever the previous notch happened to leave the content, so a hand
// resting on a wheel, which moves a pixel or two and means nothing by it, walks the view out
// from under itself. Asserted in PIXELS, because "does not visibly slide" is the claim.
it('a run of wheel notches holds one anchor rather than re-reading it', () => {
    resetListenerCensus()
    const scene = new Scene()
    const host = fakeHost(scene, () => null)
    const canvas = stubCanvas()
    const view = { width: 800, height: 600 }
    const input = attachSceneInput(host, canvas.element, 'view')

    const HAIR = 0.01 // pixels - a hundredth of one, far below anything visible
    const heldPixel = (world: Vector2, msg: string) => {
      const now = screenToWorld(host.camera, 200, 150, view)!
      assert(Math.hypot(now.x - world.x, now.y - world.y) * host.camera.zoom < HAIR, msg)
    }

    // Twenty notches in and twenty back out, the cursor wobbling three pixels on some of them.
    // Each pair is a zoom and its exact inverse, so a run that kept its aim comes back to
    // where it started; one that re-aimed each notch drifts by about two thirds of a pixel
    // per wobbled pair and never comes back.
    const anchor = screenToWorld(host.camera, 200, 150, view)!
    for (let i = 0; i < 40; i++) {
      canvas.send('wheel', i % 4 === 1 ? 203 : 200, 150, { deltaY: i % 2 === 0 ? -100 : 100 })
      heldPixel(anchor, 'the world point the run is aimed at stays under its pixel, notch by notch')
    }
    assert(near(host.camera.zoom, 1), 'and forty notches that cancel leave the zoom exactly where it began')

    // A cursor that really travelled is a new gesture, aimed at whatever is under it now.
    const elsewhere = screenToWorld(host.camera, 600, 400, view)!
    canvas.send('wheel', 600, 400, { deltaY: -100 })
    const reaimed = screenToWorld(host.camera, 600, 400, view)!
    assert(
      Math.hypot(reaimed.x - elsewhere.x, reaimed.y - elsewhere.y) * host.camera.zoom < HAIR,
      'moving the cursor somewhere else re-reads the anchor rather than dragging the old one along',
    )

    // ...and so is a view that moved under the anchor. The same pixel as the notch before it,
    // so nothing but the camera check can catch this: holding a world point across a pan
    // nobody told the binding about is not the absence of a jump, it IS one.
    host.camera.x += 250
    const afterPan = screenToWorld(host.camera, 600, 400, view)!
    canvas.send('wheel', 600, 400, { deltaY: -100 })
    const afterZoom = screenToWorld(host.camera, 600, 400, view)!
    assert(
      Math.hypot(afterZoom.x - afterPan.x, afterZoom.y - afterPan.y) * host.camera.zoom < HAIR,
      'a view moved by anything else drops the held anchor',
    )

    input?.destroy()
    resetListenerCensus()
})

it('the editor set: press to select, drag to move, empty space to clear', () => {
    resetListenerCensus()
    const scene = new Scene()
    const shape = scene.root.addChild(centredRect({ name: 'content', x: 0, y: 0, width: 200, height: 200 }))

    let over: Shape | null = shape
    const host = fakeHost(scene, () => over)
    const canvas = stubCanvas()
    const keys = stubKeyboard()
    const input = attachSceneInput(host, canvas.element, { objects: true, keyboardTarget: keys.target })
    assert(input?.transformer !== null, 'an editor gets a selection frame')
    assert(scene.root.children.includes(input!.transformer!), 'which lives in the scene like any other content')
    assert(input!.nodes.length === 2, 'and is furniture, alongside the marquee rectangle')

    // A press selects what it landed on, and the drag that follows moves it.
    canvas.send('pointerdown', 0, 0)
    assert(input?.selection[0] === shape, 'a press selects the node under it')
    canvas.send('pointermove', 40, 0)
    canvas.send('pointerup', 40, 0)
    assert(near(shape.x, 40), 'and the drag moved the node, not the view')
    assert(near(host.camera.x, 0), 'which stayed exactly where it was')

    // A click on empty space clears it. The pick answers null, which is what "empty" means.
    over = null
    canvas.send('pointerdown', 300, 300)
    canvas.send('pointerup', 300, 300)
    assert(input?.selection.length === 0, 'a click on empty space clears the selection')

    // Selecting from code is the same set - what is framed is what is selected.
    input?.select(shape)
    assert(input?.selection[0] === shape, 'select() frames a node')
    keys.press('Escape')
    assert(input?.selection.length === 0, 'and Escape drops it')

    input?.destroy()
    resetListenerCensus()
})

it('a rectangle dragged over empty space selects what it covered', () => {
    resetListenerCensus()
    const scene = new Scene()
    const shape = scene.root.addChild(centredRect({ name: 'content', x: 0, y: 0, width: 100, height: 100 }))

    const host = fakeHost(scene, () => null)
    host.nodesInBox = () => [shape]
    const canvas = stubCanvas()
    const input = attachSceneInput(host, canvas.element, 'editor')

    canvas.send('pointerdown', 200, 200)
    assert(input!.dispatcher.marquee.active, 'a drag from empty space pulls out a rectangle')
    canvas.send('pointermove', 300, 300)
    canvas.send('pointerup', 300, 300)
    assert(input?.selection[0] === shape, 'and what it covered is what ends up selected')
    assert(near(host.camera.x, 0), 'the view did not move under it')

    // Ctrl held asks for the view instead, which is what the rectangle has to make way for.
    input!.dispatcher.grabContent = false
    canvas.send('pointerdown', 200, 200)
    assert(!input!.dispatcher.marquee.active, 'a press asking for the view starts no rectangle')
    canvas.send('pointermove', 250, 200)
    assert(near(host.camera.x, -50), 'it pans instead')
    canvas.send('pointerup', 250, 200)

    input?.destroy()
    resetListenerCensus()
})

//
// Not "listens and ignores": no canvas listener is registered, no scene event is ever raised,
// and no frame work is scheduled. The camera is still an ordinary object, so a static render
// can still be panned - from code, by the application, whenever it likes.
it('a static render listens to nothing at all', () => {
    resetListenerCensus()
    const scene = new Scene()
    const host = fakeHost(scene, () => null)
    const canvas = stubCanvas()

    assert(attachSceneInput(host, canvas.element, null) === null, 'no input option means no input')
    assert(canvas.listenerCount() === 0, 'and not one listener on the canvas')
    assert(host.frameListeners === 0, 'nor any per-frame work')

    host.camera.x = 120
    assert(near(host.camera.x, 120), 'while the camera remains the application"s to move')
    resetListenerCensus()
})

//
// A leak here is not a slow one: an application that tears a renderer down and builds another
// (switching render path, remounting a component, opening a second document) does it in whole
// renderers. What must come back is everything the setup took out - the DOM listeners, the
// keys, the per-frame subscription, the two nodes put into the scene, the references the frame
// holds to whatever was selected, and the global listener census, which is the one that
// silently never comes down again: it reads high by design, so a listener left counted makes
// the whole scene keep paying to dispatch an event type nothing is listening for.
it('destroying the input leaves nothing behind', () => {
    resetListenerCensus()
    const scene = new Scene()
    const shape = scene.root.addChild(centredRect({ name: 'content', x: 0, y: 0, width: 100, height: 100 }))
    const host = fakeHost(scene, () => shape)
    const canvas = stubCanvas()
    const keys = stubKeyboard()
    const input = attachSceneInput(host, canvas.element, { objects: true, keyboardTarget: keys.target })
    assert(input !== null, 'the input is set up')

    // Select something, so the frame is holding a reference to application content, and put an
    // application listener on the frame - the two things a bare remove() would strand.
    canvas.send('pointerdown', 0, 0)
    canvas.send('pointerup', 0, 0)
    let announced = 0
    input!.transformer!.on('attachchange', () => {
      announced++
    })
    assert(input!.selection.length === 1, 'with a node selected')
    assert(host.frameListeners === 1, 'and one per-frame subscription for the frame refit')
    assert(listenerCount('attachchange') === 1, 'and the census counting the listener')
    assert(canvas.listenerCount() > 0 && keys.listenerCount() > 0, 'and listeners on the canvas and the keys')

    const before = scene.root.children.length
    input!.destroy()

    assert(canvas.listenerCount() === 0, 'destroy leaves no listener on the canvas')
    assert(keys.listenerCount() === 0, 'nor on the keyboard target')
    assert(host.frameListeners === 0, 'nor a per-frame subscription')
    assert(scene.root.children.length === before - 2, 'and takes both furniture nodes back out of the scene')
    assert(announced === 1, 'the frame announces the selection it is dropping')
    assert(input!.selection.length === 0, 'and really does let go of it')
    assert(listenerCount('attachchange') === 0, "along with the application's listener, so the census comes down")
    assert(listenerCount('pointerdown') === 0, 'as it does for every binding the setup registered on the root')
    assert(listenerCount('wheel') === 0, 'including the camera ones')

    // ...and again is harmless, which matters because handle.destroy() calls it too.
    input!.destroy()
    assert(scene.root.children.length === before - 2, 'a second destroy changes nothing')
    resetListenerCensus()
})

// The marquee and the frame are one gesture seen at two moments - a box is pulled out, and
// what it covered is handed straight to the transformer. Drawn in two different colours they
// read as two different tools, which is what a shared MV_GREEN is there to prevent. Checked
// against the hex rather than against the constant, so a change to the house colour has to be
// a deliberate edit here too.
it('MarqueeOverlay: the selection box wears the same green as the frame it becomes', () => {
    const marquee = new MarqueeOverlay()
    const t = new Transformer()
    const partNamed = (parent: Container, name: string) => {
      let found: Shape | null = null
      parent.traversePreOrder((n) => {
        if ((n as Shape).name === name) found = n as Shape
      })
      return found! as Shape
    }
    const isGreen = (fill: RGBA) =>
      near(fill[0], 0x54 / 255, 1e-3) && near(fill[1], 0xb4 / 255, 1e-3) && near(fill[2], 0x35 / 255, 1e-3)

    const wash = partNamed(marquee, '__marquee-fill')
    const border = partNamed(marquee, '__marquee-top')
    assert(isGreen(wash.fill), 'the wash is the mv green')
    assert(isGreen(border.fill), 'and so is the border')
    assert(isGreen(partNamed(t, '__transformer-top').fill), 'the same green the frame is drawn in')

    // Only the alpha differs between them - a wash you can see through, a border you cannot.
    assert(wash.fill[3] < 0.5 && border.fill[3] > 0.5, 'the wash is translucent where the border is not')
})

