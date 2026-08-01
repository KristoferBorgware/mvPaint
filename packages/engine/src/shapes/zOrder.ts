// The running number every new Shape takes its zIndex from, so that things stack in the
// order they were made: the first shape is at 0, the next at 1 and therefore in front of it,
// and so on. Drawing something new puts it on top, which is what a drawing tool means by
// drawing, and what every editor's default is.
//
// Higher is in FRONT. That direction is not new - collectZOrder() has always sorted ascending
// and depthForRank() has always turned a higher rank into a nearer depth (see
// scene/picking.ts). What is new is that shapes no longer all sit at 0 and depend on
// scene-traversal order to break the tie.
//
// WHY CREATION ORDER AND NOT TREE ORDER. A shape exists before it is added to anything, and
// may be moved between parents afterwards; neither should silently restack it. Creation order
// is the one ordering that is fixed at the moment the caller thinks about the shape, and it
// survives re-parenting, being taken out of the scene and put back, or being held in a pool.
//
// WHY ONE COUNTER FOR THE WHOLE MODULE rather than one per scene: a Shape is constructed
// without knowing which scene it will join, or whether it will join one at all, so there is
// nowhere else to keep it. Two scenes sharing the counter costs nothing, because a zIndex is
// only ever compared against another zIndex in the same scene.
//
// IT NEVER GOES BACKWARDS ON ITS OWN, which is the whole guarantee - a counter that reset
// would let a new shape land underneath an old one. So the numbers climb for as long as the
// page lives. That is deliberate and it is free: the renderer derives depth from a shape's
// RANK in the sorted list, never from the zIndex value itself (see depthForRank), so how
// large or how spread out the numbers are has no effect on depth precision.

let counter = 0

/**
 * The next stacking number - one higher than the last shape to take one.
 *
 * Called for you by every Shape that is not given an explicit zIndex, so most code never
 * needs it. Reach for it directly to put an EXISTING shape on top of everything:
 *
 *   shape.zIndex = nextZIndex()
 *
 * The mirror image needs no helper. The counter only ever counts up from zero, so any
 * negative zIndex is behind every shape that took its number from here.
 */
export function nextZIndex(): number {
  return counter++
}

/**
 * What nextZIndex() would return, without taking it. For a caller that wants to know where
 * the stack currently tops out - "is this shape the frontmost?" - without disturbing it.
 */
export function peekZIndex(): number {
  return counter
}

/**
 * Wind the counter back, for tests that assert on absolute zIndex values.
 *
 * Nothing in a running application should call this: it is the one operation that can make a
 * newly created shape land underneath an existing one, which is exactly what the counter
 * exists to prevent. It is here for the same reason resetListenerCensus() is - a self-test
 * needs a known starting point, and reaching into module state from the test is worse.
 */
export function resetAutoZIndex(next = 0): void {
  counter = next
}
