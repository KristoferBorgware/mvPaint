---
"@mvpaint/engine": minor
---

**Assigning what an image shows, or how text is laid out, now reaches the screen.**

Two more places where a value was stored and nothing drew it.

**The image lane had no content epoch.** `image.crop`, `fit`, `tileX`/`tileY`, `flipX`/`flipY`,
`wrapX`/`wrapY`, `filter` and `texture` are read only when the lane packs its buffer, so
assigning one changed nothing until something unrelated forced a rebuild —
`handle.markImageGeometryDirty()` by hand was the only way through. They are guarded accessors
now, over a counter of the lane's own.

Resizing an `Image` invalidates BOTH lanes, which is the thing worth knowing about the class: its
quad is tessellated like any mesh shape — that is what gives it a hit test, bounds and a shadow
silhouette — while the pixels come from a buffer the image lane packs itself.

`tint` deliberately announces nothing: the batcher re-reads it every frame alongside the
transform and the depth, so it was already free and stays free to animate.

`handle.markImageGeometryDirty()` remains as an escape hatch for the one thing none of this can
see — a texture whose *pixels* were rewritten in place under the same object.

**A text node's layout options did not re-shape.** `align`, `maxWidth`, `lineHeight`,
`direction`, `orientation`, `padding` and `textPath` are accessors now and re-shape on
assignment. `markDirty()` stays for what an assignment cannot see: a `textPath` object edited
rather than replaced, or a run's style rewritten through the array.

**`Path.contours` half-worked and now works.** It was `readonly`, which TypeScript erases, so
`setAttr('contours', …)` overwrote it at runtime while the contour grouping the fill is
triangulated from stayed as it was — leaving a fill built from one outline and a stroke drawn
along another — and nothing re-tessellated at all. It is a real setter now, regrouping and
invalidating.
