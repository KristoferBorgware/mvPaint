// The per-frame hook the engine's own furniture hangs off, alongside the application's
// `handle.onFrame`.
//
// onFrame is a single settable property, and deliberately so: it is the application's slot,
// assigned and cleared as freely as any other field. That shape stops working the moment
// something INSIDE the engine also needs a frame - the selection frame refits from whatever
// its nodes are doing, and if it took onFrame it would silently eat an application's
// animation, while an application assigning onFrame would silently stop the frame refitting.
//
// So the two are kept apart. onFrame stays exactly what it was; anything the engine wires up
// for itself subscribes here, and so can an application that wants several frame callbacks
// instead of one. They run after onFrame, because the furniture measures what the animation
// has just moved.

export interface FrameListeners {
  /** Adds a listener; returns the function that removes it again. */
  add(listener: (dt: number) => void): () => void
  /** Runs them all with the frame's delta, in registration order. */
  run(dt: number): void
}

export function createFrameListeners(): FrameListeners {
  const listeners = new Set<(dt: number) => void>()
  return {
    add(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    run(dt) {
      // Iterated directly rather than over a copy: a Set tolerates being edited while it is
      // walked, and this runs sixty times a second - the copy would be the only allocation in
      // an otherwise allocation-free frame.
      for (const listener of listeners) listener(dt)
    },
  }
}
