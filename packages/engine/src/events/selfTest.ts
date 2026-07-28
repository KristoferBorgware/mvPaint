// Self-test for the scene-graph event core (shapes/Node.ts's on/once/off/fire plus
// events/NodeEvent.ts): registration and namespaces, removal, bubbling and its boundaries,
// enter/leave crossing semantics, delegation, and the listening gate. Pure - no canvas, no
// GPU, no DOM. Run with:
//   npx tsx src/events/selfTest.ts

import { Container } from '../shapes/Container'
import { Node } from '../shapes/Node'
import { deviceFor, eventNamesFor, HOVER_EVENTS, POINTER_ACTIONS } from './eventNames'
import { hasHoverListeners, listenerCount, resetListenerCensus } from './listenerCensus'
import type { NodeEvent } from './NodeEvent'

let count = 0
function assert(cond: boolean, msg: string): void {
  count++
  if (!cond) throw new Error(`[events] self-test FAILED: ${msg}`)
}

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

// --- registration and the event object ---
{
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
}

// --- off(): by type, by namespace, by handler, and wholesale ---
{
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
}

// --- once() ---
{
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
}

// --- bubbling ---
{
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
}

// --- stopPropagation ---
{
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
}

// --- the listening gate ---
{
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
}

// --- enter/leave: bounded by the counterpart node, unlike over/out ---
{
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
}

// --- leaving mirrors entering ---
{
  const { a, b, outside } = tree()
  const left: string[] = []
  for (const node of [a, b, outside]) node.on('pointerleave', (e) => left.push(e.currentTarget.name))
  a.parent?.on('pointerleave', (e) => left.push(e.currentTarget.name))

  a.fire('pointerleave', {}, true, b)
  assert(left.join(',') === 'a', 'leaving for a sibling leaves only that node')

  left.length = 0
  a.fire('pointerleave', {}, true, outside)
  assert(left.join(',') === 'a,group', 'leaving for a cousin also leaves the ancestors actually exited')
}

// --- delegation ---
{
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
}

// --- the handler list is snapshotted per dispatch ---
{
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
}

// --- dispatchEvent / addEventListener / removeEventListener ---
{
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
}

// --- isAncestorOf and the bounded ancestor walk ---
{
  const { root, group, a, outside } = tree()
  assert(group.isAncestorOf(a), 'a parent is an ancestor of its child')
  assert(root.isAncestorOf(a), 'a grandparent is an ancestor too')
  assert(!a.isAncestorOf(group), 'the relationship does not run the other way')
  assert(!a.isAncestorOf(a), 'a node is not its own ancestor')
  assert(!outside.isAncestorOf(a), 'unrelated nodes are not ancestors')

  assert(a.findAncestors('Container').length === 2, 'findAncestors walks the whole chain by default')
  assert(a.findAncestors('Container', false, root).length === 1, 'stopNode bounds the walk below it')
  assert(a.findAncestors('Container', false, group).length === 0, 'stopNode is itself excluded')
}

// --- the name tables ---
{
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
}

// --- the listener census ---
{
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
}

console.log(`[events] self-test passed (${count} assertions)`)
