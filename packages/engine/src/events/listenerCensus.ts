// A running tally of how many listeners exist for each event type, kept up to date by
// Node's on()/off().
//
// It exists for one reason: delivering a hover event (move, over/out, enter/leave) means
// working out which node is under the pointer, which is a hit-test on every single pointer
// move. A scene of a hundred thousand shapes cannot afford that speculatively. The input
// layer asks hasHoverListeners() first and skips the whole hit-test when the answer is no,
// so a scene that never registers a hover handler pays exactly nothing - the cost arrives
// only alongside the thing that needs it.
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

/** Drops the whole tally. For tests, and for tearing an application down. */
export function resetListenerCensus(): void {
  counts.clear()
  hoverCount = 0
}
