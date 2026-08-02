// Two counters saying "some node's CONTENT changed since you last looked".
//
// The lanes rebuild their shared GPU buffers only when they have to, and until now the only
// things that could tell them so were the visible set changing and an explicit dirty call on
// the renderer. That left a gap a caller falls into easily: invalidating a node - a Circle's
// radius, a Polyline's points, a Text's runs or its curve - correctly drops that node's own
// cache, but nothing told the renderer, so the buffers kept the geometry they were packed
// with and the change simply did not appear until something unrelated forced a rebuild.
// Animating a node's content rather than its transform hit it every frame.
//
// A counter per lane rather than a flag per node is what keeps this free: the renderer
// compares one integer, not one per visible node, which matters when the visible set is in
// the tens of thousands. The cost is precision - any node bumping the counter rebuilds the
// whole lane, and a node belonging to some other scene bumps it just the same - but a
// needless rebuild is only slow, while a missed one is wrong, and rebuilds are rare next to
// frames.
//
// Transforms deliberately do NOT bump anything. They are re-uploaded every frame from the
// world matrix and never baked into the packed buffers, so moving, scaling or spinning a
// node has always worked and still costs nothing.
//
// The one thing that does is a shape whose stroke was told not to follow its scale (see
// Shape.strokeScaleEnabled), because that stroke IS baked and the scale is what it was baked
// against. It goes through markGeometryDirty() like any other geometry change and lands here
// as an ordinary mesh bump - not a special case, just the one transform that is also content.

let meshEpochCounter = 0
let textEpochCounter = 0

/** Called by Shape.markGeometryDirty(): this node's tessellated geometry has changed. */
export function bumpMeshGeometryEpoch(): void {
  meshEpochCounter++
}

/** Called when a text node re-shapes: its glyph quads have changed. */
export function bumpTextShapingEpoch(): void {
  textEpochCounter++
}

export function meshGeometryEpoch(): number {
  return meshEpochCounter
}

export function textShapingEpoch(): number {
  return textEpochCounter
}

// --- object records: "did any object's per-frame data change?" ------------------------------
//
// The third counter, and the one that answers a different question from the two above. Those
// say the packed GEOMETRY is stale. This one says a per-object RECORD is - the transform,
// depth, opacity and paint the batchers refresh every frame without touching geometry at all.
//
// It exists because refreshing them was the last thing in the engine that was O(everything
// visible) whether or not anything had happened. The batchers skip a slot whose values are
// unchanged, but they could only find that out by looking, and looking at a hundred thousand
// objects costs about 40 ms: two function calls and a couple of dozen property reads each, to
// conclude every time that there was nothing to do.
//
// So the record-relevant properties announce themselves instead. Every setter that can change
// what lands in a record bumps this - Node's nine transform fields (a world matrix is a chain,
// so an ancestor moving is covered by the ancestor's own bump), reparenting, and Shape's
// opacity, zIndex, fill, stroke, fillPriority and gradient parameters. When the counter has
// not moved and the visible set is the same objects in the same order, a frame's whole
// updateObjects pass is provably a no-op and is skipped.
//
// A counter rather than per-node flags, for the reason the two above are: the renderer
// compares one integer instead of one per visible object, and a needless refresh is only slow
// where a missed one is wrong. The setters guard on the value actually differing, so writing a
// node's own value back - which the transformer does to its handles every frame - bumps
// nothing.
//
// THE ONE THING TO KNOW: a value assigned is seen; a value edited in place is not.
// `shape.fillLinearGradientStartPoint = { x, y }` announces itself, while reaching through the
// property to write `.x` does not, and neither does editing a colour tuple through a cast.
// That is the same convention Matrix4x4 and the colour tuples already rely on (both are
// treated as immutable once handed out), now with a consequence attached.

let objectEpochCounter = 0

/** Announces that some object's transform, depth, opacity or paint has changed. */
export function bumpObjectRecordEpoch(): void {
  objectEpochCounter++
}

export function objectRecordEpoch(): number {
  return objectEpochCounter
}
