---
"@mvpaint/engine": minor
---

**`node.getClientRect()` measures any node, and `getAllIntersections()` returns the whole column
under a point.**

```ts
node.getClientRect()                            // where it sits in its parent
node.getClientRect({ relativeTo: scene.root })  // where it sits in the scene
node.getClientRect({ skipTransform: true })     // how big it is, wherever it is
```

One measurement that works on a shape, a group, a layer or a bare container — the thing to reach
for when aligning, snapping, fitting a view or exporting with margins. A shape measures its own
triangles; a container the union of its children carried up through their local matrices; an
empty container the empty box. `skipTransform`, `skipStroke`, `skipShadow` and `relativeTo` are
the flags. It replaces nothing: `Shape.localBounds()` and `Group.bounds()`/`worldBounds()` stay
as they are, and this is one call over all of them.

**The shadow is IN the box**, unlike every other measurement in the engine. A box that cropped
the shadow would be wrong for what this is usually for — an export with padding that cuts the
shadow off is exactly the bug. `skipShadow: true` takes it back out.

`getAllIntersections(scene, x, y, fonts?)` is `pickNode()` without the early return, and
`handle.pickAll(screenX, screenY)` is the same through the renderer. A click means one node,
which is what `pick` answers; cycling through stacked shapes on repeated clicks in one place, or
alt-clicking for the thing underneath, needs the column.
