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
