// Three counters saying "some node's CONTENT changed since you last looked".
//
// The lanes rebuild their shared GPU buffers only when they have to, and until now the only
// things that could tell them so were the visible set changing and an explicit dirty call on
// the renderer. That left a gap a caller falls into easily: invalidating a node - a Circle's
// radius, a Polyline's points, an MSDFText's runs or its curve - correctly drops that node's own
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
let imageEpochCounter = 0

/** Called by Shape.markGeometryDirty(): this node's tessellated geometry has changed. */
export function bumpMeshGeometryEpoch(): void {
  meshEpochCounter++
}

/** Called when a text node re-shapes: its glyph quads have changed. */
export function bumpTextShapingEpoch(): void {
  textEpochCounter++
}

/**
 * Called when an Image changes something the image lane packs rather than reads per frame:
 * its texture, the source rectangle, the fit, tiling, flipping, the wrap mode, the filter, or
 * the quad's own size.
 *
 * The image lane needs its own counter because an Image sits in two of them. Its quad is
 * tessellated like any mesh shape - which is what gives it a hit test, bounds and a shadow
 * silhouette - while the pixels are drawn from a separately packed buffer, and the two go stale
 * on different events. Resizing an Image is both; changing its crop is only this.
 */
export function bumpImageGeometryEpoch(): void {
  imageEpochCounter++
}

export function meshGeometryEpoch(): number {
  return meshEpochCounter
}

export function textShapingEpoch(): number {
  return textEpochCounter
}

export function imageGeometryEpoch(): number {
  return imageEpochCounter
}

// --- fonts: "are the metrics a cached layout was shaped against still the current ones?" -----
//
// The fourth question, and the one the three counters above cannot answer. They say a node's own
// content changed. This says the FONTS changed underneath every node at once - which happens
// when an application loads an atlas at runtime (handle.setMSDFFonts) rather than handing one to
// createSceneRenderer.
//
// A separate counter is needed because MSDFText.shaped() memoizes, and its cache is keyed on
// nothing: it takes a FontProvider as an argument and then ignores it for the life of the
// cache. That is right for the common case - the fonts never change, and re-shaping a
// paragraph on every access would be absurd - but it means a new atlas would leave every
// existing MSDFText drawing a layout measured against the old metrics: right glyphs, wrong
// advances, wrong wrap points. Bumping the text epoch alone does not fix it, because that
// repacks the lane from exactly those stale caches.
//
// A counter rather than a walk over the scene, for the usual reason and one more: an MSDFText that
// is not in any scene yet, or is in a different one, has to re-shape too, and no walk finds it.

let fontEpochCounter = 0

/** Called when an MSDFFontBook's atlases are replaced: every cached layout was measured wrong. */
export function bumpFontEpoch(): void {
  fontEpochCounter++
}

export function fontEpoch(): number {
  return fontEpochCounter
}

// --- object records: "did any object's per-frame data change?" ------------------------------
//
// The fifth counter, and the one that answers a different question from the three geometry ones.
// Those say the packed GEOMETRY is stale. This one says a per-object RECORD is - the transform,
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
// A counter rather than per-node flags, for the reason the others are: the renderer
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
