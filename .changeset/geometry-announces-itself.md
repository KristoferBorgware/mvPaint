---
"@mvpaint/engine": minor
---

**Assigning geometry now reaches the screen.** Every property `buildGeometry()` reads calls
`markGeometryDirty()` for you.

A transform, a colour and a gradient parameter have always been free and always worked, because
they live in a per-object record rewritten every frame. Geometry is packed into shared vertex
buffers instead, and the properties that feed it were plain fields — so `rect.width = 200` stored
a number and nothing else. The shape kept its old triangles until something unrelated forced a
rebuild. `width` and `height` are the sharpest case, being the most ordinary-looking properties
on the object, and the ones a property inspector or a deserializer writes through `setAttr()`.

| | |
| --- | --- |
| `Shape` | `strokeWidth`, `strokeAlign`, `lineJoin`, `lineCap`, `miterLimit`, `strokeScaleEnabled` |
| `Rect` | `width`, `height`, `cornerRadius`, `cornerSegments` |
| `Circle` | `radius`, `segments`, and `width`/`height`, which are the radius under another name |
| `Polyline` | `points`, `closed` |
| `Path` | `filled` |
| `Image` | `width`, `height` |
| `CustomShape` | `tolerance` |

Each guards on the value actually differing, so writing a node's own value back — which a slider
bound to a property does on every frame it is dragged — costs nothing.

`stroke` gained the second half of its contract. A colour swapped for another colour stays a
record rewrite; gaining or losing a colour changes whether the stroker emits a ribbon at all, so
`null` on either side of the assignment re-tessellates as well.

**`markGeometryDirty()` is unchanged and still needed twice**: after editing an array in place
(`points.push(p)` rather than assigning a new list — there is no assignment to intercept), and
after changing a property of your own `CustomShape` that its `describe()` reads. `Path.contours`
stays `readonly`; a path's outline is fixed at construction.

Calling `markGeometryDirty()` where you already do stays correct — it is idempotent within a
frame, and the epoch it bumps is compared once per frame rather than per node.
