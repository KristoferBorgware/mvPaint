---
"@mvpaint/engine": major
---

**Breaking.** Every attribute a node carries is declared once, on `Node`.

Six of them were on `Shape`, and two of those were declared a second time on `Group` — two
independent fields with the same name and the same meaning. `listening` was a real public field
that `attrKeys()` never listed, so a property inspector or serializer walking `node.attrs` could
not see it. Three more had no counterpart at all.

| | was | is |
| --- | --- | --- |
| `visible` | `Shape` and `Group`, separately | `Node` |
| `draggable` | `Shape` and `Group`, separately | `Node` |
| `opacity` | `Shape` | `Node`, and it cascades |
| `zIndex` | `Shape` | `Node` |
| `width` / `height` | `Shape` | `Node` |
| `listening` | `Node`, absent from `attrKeys()` | `Node`, listed |
| `preventDefault` | — | `Node` |
| `dragDistance` | — | `Node` |
| `dragBoundFunc` | — | `Node` |

`node.attrs` on any node — a bare `Container`, a `Group`, a `Layer`, a `Shape` — now reports the
21 attributes above plus the transform. `Group` and `Layer` no longer override `attrKeys()`;
neither has anything of its own left to add.

Also new: the compound accessors `position`, `scale`, `skew`, `offset`, `size` and
`absolutePosition`, each reading and writing its pair of components. They are accessors, NOT
attributes — `attrs` reports `x` and `y`, never `position`, so no value is listed twice and
`setAttr` has one way to write each field.

```ts
node.position = { x: 10, y: 20 }
node.absolutePosition                  // where x/y land in the scene, through every ancestor
node.absolutePosition = { x: 0, y: 0 } // move it there, whatever the chain does
```

### Opacity cascades

`opacity` multiplies through the ancestor chain. A shape at `1` inside a group at `0.5` paints
at `0.5`; `absoluteOpacity()` is the product, and it is what the render lanes write into the
per-object record and what `isOpaqueShape()` classifies on.

```ts
group.opacity = 0.5   // everything in it fades, and nothing is written onto the children
```

The subtree is composited per object rather than as a unit, so two children of a faded group
blend against one another wherever they overlap. Compositing once would mean drawing the subtree
to an offscreen target; this is the value-level fade.

### `Layer.enabled` is removed

A layer is switched off with `visible` now, like every other node.

```ts
layer.enabled = false   // was
layer.visible = false   // is
```

`LayerOptions` and `GroupOptions` are aliases for `NodeOptions`; `new Layer({ enabled: false })`
becomes `new Layer({ visible: false })`.

`hiddenByGroup()` is `hiddenByAncestor()`, and it asks about any ancestor rather than only the
groups: hiding a subtree is not a claim about selection, so a hidden `Layer` or bare `Container`
hides what is in it exactly as a `Group` does. `closestGroup()`, `outermostGroup()` and
`draggableGroup()` are unchanged — those ARE about selection, and still walk `Group`s alone.

### `zIndex`, `width` and `height` on a container

Carried, and not read. Only a `Shape` occupies a slot in the render order or draws from a size,
and a group's extent comes from `group.bounds()`, measured on demand from what it holds. A
container's `width` and `height` therefore stay at `0` unless something assigns them, and the
value means nothing to the renderer when it does.

A `Shape` still takes its `zIndex` from the running counter (`nextZIndex()`); a `Node` left at
`0` unless given one.

### The three drag/input attributes

```ts
node.dragDistance = 30            // pointer travel before a drag on this node starts
node.dragBoundFunc = (p) => ({ x: p.x, y: 0 })   // a slider, constrained in WORLD space
node.preventDefault = false       // let the browser act on a press over this node
```

`dragDistance` overrides the dispatcher's own threshold (default 6) for the node the press took
hold of. It governs when a DRAG begins, not what counts as a click — a press that never travels
far enough for either is still a click. `dragBoundFunc` is handed a world position and returns
one; the dispatcher maps the result back through the parent. `preventDefault` is read off the
node under the pointer; the canvas's own gestures — a transformer handle, a middle-button pan, a
pinch, the wheel, the context menu — suppress the browser default whatever it says, since no
node is their subject.

### Not implemented, and why

Three attributes a 2D scene graph might be expected to carry are deliberately absent rather than
present as fields nothing consults, each for a reason about this renderer rather than about the
attribute:

- **`globalCompositeOperation`** — a canvas 2D blend mode. Here it needs a render pipeline per
  mode and a repack of the draw list by mode.
- **`transformsEnabled`** — names an optimisation `Node.localMatrix()` already performs
  unconditionally: rotation, skew and scale are each skipped when they are the identity.
- **`filters`** — a filter runs over a cached raster, and there is no cache-to-texture layer.
  (`Image.filter`, the texture sampling mode, is unrelated.)

`shapes/nodeAttributes.test.ts` holds the whole attribute set as data and pins all three claims —
the full list present, those three absent, the compounds accessors and not attributes.

### Migrating

- `layer.enabled` → `layer.visible`
- `hiddenByGroup(node)` → `hiddenByAncestor(node)`
- A subclass with a field called `size` now shadows `Node.size`; rename it.
- If an application relied on group opacity doing nothing, set the value on the shapes instead.
