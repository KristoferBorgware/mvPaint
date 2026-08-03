// Self-test for the scene-graph event core (shapes/Node.ts's on/once/off/fire plus
// events/NodeEvent.ts): registration and namespaces, removal, bubbling and its boundaries,
// enter/leave crossing semantics, delegation, and the listening gate. Pure - no canvas, no
// GPU, no DOM. Run with:
//   npx vitest run packages/engine/src/events/events.test.ts

import { expect, it } from 'vitest'
import { MarqueeTool } from '../input/MarqueeTool'
import { Vector2 } from '../math/Vector2'
import { Container } from '../shapes/Container'
import { Node } from '../shapes/Node'
import { Rect , type RectOptions } from '../shapes/Rect'
import { Text } from '../shapes/Text'
import type { AttrChangeEvent, ChildEvent, MarqueeEvent } from './sceneEvents'
import { deviceFor, eventNamesFor, HOVER_EVENTS, POINTER_ACTIONS } from './eventNames'
import { hasHoverListeners, listenerCount, resetListenerCensus } from './listenerCensus'
import { SceneInputDispatcher } from '../input/SceneInputDispatcher'
import type { NodeEvent } from './NodeEvent'

/**
 * Every check in this file goes through here, so each one reads as the sentence it is making
 * and vitest reports that sentence when it stops being true.
 */
function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}

/**
 * A Rect CENTRED on (x, y). A Rect's own origin is its top-left corner (see Shape's
 * header), so this applies the pivot offset that puts its middle back on the position -
 * which is the frame the geometry below is written in.
 */
const centredRect = (options: RectOptions = {}): Rect =>
  new Rect({ ...options, offsetX: (options.width ?? 1) / 2, offsetY: -(options.height ?? 1) / 2 })

/**   root
 *     +- group
 *          +- a
 *          +- b
 *     +- outside
 */
function tree() {
  const root = new Container('root')
  const group = root.addChild(new Container('group'))
  const a = group.addChild(new Node('a'))
  const b = group.addChild(new Node('b'))
  const outside = root.addChild(new Node('outside'))
  return { root, group, a, b, outside }
}

it('registration and the event object', () => {
    const node = new Node('n')
    const seen: NodeEvent[] = []
    node.on('click', (e) => seen.push(e))

    assert(node.hasListeners('click'), 'hasListeners reports a registered type')
    assert(!node.hasListeners('pointerdown'), 'hasListeners is false for a type with no handler')

    node.fire('click')
    assert(seen.length === 1, 'fire() runs the handler')
    assert(seen[0].type === 'click', 'the event carries its type')
    assert(seen[0].target === node && seen[0].currentTarget === node, 'target and currentTarget are the node itself')
    assert(seen[0].cancelBubble === false, 'cancelBubble starts false')

    // Anything else passed to fire() rides along on the event - this is how the semantic
    // events carry their payloads (a changed child, an old/new attribute value).
    node.fire('click', { pointerId: 7, detail: 'x' })
    assert(seen[1].pointerId === 7, 'known init fields land on the event')
    assert((seen[1] as NodeEvent & { detail: string }).detail === 'x', 'extra init fields are copied across too')

    let calls = 0
    node.on('one two', () => calls++)
    node.fire('one')
    node.fire('two')
    assert(calls === 2, 'one on() call registers for every space-separated type')
})

it('off(): by type, by namespace, by handler, and wholesale', () => {
    const node = new Node('n')
    let plain = 0
    let scoped = 0
    let other = 0
    const scopedHandler = (): void => {
      scoped++
    }
    node.on('click', () => plain++)
    node.on('click.tool', scopedHandler)
    node.on('press.tool', () => other++)

    node.off('click.tool')
    node.fire('click')
    node.fire('press')
    assert(plain === 1 && scoped === 0 && other === 1, "off('type.ns') removes only that namespace on that type")

    node.on('click.tool', scopedHandler)
    node.off('.tool')
    node.fire('click')
    node.fire('press')
    assert(plain === 2 && scoped === 0 && other === 1, "off('.ns') removes that namespace across every type")

    let kept = 0
    const removed = (): void => {
      scoped++
    }
    node.on('click', removed)
    node.on('click', () => kept++)
    node.off('click', removed)
    node.fire('click')
    assert(scoped === 0 && kept === 1 && plain === 3, 'off(type, handler) removes just that registration')

    node.off()
    node.fire('click')
    assert(plain === 3 && kept === 1, 'off() with no arguments clears everything')
})

it('once()', () => {
    const node = new Node('n')
    let runs = 0
    node.once('click', () => runs++)
    node.fire('click')
    node.fire('click')
    assert(runs === 1, 'once() runs a single time')

    let cleanups = 0
    node.once('pointerup pointercancel', () => cleanups++)
    node.fire('pointerup')
    node.fire('pointercancel')
    assert(cleanups === 1, 'once() over several types runs for the first of them and drops the rest')
})

it('bubbling', () => {
    const { root, group, a } = tree()
    const order: string[] = []
    const targets: string[] = []
    for (const node of [a, group, root]) {
      node.on('click', (e) => {
        order.push(e.currentTarget.name)
        targets.push(e.target.name)
      })
    }

    a.fire('click', {}, true)
    assert(order.join(',') === 'a,group,root', 'a bubbling event walks from the origin up to the root')
    assert(targets.join(',') === 'a,a,a', 'target stays the origin node at every level')

    order.length = 0
    a.fire('click')
    assert(order.join(',') === 'a', 'without bubble only the origin node hears it')
})

it('stopPropagation', () => {
    const { root, group, a } = tree()
    const order: string[] = []
    a.on('click', (e) => {
      order.push('a')
      e.stopPropagation()
    })
    group.on('click', () => order.push('group'))
    root.on('click', () => order.push('root'))

    a.fire('click', {}, true)
    assert(order.join(',') === 'a', 'stopPropagation() halts the walk after the current level')
})

it('the listening gate', () => {
    const { root, group, a } = tree()
    const order: string[] = []
    a.on('click', () => order.push('a'))
    group.on('click', () => order.push('group'))
    root.on('click', () => order.push('root'))

    group.listening = false
    a.fire('click', {}, true)
    assert(order.join(',') === 'a', 'an ancestor with listening off stops the walk and hears nothing itself')

    assert(!a.isListening(), 'isListening() is false when an ancestor has it off')
    assert(root.isListening(), 'isListening() is true for a node whose whole chain is listening')

    group.listening = true
    order.length = 0
    a.fire('click', {}, true)
    assert(order.join(',') === 'a,group,root', 'switching listening back on restores the walk')

    // A direct fire() is an explicit call, not an event arriving, so it always runs.
    order.length = 0
    a.listening = false
    a.fire('click', {}, true)
    assert(order[0] === 'a', "a node's own listeners still run when fire() is called on it directly")
})

it('enter/leave: bounded by the counterpart node, unlike over/out', () => {
    const { root, group, a, b, outside } = tree()
    const entered: string[] = []
    const over: string[] = []
    for (const node of [root, group, a, b, outside]) {
      node.on('pointerenter', (e) => entered.push(e.currentTarget.name))
      node.on('pointerover', (e) => over.push(e.currentTarget.name))
    }

    // Between two siblings: their shared ancestors were never entered.
    b.fire('pointerenter', {}, true, a)
    assert(entered.join(',') === 'b', 'moving between siblings enters only the new one')

    entered.length = 0
    outside.fire('pointerenter', {}, true, a)
    assert(entered.join(',') === 'outside', 'entering from a cousin still stops below the shared ancestor')

    entered.length = 0
    a.fire('pointerenter', {}, true, outside)
    assert(entered.join(',') === 'a,group', 'entering a nested node also enters the ancestors newly crossed into')

    entered.length = 0
    a.fire('pointerenter', {}, true)
    assert(entered.join(',') === 'a,group', 'with no counterpart the walk still stops short of the root')

    // over/out are the bubbling counterparts and ignore the boundary entirely.
    b.fire('pointerover', {}, true, a)
    assert(over.join(',') === 'b,group,root', 'over bubbles the whole way regardless of the counterpart')
})

it('leaving mirrors entering', () => {
    const { a, b, outside } = tree()
    const left: string[] = []
    for (const node of [a, b, outside]) node.on('pointerleave', (e) => left.push(e.currentTarget.name))
    a.parent?.on('pointerleave', (e) => left.push(e.currentTarget.name))

    a.fire('pointerleave', {}, true, b)
    assert(left.join(',') === 'a', 'leaving for a sibling leaves only that node')

    left.length = 0
    a.fire('pointerleave', {}, true, outside)
    assert(left.join(',') === 'a,group', 'leaving for a cousin also leaves the ancestors actually exited')
})

it('delegation', () => {
    const root = new Container('root')
    const group = root.addChild(new Container('group'))
    const a = group.addChild(new Node('a'))
    a.addName('target')
    const b = group.addChild(new Node('b'))

    const hits: string[] = []
    root.on('click', '.target', (e) => hits.push(e.currentTarget.name))

    a.fire('click', {}, true)
    assert(hits.join(',') === 'a target', 'a delegated handler runs with currentTarget set to the match')

    hits.length = 0
    b.fire('click', {}, true)
    assert(hits.length === 0, 'a non-matching origin runs nothing')

    // The match may be an ancestor of the origin, not just the origin itself.
    hits.length = 0
    group.addName('target')
    b.fire('click', {}, true)
    assert(hits.join(',') === 'group target', 'delegation matches ancestors between the origin and the listening node')

    // The delegating node itself is the boundary, so it never matches its own selector.
    hits.length = 0
    root.addName('target')
    a.fire('click', {}, true)
    assert(!hits.includes('root target'), 'the node holding the delegated listener is excluded from its own matches')
})

it('the handler list is snapshotted per dispatch', () => {
    const node = new Node('n')
    const order: string[] = []
    const second = (): void => {
      order.push('second')
    }
    node.on('click', () => {
      order.push('first')
      node.off('click', second)
      node.on('click', () => order.push('added-during'))
    })
    node.on('click', second)

    node.fire('click')
    assert(order.join(',') === 'first,second', 'removing during a dispatch does not skip an already-scheduled handler')
    assert(!order.includes('added-during'), 'a handler registered during a dispatch is not run by that same dispatch')

    order.length = 0
    node.fire('click')
    assert(order.includes('added-during') && !order.includes('second'), 'both changes take effect on the next dispatch')
})

it('dispatchEvent / addEventListener / removeEventListener', () => {
    const node = new Node('n')
    let runs = 0
    const handler = (): void => {
      runs++
    }
    node.addEventListener('click', handler)
    node.fire('click')
    assert(runs === 1, 'addEventListener registers like on()')
    node.removeEventListener('click', handler)
    node.fire('click')
    assert(runs === 1, 'removeEventListener removes like off()')

    const other = new Node('other')
    node.on('custom', (e) => {
      runs++
      assert(e.target === other, 'dispatchEvent keeps the origin the event was built with')
      assert(e.currentTarget === node, 'dispatchEvent runs with currentTarget set to the receiving node')
    })
    node.dispatchEvent({ type: 'custom', target: other, currentTarget: other, cancelBubble: false, stopPropagation() {} })
    assert(runs === 2, 'dispatchEvent dispatches a prebuilt event')
})

it('isAncestorOf and the bounded ancestor walk', () => {
    const { root, group, a, outside } = tree()
    assert(group.isAncestorOf(a), 'a parent is an ancestor of its child')
    assert(root.isAncestorOf(a), 'a grandparent is an ancestor too')
    assert(!a.isAncestorOf(group), 'the relationship does not run the other way')
    assert(!a.isAncestorOf(a), 'a node is not its own ancestor')
    assert(!outside.isAncestorOf(a), 'unrelated nodes are not ancestors')

    assert(a.findAncestors('Container').length === 2, 'findAncestors walks the whole chain by default')
    assert(a.findAncestors('Container', false, root).length === 1, 'stopNode bounds the walk below it')
    assert(a.findAncestors('Container', false, group).length === 0, 'stopNode is itself excluded')
})

it('the name tables', () => {
    assert(deviceFor('mouse') === 'mouse', 'a mouse is a mouse')
    assert(deviceFor('pen') === 'mouse', 'a pen groups with the mouse family')
    assert(deviceFor('touch') === 'touch', 'a finger is its own family')
    assert(deviceFor('') === 'mouse', 'an unreported pointer type falls back to the mouse family')

    assert(eventNamesFor('pointerdown', 'mouse').join(',') === 'pointerdown,mousedown', 'a mouse press fires both its names')
    assert(eventNamesFor('pointerdown', 'touch').join(',') === 'pointerdown,touchstart', 'a touch press fires the touch alias')
    assert(eventNamesFor('pointerclick', 'mouse').join(',') === 'pointerclick,click', 'a synthesized click carries the plain name')
    assert(eventNamesFor('pointerclick', 'touch').join(',') === 'pointerclick,tap', 'the touch equivalent of a click is a tap')
    assert(eventNamesFor('pointerdblclick', 'touch').join(',') === 'pointerdblclick,dbltap', 'and of a double click, a double tap')

    const pairs = POINTER_ACTIONS.flatMap((action) => [eventNamesFor(action, 'mouse'), eventNamesFor(action, 'touch')])
    assert(pairs.every((names) => names.length === 2), 'every action resolves to exactly two names')
    assert(
      POINTER_ACTIONS.every(
        (action) => eventNamesFor(action, 'mouse')[0] === action && eventNamesFor(action, 'touch')[0] === action,
      ),
      'the canonical pointer name comes first on both devices, so it always fires',
    )
    assert(
      POINTER_ACTIONS.every((action) => {
        const mouse = eventNamesFor(action, 'mouse')[1]
        const touch = eventNamesFor(action, 'touch')[1]
        return mouse !== action && touch !== action && mouse !== touch
      }),
      'the two device aliases are distinct from the canonical name and from each other',
    )
    assert(new Set(pairs.flat()).size === POINTER_ACTIONS.length * 3, 'no name is reused across actions')

    assert(
      eventNamesFor('pointermove', 'mouse') === eventNamesFor('pointermove', 'mouse'),
      'the name arrays are shared, so dispatching allocates nothing',
    )

    const hover = ['pointermove', 'mousemove', 'touchmove', 'pointerover', 'mouseout', 'touchenter', 'pointerleave']
    assert(hover.every((name) => HOVER_EVENTS.has(name)), 'every move/over/out/enter/leave name across all three families counts as hover')
    const notHover = ['pointerdown', 'mousedown', 'touchstart', 'click', 'tap', 'pointerup', 'wheel']
    assert(notHover.every((name) => !HOVER_EVENTS.has(name)), 'press, release and click do not, since they need no per-move hit-test')
})

it('the listener census', () => {
    resetListenerCensus()
    assert(listenerCount('click') === 0 && !hasHoverListeners(), 'the census starts empty')

    const a = new Node('a')
    const b = new Node('b')
    const noop = (): void => {}

    a.on('click', noop)
    assert(listenerCount('click') === 1, 'on() counts a listener')
    assert(!hasHoverListeners(), 'a click listener does not make the input layer start hit-testing every move')

    b.on('click', noop)
    assert(listenerCount('click') === 2, 'the count spans every node, not just one')

    a.off('click')
    assert(listenerCount('click') === 1, "off() discounts only the node it was called on")
    b.off('click')
    assert(listenerCount('click') === 0, 'the count returns to zero once the last one goes')

    // The gate the whole tally exists for.
    a.on('pointermove', noop)
    assert(hasHoverListeners(), 'a hover listener turns per-move hit-testing on')
    a.off('pointermove')
    assert(!hasHoverListeners(), 'and removing it turns it back off')

    a.on('mouseenter', noop)
    assert(hasHoverListeners(), 'a device-alias hover name counts the same as the canonical one')
    a.off('mouseenter')
    assert(!hasHoverListeners(), 'removing the alias clears it too')

    // Every removal path has to discount, or the gate would latch on forever.
    a.on('click.tool pointermove.tool', noop)
    assert(listenerCount('click') === 1 && hasHoverListeners(), 'a namespaced registration counts like any other')
    a.off('.tool')
    assert(listenerCount('click') === 0 && !hasHoverListeners(), 'a namespace removal discounts everything it removed')

    a.on('click', noop)
    a.on('pointermove', noop)
    a.off()
    assert(listenerCount('click') === 0 && !hasHoverListeners(), 'off() with no arguments discounts the whole node')

    let onceRuns = 0
    a.once('pointerover', () => onceRuns++)
    assert(hasHoverListeners(), 'a once() registration counts while it is still pending')
    a.fire('pointerover')
    assert(onceRuns === 1 && !hasHoverListeners(), 'and discounts itself when it fires')

    a.on('click', noop)
    a.off('click', () => {})
    assert(listenerCount('click') === 1, 'removing a handler that was never registered discounts nothing')
    a.off('click', noop)
    assert(listenerCount('click') === 0, 'removing the real one does')

    resetListenerCensus()
    assert(listenerCount('click') === 0 && !hasHoverListeners(), 'resetting clears the tally outright')
})

//
// Driven with no canvas at all, a stub hit-test and a controllable clock, so press/move/
// release sequences and the double-click window can be exercised exactly.
it('SceneInputDispatcher: raw input to scene-graph events', () => {
    // Shapes rather than plain Nodes, because that is what a real hit-test returns; nothing
    // here depends on their geometry.
    interface Harness {
      root: Container
      group: Container
      a: Rect
      b: Rect
      log: string[]
      dispatcher: SceneInputDispatcher
      hover: (node: Rect | null) => void
      at: (time: number) => void
    }

    function harness(listenFor: string, nodes?: (h: Omit<Harness, 'dispatcher' | 'hover' | 'at'>) => void): Harness {
      resetListenerCensus()
      const root = new Container('root')
      const group = root.addChild(new Container('group'))
      const a = group.addChild(centredRect({ name: 'a' }))
      const b = group.addChild(centredRect({ name: 'b' }))
      const log: string[] = []
      const base = { root, group, a, b, log }

      if (nodes) nodes(base)
      else {
        for (const node of [root, group, a, b]) {
          node.on(listenFor, (e) => log.push(`${e.type}@${e.currentTarget.name}`))
        }
      }

      let under: Rect | null = null
      let time = 0
      const dispatcher = new SceneInputDispatcher(null, {
        root,
        pick: () => under,
        now: () => time,
        tapThreshold: 6,
        dblClickWindow: 400,
      })
      return {
        ...base,
        dispatcher,
        hover: (node) => {
          under = node
        },
        at: (t) => {
          time = t
        },
      }
    }

    const mouse = { pointerId: 1, pointerType: 'mouse' }
    const finger = { pointerId: 2, pointerType: 'touch' }
    const origin = { x: 0, y: 0 }

    // Both names for one press, and both bubble.
    {
      const h = harness('pointerdown mousedown touchstart')
      h.dispatcher.down(mouse, origin, h.a)
      assert(
        h.log.join(' ') === 'pointerdown@a pointerdown@group pointerdown@root mousedown@a mousedown@group mousedown@root',
        'a mouse press fires the canonical name and the mouse alias, each bubbling to the root',
      )

      h.log.length = 0
      h.dispatcher.down(finger, origin, h.a)
      assert(
        h.log.join(' ').includes('touchstart@a') && !h.log.join(' ').includes('mousedown@a'),
        'a touch press fires the touch alias instead',
      )
    }

    // Empty space is the root.
    {
      const h = harness('pointerdown')
      h.dispatcher.down(mouse, origin, null)
      assert(h.log.join(' ') === 'pointerdown@root', 'a press on empty space fires on the scene root')
    }

    // A node that is not listening is treated as empty space rather than swallowing the event.
    {
      const h = harness('pointerdown')
      h.a.listening = false
      h.dispatcher.down(mouse, origin, h.a)
      assert(h.log.join(' ') === 'pointerdown@root', 'a press on a node with listening off falls through to the root')
    }

    // One event object across both names, so stopping one stops the other.
    {
      const h = harness('', ({ root, group, a, log }) => {
        a.on('pointerdown', (e) => {
          log.push('pointerdown@a')
          e.stopPropagation()
        })
        a.on('mousedown', () => log.push('mousedown@a'))
        group.on('pointerdown', () => log.push('pointerdown@group'))
        group.on('mousedown', () => log.push('mousedown@group'))
        root.on('mousedown', () => log.push('mousedown@root'))
      })
      h.dispatcher.down(mouse, origin, h.a)
      assert(
        h.log.join(' ') === 'pointerdown@a mousedown@a',
        'stopping propagation on the canonical name also keeps the alias from reaching the ancestors',
      )
    }

    // Hover crossings.
    {
      const h = harness('pointerover pointerout pointerenter pointerleave')
      h.hover(h.a)
      h.dispatcher.move(mouse, origin)
      assert(
        h.log.join(' ') === 'pointerover@a pointerover@group pointerover@root pointerenter@a pointerenter@group',
        'entering a node fires over up the whole chain, but enter only as far as was newly crossed into',
      )

      h.log.length = 0
      h.hover(h.b)
      h.dispatcher.move(mouse, origin)
      assert(
        h.log.join(' ') ===
          'pointerout@a pointerout@group pointerout@root pointerleave@a pointerover@b pointerover@group pointerover@root pointerenter@b',
        'moving between siblings leaves and enters only them, though out and over still bubble',
      )

      h.log.length = 0
      h.dispatcher.move(mouse, origin)
      assert(h.log.length === 0, 'a move that stays on the same node crosses nothing')

      h.log.length = 0
      h.hover(null)
      h.dispatcher.move(mouse, origin)
      assert(
        h.log.join(' ') === 'pointerout@b pointerout@group pointerout@root pointerleave@b pointerleave@group',
        'moving onto empty space leaves the node and its ancestors, with nothing entered',
      )
    }

    // The census gate: no hover listener anywhere means no hit-test at all.
    {
      resetListenerCensus()
      const root = new Container('root')
      let picks = 0
      const dispatcher = new SceneInputDispatcher(null, {
        root,
        pick: () => {
          picks++
          return null
        },
      })
      dispatcher.move(mouse, origin)
      assert(picks === 0, 'with nothing listening for a hover event, a move hit-tests nothing')

      root.on('pointermove', () => {})
      dispatcher.move(mouse, origin)
      assert(picks === 1, 'registering a hover listener is what turns per-move hit-testing on')
    }

    // Click and double click.
    {
      const h = harness('pointerclick click pointerdblclick dblclick')
      h.hover(h.a)
      h.dispatcher.down(mouse, origin, h.a)
      h.dispatcher.up(mouse, origin)
      assert(
        h.log.join(' ') === 'pointerclick@a pointerclick@group pointerclick@root click@a click@group click@root',
        'a press and release on one node makes a click under both names',
      )

      h.log.length = 0
      h.at(100)
      h.dispatcher.down(mouse, origin, h.a)
      h.dispatcher.up(mouse, origin)
      assert(h.log.some((entry) => entry === 'pointerdblclick@a'), 'a second click on the same node inside the window makes a double')

      h.log.length = 0
      h.at(200)
      h.dispatcher.down(mouse, origin, h.a)
      h.dispatcher.up(mouse, origin)
      assert(
        !h.log.some((entry) => entry === 'pointerdblclick@a'),
        'the count starts over afterwards, so three clicks are not two doubles',
      )

      h.log.length = 0
      h.at(1000)
      h.dispatcher.down(mouse, origin, h.a)
      h.dispatcher.up(mouse, origin)
      assert(h.log.some((entry) => entry === 'pointerclick@a'), 'a click well after the previous one still clicks')
      assert(!h.log.some((entry) => entry === 'pointerdblclick@a'), 'but is too late to be a double')
    }

    // What stops a click being a click.
    {
      const h = harness('pointerclick')
      h.hover(h.a)
      h.dispatcher.down(mouse, origin, h.a)
      h.dispatcher.up(mouse, { x: 40, y: 0 })
      assert(h.log.length === 0, 'a pointer that wandered too far between press and release meant a drag, not a click')

      h.log.length = 0
      h.dispatcher.down(mouse, origin, h.a)
      h.hover(h.b)
      h.dispatcher.up(mouse, origin)
      assert(h.log.length === 0, 'pressing one node and releasing over another is not a click on either')
    }

    // A touch click is a tap.
    {
      const h = harness('tap click')
      h.hover(h.a)
      h.dispatcher.down(finger, origin, h.a)
      h.dispatcher.up(finger, origin)
      assert(h.log.join(' ').includes('tap@a') && !h.log.join(' ').includes('click@a'), 'a finger taps rather than clicks')
    }

    // Cancellation takes the click away.
    {
      const h = harness('pointerclick pointercancel')
      h.hover(h.a)
      h.dispatcher.down(mouse, origin, h.a)
      h.dispatcher.cancel(mouse, origin)
      h.dispatcher.up(mouse, origin)
      assert(
        h.log.some((entry) => entry.startsWith('pointercancel@')) && !h.log.some((entry) => entry.startsWith('pointerclick@')),
        'a cancelled press cancels, and its release no longer counts as a click',
      )
    }

    // Pointer capture.
    {
      const h = harness('pointermove gotpointercapture lostpointercapture')
      h.hover(h.b)
      h.dispatcher.setPointerCapture(mouse.pointerId, h.a)
      assert(h.log.some((entry) => entry === 'gotpointercapture@a'), 'taking capture tells the node')
      assert(h.dispatcher.getCapture(mouse.pointerId) === h.a, 'and is readable back')

      h.log.length = 0
      h.dispatcher.move(mouse, origin)
      assert(
        h.log[0] === 'pointermove@a',
        'a captured pointer reports to the capturing node even while over a different one',
      )

      h.log.length = 0
      h.dispatcher.up(mouse, origin)
      assert(h.log.some((entry) => entry === 'lostpointercapture@a'), 'the release drops the capture')
      assert(h.dispatcher.getCapture(mouse.pointerId) === null, 'and it is gone afterwards')
    }

    // Leaving the canvas.
    {
      const h = harness('pointerleave')
      h.hover(h.a)
      h.dispatcher.move(mouse, origin)
      h.log.length = 0
      h.dispatcher.leave(mouse, origin)
      assert(h.log.join(' ') === 'pointerleave@a pointerleave@group', 'the pointer leaving the canvas leaves whatever it was over')
      assert(h.dispatcher.getHoverTarget(mouse.pointerId) === null, 'and nothing is hovered afterwards')
    }

    // Two pointers hover independently.
    {
      const h = harness('pointerenter')
      h.hover(h.a)
      h.dispatcher.move(mouse, origin)
      h.hover(h.b)
      h.dispatcher.move(finger, origin)
      assert(h.dispatcher.getHoverTarget(mouse.pointerId) === h.a, 'one pointer keeps its own hover target')
      assert(h.dispatcher.getHoverTarget(finger.pointerId) === h.b, 'while another tracks a different one')
    }

    // Wheel and context menu.
    {
      const h = harness('wheel contextmenu')
      h.hover(h.a)
      h.dispatcher.wheel(mouse, origin)
      assert(h.log.join(' ') === 'wheel@a wheel@group wheel@root', 'the wheel fires on the node under it and bubbles')

      h.log.length = 0
      h.dispatcher.contextMenu(mouse, origin)
      assert(h.log.join(' ') === 'contextmenu@a contextmenu@group contextmenu@root', 'so does the context menu')
    }

    resetListenerCensus()
})

it('attribute change events', () => {
    resetListenerCensus()
    const root = new Container('root')
    const rect = root.addChild(centredRect({ x: 1, fill: [1, 0, 0, 1] }))
    const seen: AttrChangeEvent[] = []
    const atRoot: string[] = []
    rect.on('xChange', (e) => seen.push(e as AttrChangeEvent))
    root.on('xChange', (e) => atRoot.push(`${e.type}@${e.currentTarget.name || 'root'}`))

    rect.setAttr('x', 5)
    assert(seen.length === 1, 'setAttr raises the attribute change event')
    assert(seen[0].type === 'xChange' && seen[0].attr === 'x', 'named after the attribute, and carrying its name')
    assert(seen[0].oldVal === 1 && seen[0].newVal === 5, 'with the values on either side of the change')
    assert(seen[0].target === rect, 'targeted at the node that changed')
    assert(atRoot.length === 1, 'and bubbling, so a container can watch its subtree')

    rect.setAttr('x', 5)
    assert(seen.length === 1, 'setting the same value again reports nothing')

    // Direct assignment deliberately does not raise it - the attributes are plain fields.
    rect.x = 99
    assert(seen.length === 1, 'assigning the field directly does not raise a change event')

    // Identity comparison: a replaced array is a change, an edited one is not.
    const fills: AttrChangeEvent[] = []
    rect.on('fillChange', (e) => fills.push(e as AttrChangeEvent))
    rect.setAttr('fill', [0, 1, 0, 1])
    assert(fills.length === 1, 'replacing an array attribute is a change')
    const sameArray = rect.fill
    ;(sameArray as unknown as number[])[0] = 0.5
    rect.setAttr('fill', sameArray)
    assert(fills.length === 1, 'handing back the same array is not, however it was edited in place')

    // A change routed through a dedicated setter still reports.
    const runs: AttrChangeEvent[] = []
    const text = root.addChild(new Text({ text: 'a' }))
    text.on('runsChange', (e) => runs.push(e as AttrChangeEvent))
    text.setAttr('runs', [{ text: 'b' }])
    assert(runs.length === 1 && text.runs[0].text === 'b', 'an attribute written through its own setter reports too')

    resetListenerCensus()
})

it('add and remove', () => {
    resetListenerCensus()
    const root = new Container('root')
    const group = root.addChild(new Container('group'))
    const log: string[] = []
    root.on('add remove', (e) => {
      const child = (e as ChildEvent).child
      log.push(`${e.type} child=${child.name} on=${e.currentTarget.name}`)
    })

    const leaf = group.addChild(new Node('leaf'))
    assert(log.join('') === 'add child=leaf on=root', 'adding a child raises add, bubbling from the container it joined')

    log.length = 0
    group.removeChild(leaf)
    assert(log.join('') === 'remove child=leaf on=root', 'removing it raises remove, from the container it left')

    log.length = 0
    group.removeChild(leaf)
    assert(log.length === 0, 'removing something that was never there raises nothing')

    // The container is the target, so the event still has ancestors to travel through - the
    // child is detached by the time remove goes out and would reach nothing on its own.
    const targets: string[] = []
    root.on('remove', (e) => targets.push(e.target.name))
    const other = group.addChild(new Node('other'))
    group.removeChild(other)
    assert(targets.join('') === 'group', 'remove is targeted at the container, not at the departed child')

    resetListenerCensus()
})

it('MarqueeTool: geometry and announcements, with no opinion about what it means', () => {
    resetListenerCensus()
    const root = new Container('root')
    const covered = [centredRect({ name: 'a' }), centredRect({ name: 'b' })]
    let resolveCalls = 0
    const tool = new MarqueeTool(root, () => {
      resolveCalls++
      return covered
    })

    const log: string[] = []
    root.on('marqueestart marqueemove marqueeend', (e) => {
      const m = e as MarqueeEvent
      const names = m.nodes ? ` nodes=${m.nodes.map((n) => n.name).join('+') || 'none'}` : ''
      log.push(`${e.type} ${m.from.x},${m.from.y} -> ${m.to.x},${m.to.y}${names}`)
    })

    assert(!tool.active && tool.corners === null, 'a fresh tool is idle')

    tool.begin(new Vector2(10, 20))
    assert(tool.active, 'begin() starts one')
    assert(log.join('|') === 'marqueestart 10,20 -> 10,20', 'which starts as a degenerate rectangle at that point')

    log.length = 0
    tool.update(new Vector2(50, 60))
    assert(log.join('|') === 'marqueemove 10,20 -> 50,60', 'update() moves the free corner and keeps the anchored one')
    assert(tool.corners?.from.x === 10 && tool.corners?.to.x === 50, 'and the corners read back')

    log.length = 0
    const result = tool.end()
    assert(resolveCalls === 1, 'end() resolves the rectangle exactly once')
    assert(result === covered, 'and hands back what it covered')
    assert(log.join('|') === 'marqueeend 10,20 -> 50,60 nodes=a+b', 'announcing the same on the event')
    assert(!tool.active, 'and goes idle')

    // A rectangle that is abandoned still ends, but resolves nothing.
    log.length = 0
    resolveCalls = 0
    tool.begin(new Vector2(1, 2))
    tool.update(new Vector2(3, 4))
    tool.cancel()
    assert(resolveCalls === 0, 'cancel() does not resolve what the rectangle covered')
    assert(log.join('|') === 'marqueestart 1,2 -> 1,2|marqueemove 1,2 -> 3,4|marqueeend 1,2 -> 3,4 nodes=none', 'but still ends, carrying nothing')
    assert(!tool.active, 'and goes idle too')

    // Calls that arrive with nothing in progress are ignored rather than announced.
    log.length = 0
    tool.update(new Vector2(9, 9))
    assert(log.length === 0 && !tool.active, 'update() with no marquee in progress does nothing')
    assert(tool.end().length === 0 && log.length === 0, 'end() likewise')
    tool.cancel()
    assert(log.length === 0, 'and cancel()')

    resetListenerCensus()
})
