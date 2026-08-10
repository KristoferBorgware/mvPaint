---
"@mvpaint/engine": major
---

**Breaking.** Nothing paints, and nothing drags, unless it was asked to.

`new Rect({ width: 100, height: 60 })` used to be a solid black box. It is now a rectangle that draws no pixels — still measured, still picked, still stacked, but invisible until given a colour. `{ stroke: 'red' }` draws a 2-unit outline where it previously drew nothing.

| | was | is |
| --- | --- | --- |
| `Shape.fill` | opaque black | `null` — no fill |
| `Shape.stroke` | opaque black | `null` — no outline |
| `Shape.strokeWidth` | `0` | `2` |
| `Shape.draggable` | `true` | `false` |
| `Group.draggable` | `true` | `false` |
| `Rect` `width`/`height` | `1` | `0` |
| `Circle.radius` | `1` | `0` |
| `Polyline.strokeWidth` | `1` (its own override) | `2`, inherited like everything else |

`fill` and `stroke` read back as `RGBA | null`, and take `null` as well as a colour. Two predicates ask the question directly:

```ts
shape.hasFill()    // a fill colour, or a gradient with stops in it
shape.hasStroke()  // a stroke colour AND a width to draw it at
```

A width with no colour is not a stroke, which is what stops the new default width from putting an outline on everything.

### An unfilled shape is still clickable

Picking runs against the same triangles the mesh lane draws, so a shape is hit across its whole area whether or not it paints any of it. An outlined rectangle is picked in its middle, not only on its edge.

`FillPriority` therefore gains `'none'`: the fill triangles are tessellated and uploaded exactly as before, and the fragment shader returns a transparent fragment for them. It costs one branch in each of the two mesh shaders and nothing on the CPU.

`fillPriority` READS as `'none'` whenever the chosen mechanism has nothing to paint with — no fill colour, or a gradient with no stops — while still recording the choice you wrote. So `fillPriority = 'linear-gradient'` reads back as `'none'` until stops arrive, and as `'linear-gradient'` after.

A `ShapeContext` segment material resolves the same way against ITS OWN paint: `style({ fill })` on a shape that has no fill of its own paints the segment's colour, rather than inheriting the shape's resolved `'none'`.

### Consequences worth knowing

`isOpaqueShape` now returns false for a shape with no fill: every fill fragment it paints is transparent, and the opaque pass writes depth, so it may not go there.

`MeshMaterial.fill` and `.stroke` are `RGBA | null`. A custom material handed to the mesh lane may leave either out; the batchers write transparent into the record's four floats rather than skipping them, since the slot is reused frame to frame.

### Migrating

Add the paint you were relying on: `fill: 'black'` reproduces the old default exactly. For an application that wants the old blanket behaviour rather than per-shape opt-in, one pass over the tree after building is enough — `packages/example-app/src/components/WebGPUCanvas.tsx` does exactly that for `draggable`, and shows how to keep a deliberate opt-out intact while doing it.
