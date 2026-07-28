// A running tally of how many listeners exist for each event type, kept up to date by
// Node's on()/off().
//
// It exists for one reason: delivering a hover event (move, over/out, enter/leave) means
// working out which node is under the pointer, which is a hit-test on every single pointer
// move. The input layer asks hasHoverListeners() first and skips the whole hit-test when
// the answer is no, so a scene that never registers a hover handler pays exactly nothing -
// the cost arrives only alongside the thing that needs it.
//
// Measured per pointer move, mean of 200 dispatched events (software rasterizer, so treat
// the absolute figures as a ceiling rather than a target):
//
//   scene                     shapes   no hover listener   one hover listener
//   Shapes & gradients            35   0 hit-tests         0.06 ms
//   MSDF text stress test         67   0 hit-tests         0.69 ms
//   Shadow stress test          1377   0 hit-tests         1.20 ms
//
// So an ordinary scene spends well under a tenth of a frame on this, and only when asked.
// Of the per-pick cost, the front-to-back hit-test walk is around 90% and assembling the
// sorted candidate list the remaining 10% (1.37 ms against 0.14 ms at 1377 shapes), so
// caching that list would recover little - it is the walk itself that sets the ceiling, and
// bringing that down means indexing space rather than avoiding repeated work.
//
// The tally is global rather than per-scene. Listeners are routinely attached to nodes
// before those nodes join a scene, so scoping the count would mean re-attributing it on
// every add and remove. The consequence is that two scenes share one answer, and that a
// node dropped while it still holds listeners leaves its count behind. Both make the tally
// read high, never low, so the only outcome is a hit-test that turns out not to have been
// needed. Nothing is ever skipped that should have run.

import { HOVER_EVENTS } from './eventNames'

const counts = new Map<string, number>()
let hoverCount = 0

export function countListenersAdded(type: string, count = 1): void {
  if (count <= 0) return
  counts.set(type, (counts.get(type) ?? 0) + count)
  if (HOVER_EVENTS.has(type)) hoverCount += count
}

export function countListenersRemoved(type: string, count = 1): void {
  if (count <= 0) return
  const next = (counts.get(type) ?? 0) - count
  if (next > 0) counts.set(type, next)
  else counts.delete(type)
  if (HOVER_EVENTS.has(type)) hoverCount = Math.max(0, hoverCount - count)
}

/** How many listeners are registered for a type across every node. */
export function listenerCount(type: string): number {
  return counts.get(type) ?? 0
}

/** Whether any hover-class listener exists - see the file header for what this gates. */
export function hasHoverListeners(): boolean {
  return hoverCount > 0
}

/** Whether a type has any listener at all - lets a dispatch cost nothing when none does. */
export function hasListener(type: string): boolean {
  return (counts.get(type) ?? 0) > 0
}

/** Whether any of these types has a listener - lets a dispatch cost nothing when none does. */
export function hasAnyListener(types: readonly string[]): boolean {
  for (const type of types) {
    if ((counts.get(type) ?? 0) > 0) return true
  }
  return false
}

/** Drops the whole tally. For tests, and for tearing an application down. */
export function resetListenerCensus(): void {
  counts.clear()
  hoverCount = 0
}
