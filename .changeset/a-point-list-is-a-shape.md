---
"@mvpaint/engine": major
---

**Breaking.** A point list is a shape, a document is an assembly, and a picture is its own size.

### `Polyline` takes the list in either form, and closes into a polygon

```ts
new Polyline({ points: [0, 0, 10, 4] })                    // flat, as well as [{x, y}, ...]
new Polyline({ points: ring, closed: true, fill: 'teal' }) // fills, and is clickable inside
new Polyline({ points: through, tension: 1 })              // a spline through the points
new Polyline({ points: controls, bezier: true })           // a start point and control triples
```

| | was | is |
| --- | --- | --- |
| `points` | `Vector2Like[]`, required | `Vector2Like[]` or flat `number[]`, optional |
| `closed` | a contour flag; never filled | a polygon: fill triangles, and an interior to hit |
| `tension` | — | Catmull-Rom through the points, flattened |
| `bezier` | — | the points read as cubic control points |
| `width` / `height` | `0` forever | the extent of the drawn outline |

`points` reads back as objects whichever form it was written in, and holds the array it was given rather than a copy — so editing one in place still needs `markGeometryDirty()`.

**A closed polyline now has an interior.** It tessellates fill triangles like every other closed shape here, so a click in the middle of one hits it where it previously fell through to whatever was behind. `fill` on a closed polyline paints for the first time; on an open one it still paints nothing, because there is nothing to fill.

`outline()` is the drawn point list — the list itself for a straight polyline, the flattened curve when `tension` or `bezier` says otherwise. Everything measured from the shape measures that.

### `Path` carries its data

`d` is an accessor. Assigning one re-flattens at the current `tolerance`, which is also an accessor; assigning `contours` drops the `d` they no longer describe.

A path built from data is WRITTEN as that data. `toObject()` emits `d` and `tolerance` for one, `contours` for one given its points directly, and never both — the same outline twice in every document, read back in whichever order the two happened to be applied, is not a format.

`width`/`height` measure the contour extent, as a Polyline's measure its points.

### Distance along an outline

```ts
line.getLength()             // the drawn outline, closing segment included when closed
line.getPointAtLength(120)   // local-space point, clamped to the ends
```

On `Polyline` and `Path`, over the flattened segments. The free functions behind them — `contourLength`, `contoursLength`, `pointAtLength` — are on `@mvpaint/engine/core`, so measuring a path needs no device.

### An `Image` follows its texture

A size that was never given is the texture's own, and STAYS the texture's own: assigning a different `texture` resizes the quad, re-tessellates the silhouette and invalidates the picking cache. Previously the size was read once in the constructor, so swapping the picture sampled the new image into the old rectangle — stretched, with stale bounds, picking and shadow to match.

Writing `width` or `height` pins that half; from then on the quad is that size whatever the texture says. A size that merely restates what the shape would measure anyway is not a pin, which is what lets a copy or a reloaded document go on following its texture as the original did. `Polyline` and `Path` size the same way.

### `loadSvgDocument` returns a `Group`

It returned a `Container`, which is not a `TransformableNode`: a loaded document could not be attached to a `Transformer`, was not what a drag inside it moved, and was not what `outermostGroup()` returned from a click on any path in it. It is now a `Group`, and each `<g>` in the document is a nested `Group` — so `closestGroup()` steps inward from the whole drawing to the part that was clicked.

**The children are no longer a flat list of `Path` nodes.** Code walking `doc.children` for paths should walk the subtree instead. Nested groups carry no transform: each element's CTM is still baked into its points.

### `Rect.cornerRadius`, unchanged and now written down

Radii too large for the rectangle shrink by one common factor (the CSS rule) rather than clamping per corner. The two agree exactly for equal radii and differ only when the four are not the same — see the header on `Rect` for the worked case.
