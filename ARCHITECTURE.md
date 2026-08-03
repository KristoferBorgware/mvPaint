# How mvPaint draws a scene

From the shape you construct to the pixels on the canvas.

This is the map. The territory is the module headers — every file named here starts with a
comment explaining what it does and, more usefully, why it does it that way. When the two
disagree, the module header is the one that was written next to the code.

```
Scene graph (nodes with transforms)
        │
        │  once, on change:  tessellate → local-space triangles
        ▼
   Batchers pack every shape into a FEW shared GPU buffers
        │
        │  every frame:      write transforms + colours into a storage buffer
        ▼
   One render pass, lanes interleaved back to front
        ▼
   MSAA resolve → canvas
```

Two ideas carry almost everything.

**Geometry is local and shared; placement is per-frame and indexed.** A shape's triangles are
computed once in its *own* coordinates and packed into one large vertex buffer alongside
everyone else's. Where it lands on screen is not baked into those triangles: each vertex
carries an integer object id, and the shader looks that object's matrix and colour up in a
storage buffer. Moving a shape rewrites one 304-byte record and touches no geometry at all.

**Depth, not draw order, decides what is on top.** Everything is drawn into one depth-tested
pass, so a text node and a rectangle interleave correctly even though different pipelines draw
them at different moments.

---

## The scene graph and transforms

`Node` (`shapes/Node.ts`) is a tree node: name, id, parent, children, event listeners — **and
its own 2D transform**: position, rotation, scale, skew, pivot offset. Placing yourself in your
parent is not a drawing concern, so it belongs to the base rather than to the drawable subclass.

`Shape extends Node` (`shapes/Shape.ts`) adds everything that affects **rendering**: size,
zIndex, visibility, pickability, fill/stroke styling, shadow settings.

`Group extends Container` (`shapes/Group.ts`) is the other kind of node worth placing. It draws
nothing and occupies no slot in any render lane; what it contributes is a matrix in the middle
of the chain, which the composition below already handles, so a shape inside a group needs no
special case anywhere downstream. It inherits the same transform a shape does — the same
gesture has to move both identically.

### The local matrix

Each placeable node composes a 4x4 matrix from its transform fields:

```
localMatrix = translate(x, y) · rotate(rotation) · skew · scale(scaleX, scaleY) · translate(-offsetX, -offsetY)
```

Read it right to left, the order the geometry experiences: the pivot offset shifts the shape's
own geometry first, then skew/scale/rotation happen *about that pivot*, then the result is
placed at (x, y).

### Where the origin sits

Which point of a shape lands at (x, y) depends on the kind of shape:

- **Elliptical** shapes (`Circle`) are **centred** on the origin. A radius is measured from the
  middle, so any other origin would introduce a second, contradictory reference point.
- **Everything else** — `Rect`, `Image`, `Text`, `VectorText` — hangs from its **top-left
  corner**. The scene is y-up, so such a shape spans `x ∈ [0, width]` and `y ∈ [-height, 0]`.
- `Polyline` and `Path` have no implied origin at all; their points are already local
  coordinates, placed wherever they were authored.

The practical consequence is the pivot. Rotation and scale are about the local origin, so a
circle spins in place while a rect turns about its corner. To spin a rect about its middle,
give it `offsetX: width / 2, offsetY: -height / 2`.

A group has no origin convention because it has no geometry of its own. It also has no size:
`group.bounds()` is computed from whatever it currently holds, walking into nested groups and
composing their matrices on the way. Nothing caches it, and nothing needs invalidating when a
child moves — the same relationship the transformer's frame has with the nodes it wraps, and
for the same reason: a stored width and height would be a second, independent claim about the
same thing.

What a group governs for its subtree is `visible` (the render/pick walk turns back at a hidden
one rather than testing each shape's ancestors), `listening` (inherited from `Node`), and
`draggable` — a press on a shape inside a draggable group takes hold of the *group*. That last
one is the only place grouping is mechanism rather than policy. Which node a click *selects* is
an application's decision; `closestGroup()` / `outermostGroup()` are there for an application
that wants to ask.

### Writing a point

There is one 2D vector: `Vector2` (`math/Vector2.ts`), and one name for its storage,
`Vector2Like` — declared as `Pick<Vector2, 'x' | 'y'>`, so it is that class's fields rather than
a second description of them.

Which to reach for follows from what the value is *for*. Use the **class** where the arithmetic
is the point — a world position being offset, a pointer being projected, anything that reads
better as `a.sub(b).normalized()` than as three lines of scalar math. Use the **type** for
coordinates being described rather than computed with: public inputs, so a caller can hand over
the object literal they already have (`points: [{ x: 0, y: 0 }]` stays legal, which a class type
would reject — a literal has no methods), and geometry in bulk, where a tessellated outline or a
glyph's rings are coordinates by the thousand and the literal is the honest way to write them.
Every `Vector2` satisfies the type, so a class value flows into either.

This used to be five things: `Point2` declared separately beside the mesh formats, in the
stroker, in the transformer's math and in the drag math, plus the class. Four copies of `{ x, y }`
cannot disagree, which is why nobody noticed; what they cost was a reader having to check that
they were the same type, and a maintainer having to pick one when writing something new.

### Writing a colour

Everything below the scene graph works in straight-alpha `RGBA` — a 4-tuple, each channel
0..1 — because that is what a shader wants, and converting per frame would be absurd.

So a string is an **input** format, never a stored one. Every colour property (`fill`, `stroke`,
`shadowColor`, gradient stops, an `Image`'s `tint`, the text run styles, a capture's background)
accepts either form and converts on assignment; reading one back always gives the tuple. The
batchers pull these per object per frame and have no business parsing anything.

Accepted: `#f00` / `#f00c` / `#ff0000` / `#ff0000cc` (the short forms double each digit, so
`#abc` is `#aabbcc`), `rgb()` and `rgba()` in comma or space syntax with numbers or percentages
and an optional `/ alpha`, `hsl()` and `hsla()` with the hue in `deg`/`grad`/`rad`/`turn` or
bare, the colour keywords, and `transparent`. Case and surrounding whitespace are ignored.

Anything unreadable **throws**. A mistyped colour that silently renders black looks like a
design decision rather than a typo, and the message costs nothing at the one place it can be
raised usefully. The exception is SVG paint (`svg/color.ts`), which returns null instead: a
colour in a document did not come from the person running the code, and one bad attribute
should not stop a drawing from loading. That module now handles only the `none` keyword and
that fallback, and reads colours through the same parser as everything else.

### Layers, which are not canvases

`Layer extends Container` (`shapes/Layer.ts`) is the other organising container, and it is
**optional**, and not a canvas. It is not a render target and **not a draw-order boundary**:
the whole scene is drawn in one pass and what is on top comes from each shape's `zIndex`,
scene-wide. Two shapes in different layers order by their own `zIndex`, never by which layer
they are in, so reorganising a scene into layers cannot change how it looks.

What it adds is the pair a group cannot give you: a name for a slice of the scene, and one
`enabled` that takes that whole slice out of the picture — out of the render order, and so out
of picking and out of a marquee too. Toggling it costs one check, not one per shape, because
the walk turns back at a disabled layer. `enabled` is the layer's property and never written
onto its children: every shape keeps its own `visible`, and switching the layer back on brings
back exactly the shapes that were visible before.

**Why it extends `Container` and not `Group`** is the whole design. A group is a *unit* — a
press on a shape inside a draggable group takes hold of the group, and an application asking
`outermostGroup()` gets the group. That is exactly wrong for a layer: putting fifty shapes on a
"background" layer must not make them one draggable object. Because a `Layer` is not a `Group`,
`closestGroup()` / `outermostGroup()` / `draggableGroup()` walk straight past it and every shape
inside stays independently pickable, draggable, selectable and transformable — as if the layer
were not there. It still carries a transform, because every `Node` does, so moving a layer moves
its contents without any of the selection semantics a group would bring.

### Taking things out again

Four operations on `Node`, and the distinction between the first two is the whole design:

| | what it does | is the node reusable? |
| --- | --- | --- |
| `remove()` | unhooks it from its parent | **yes** — transform, styling, listeners and children all intact |
| `destroy()` | `remove()`, then tears the subtree down | no. `isDestroyed` is true and stays true |
| `moveTo(parent, opts)` | re-homes it in one step | — |
| `removeChildren()` | `Container`: takes every child out | yes, all of them |

**Nothing has to be told.** The renderer rebuilds its visible set from the tree every frame and
each lane repacks when its membership changes, so a removed node stops drawing on the next
frame; the shadow atlas frees its slot the next time it bakes, because it prunes its
per-shape entries against the shapes actually present. Removal is not a message sent to the
renderer, it is a fact about the tree that the next frame discovers. (The one exception is a
scene that has turned *both* culling and the zIndex sort off, which reuses the previous
frame's visible set wholesale and needs `markGeometryDirty()` — see `render/gather.ts`.)

**So what does `destroy()` actually free?** Only the things that would *not* come back on
their own:

- **Listeners.** The census in `events/listenerCensus.ts` is global and counts up, so a node
  dropped while still holding a listener would leave its tally behind forever, making the
  input layer run hit-tests nothing needs. `destroy()` calls `off()` on every node in the
  subtree.
- **A `Shape`'s caches** — its tessellated triangles and the flattened picking layout derived
  from them. The only per-node memory that scales with complexity rather than being constant.
- **The `Transformer`'s attached set**, which is the one place a node is held by something
  that is *not* its parent. A transformer is a sibling of what it wraps, so no bubbling event
  reaches it; it checks each update instead, and lets go of anything destroyed *or* removed.

  Removed counts too, even though `remove()` otherwise promises the node is still perfectly
  usable, because a detached node's `worldMatrix()` has no parent chain left to compose and
  collapses to its **local** matrix — a shape at (10, 0) inside a group at (500, 300) reports
  (10, 0) the instant it is removed. A frame that kept hold would not merely outline something
  invisible, it would jump 500 units to outline where the node is not. "Left" is measured
  against the tree top recorded when the node was attached, so attaching a node that is not in
  a scene yet (built, selected, then added) is not mistaken for one that has just been taken
  out of one, and a `moveTo` within the same tree keeps the selection.

What `destroy()` does **not** free is anything the node did not own. An `ImageTexture` belongs
to the application and may be drawn in ten other places, so destroying an `Image` node leaves
it alone; call `ImageTexture.destroy()` when the picture itself is finished with.

A `'destroy'` event fires on every node in the subtree *before* any of it is detached, so it
still has a parent chain to bubble up and a watcher hears about the whole subtree rather than
only its head. Like `'add'` and `'remove'`, it is gated on a listener existing at all.

**`moveTo` and the world transform.** By default the node keeps its own
`x`/`y`/`rotation`/`scale` and lands wherever those mean inside the new parent — right when
the two parents are peers, jarring when they are not. `moveTo(parent, { keepWorldTransform:
true })` instead keeps the node exactly where it is on screen, rewriting its local transform to
absorb the difference between the two parents. That is the one for a drag that drops a shape
into a group: the shape should not jump because its bookkeeping changed. It works by composing
`newParentWorld⁻¹ · oldWorld` and handing the result to `Node.applyLocalMatrix()`, which
decomposes it back into the five stored fields (`math/decompose2D.ts`) — the same machinery a
transformer gesture goes through. `moveTo` throws rather than making a cycle out of a move into
the node's own descendant, and refuses to re-home a destroyed node.

### Screenshots

`handle.toCanvas()` / `toDataURL()` / `toBlob()` draw the scene **again**, offscreen, and hand
back the pixels.

A second render rather than a copy of the canvas, which is what buys the two things a copy
cannot give you: the image can be **any region of world at any resolution** (a 4000px export of
a diagram that is 300px on screen), and it does not matter what was on the canvas or whether it
had been cleared. `pixelRatio` scales the output only — the same rectangle of world, more
pixels of it.

**The engine builds the camera.** A caller describes a rectangle (`x`, `y`, `width`, `height` in
world units, plus an optional `rotation`) and never constructs or attaches one, because a
screenshot is a question about the scene rather than an instruction to move the view — and the
live camera must not so much as twitch. Every field defaults from what is on screen, so
`toCanvas()` with no arguments means "this, at this size". The background defaults to
transparent, which is what an image meant for compositing wants.

Both paths render through the *same* `draw()` the live frame uses, given a `CaptureView`
(camera, view size, clear colour) instead of the canvas's. A screenshot assembled by separate
drawing code would drift from the picture it is supposed to be a copy of.

The parts that genuinely differ are each backend's own, and the shared arithmetic lives in
`render/capture.ts`:

| | WebGL2 | WebGPU |
| --- | --- | --- |
| target | multisampled RGBA8 + `DEPTH_COMPONENT24` renderbuffers, blitted into a single-sample RGBA8 one | MSAA texture → resolve texture (`COPY_SRC`) + depth, all at the pipelines' format and sample count |
| readback | `readPixels` from the resolve buffer | `copyTextureToBuffer` → `mapAsync`, rows padded to 256 bytes and unpadded again |
| orientation | rows come back **bottom first** and are flipped | NDC +Y is already the first texel row — no flip |
| channels | RGBA as read | `bgra8unorm` is the usual preferred canvas format, so red and blue are swapped back |

**Both captures are 4× MSAA**, including on WebGL2 — where the *live* frame has none. Those two
facts fit together rather than contradicting: the fallback skips MSAA because it costs on every
frame on precisely the devices that ended up on the fallback, and a screenshot is taken once, so
the per-frame argument does not apply to it. An exported PNG with stair-stepped edges is a poor
thing to hand someone. WebGL2 needs two framebuffers for it, since a multisampled buffer cannot
be read directly: `blitFramebuffer` from the multisampled one into a single-sample one *is* the
resolve, and must be `NEAREST` (a multisample resolve rejects `LINEAR`). The sample count is
clamped to the driver's `MAX_SAMPLES` rather than assumed — `renderbufferStorageMultisample`
fails outright rather than rounding down.

**What it costs.** One gather, one repack, one draw — and because the capture culls against a
different rectangle than the live view, the frame *after* it re-gathers. That is a screenshot's
fair price and not something to do every frame. Oversized requests are clamped proportionally
rather than left to fail inside the backend with a message about attachments.

### The camera is not in the graph

`Camera2D` (`camera/Camera2D.ts`) is a plain object, not a node. A camera is not a thing *in*
the scene, it is the frame the scene is viewed through, and the **application owns it** —
`createSceneRenderer({ camera })`, or `setCamera` later. Nothing in the graph refers to it and
it refers to nothing in the graph, so one scene can be drawn through two cameras at once. The
`'view'` and `'editor'` input sets move this object like any other caller would, through
`panToAnchor`/`zoomToward`; a static render leaves it entirely to the application.

It is a rectangle of world placed like any other rectangle here: `x, y` is the world point at
the viewport's **top-left**, `zoom` is viewport pixels per world unit, and `rotation` turns the
view about its own centre. Supplying no camera is a framing rather than a failure — the scene
then renders through a default one, which puts world (0, 0) at the top-left at 1:1.

It still composes a real 4x4 view-projection, and `screenToWorld` still unprojects through the
inverse, rather than reducing to two multiplies and an add. The render path takes a
view-projection and nothing else, so keeping that seam is what would let a perspective camera
slot in without any lane, shader or culling code changing.

### Two caches, both keyed on identity

```ts
worldMatrix() {
  const local = this.localMatrix()
  const parentWorld = this.parent ? this.parent.worldMatrix() : null
  if (this.cachedWorld && local === this.cachedWorldLocal && parentWorld === this.cachedWorldParent)
    return this.cachedWorld            // reference equality, not value equality
  ...
}
```

`Matrix4x4` instances are immutable — every factory and every `mul()` returns a fresh one — so
"same object" really does prove "same value". `localMatrix()` caches on the nine transform
fields; changing any one produces a new instance, which propagates up the ancestor chain as a
cache miss.

This is load-bearing further down: the mesh batcher decides whether to re-upload an object by
comparing its model matrix **by reference**. On a static scene every node hands back last
frame's instance, so the whole per-frame CPU cost collapses into pointer comparisons.

### What an input event costs

There is no spatial index. `pickNode()` collects the visible shapes, sorts them by `zIndex`
and walks front to back testing each one — exact, against the same triangles the mesh lane
renders, and **O(n)**. Measured on the 100k stress scene: **~82 ms per pick**, of which the
walk is ~130 ms against ~19 ms for building the sorted list at raw scale, so caching that list
would recover little. Bringing the walk itself down means indexing space, which the engine
does not do.

So the design principle is that the cheapest hit-test is the one not performed, and there are
two questions asked before any of them:

1. **Does anyone listen at all?** `events/listenerCensus.ts` keeps a global tally per event
   type, so a scene with no hover handler pays nothing for hover.
2. **Does anyone listen *below the root*?** Every event bubbles to the root, so a listener
   there is called whatever was under the pointer. The hit can then only change what
   `event.target` says — nothing about who runs.

The second one matters because of how camera zoom is normally driven: `root.on('wheel')`,
reading the delta, never asking what it was over. Naming that node used to cost a full pick on
every wheel event. `SceneInputDispatcher.dispatchReported` now compares the census tally
against `Node.ownListenerCount`, and when nothing below the root is listening it fires from
the root with `target` left as a **thunk** (`NodeEventInit.targetResolver`) — resolved on
first read, cached, and never computed if nobody asks.

Semantics are unchanged either way: a handler that reads `event.target` gets exactly what it
always got, and a listener further down the tree still gets an eager pick, because there the
dispatch path genuinely depends on the answer. The tally reads high rather than low, so a
wrong answer is always "pick anyway".

On the 100k scene that took a wheel event from **82 ms to 0.1 ms**.

### Setting input up, and the three settings of it

The dispatcher decides nothing — it reports what a pointer did, and something above it decides
what that means. That split has not moved, but the *ordinary* answers now ship with the engine,
because "a wheel notch zooms about the cursor" and "a press selects what it landed on" are not
choices most applications want to make; they are the ones every canvas application makes
identically.

`createSceneRenderer(target, { input })` takes a preset (`input/inputOptions.ts` resolves it,
`input/sceneInput.ts` wires it) and the composition roots attach it last, once the handle they
build on exists:

| `input` | Dispatcher | `pick` it is given | Furniture in the scene |
| --- | --- | --- | --- |
| *omitted* | none | — | none |
| `'view'` | yes | `() => null` | none |
| `'editor'` | yes | `handle.pick` | `Transformer`, `MarqueeOverlay` |

The middle column is the whole of why `'view'` is cheap: a view is not a scene with its policy
removed, it is one that never asks the question — see the measurements above for what asking
costs at scale. Everything else follows from it. No pick means no hover target, no drag arming,
no handles, and every press resolving to the root.

The bindings are built entirely from the public parts (`SceneInputDispatcher`, `MarqueeTool`,
`Transformer`, `panToAnchor`/`zoomToward`, `nodesInBox`), so an application whose needs diverge
turns the preset off and writes the same thing with the same materials. What it must not do is
take `handle.onFrame` and expect the frame to keep fitting: the selection frame refits once a
frame, and it subscribes through `handle.addFrameListener` (`renderer/frameListeners.ts`) rather
than through that single application-owned slot, which runs first.

`resolveCanvas` (`renderer/canvasTarget.ts`) does the same job for the other argument — canvas,
selector, container element or nothing — and runs in `createSceneRenderer` *before* either path
is tried, so a WebGL2 fallback after a failed WebGPU attempt draws into the canvas that already
exists rather than creating a second one.

### What destroy() gives back

An application that tears a renderer down and builds another does it in whole renderers —
switching render path, remounting a component, opening a second document — so anything the
setup keeps must come back, or it accumulates a renderer at a time. `handle.destroy()` releases:

| Taken | Given back by |
| --- | --- |
| Canvas + window listeners, the touch-hold timer, the frame subscription | `input.destroy()` |
| The selection frame and marquee rectangle | `destroy()`, not `remove()` — see below |
| A canvas the **engine** created | removed from the document; a caller's canvas is untouched |
| GPU buffers, atlases, the device | the path's own `destroy()` |

The furniture is *destroyed* rather than removed for two reasons that outlive a removal: the
frame goes on holding whatever was selected — a reference to application content, and through
its parents to the scene — and any listener an application put on it stays counted in the
global census (`events/listenerCensus.ts`), which reads high and never comes back down, so the
whole scene would keep paying to dispatch an event type nothing is listening for.

The one thing dropping nodes does **not** release is a GPU texture: `ImageTexture` is handed to
the scene that asked for it, because one texture is often shared by several `Image` nodes and
only the scene knows when it is finished with. The example app's scenes therefore carry a
`dispose()`, called once their nodes have left the graph.

Measured over 28 build/destroy cycles of a 200-shape scene with `input: 'editor'`: zero
outstanding DOM listeners, zero stranded canvases, every census tally back to zero, and a flat
JS heap.

---

## Geometry construction

### The sink

Shapes never touch GPU buffers. They emit triangles into an interface (`render/meshFormat.ts`):

```ts
interface MeshSink {
  vertex(x: number, y: number, isFill: boolean, material?: number): number
  triangle(a: number, b: number, c: number): void
}
```

Positions are in the shape's **local space**. `vertex()` returns a shape-local index and
`triangle()` refers to those; the batcher rebases them into the shared buffers.

Note what is missing: **there is no colour**. A solid fill, a gradient and a stroke colour are
all read from the object storage buffer at fragment time. That is why recolouring a shape needs
no geometry rebuild, while resizing one does.

`isFill` separates fill triangles (eligible for a gradient) from stroke triangles (always
flat). `material` selects which of the shape's materials paints the vertex — usually 0; a
`VectorText` whose runs carry different colours emits several.

### Who emits what

| Shape | `buildGeometry()` emits |
| --- | --- |
| `Rect` | two triangles, plus a four-corner stroke contour |
| `Circle` | a triangle fan; segment count adapts to radius (chord error ≤ 0.02 world units) |
| `Polyline`, `Path` | contours through earcut for the fill, plus the shared stroker |
| `Image` | its quad — for the silhouette, bounds and hit test only; the pixels come from the image lane |
| `Text` | **nothing**; it inherits the no-op, because it draws through the text lane |
| `VectorText` | real glyph outlines, tessellated like any other path |
| `CustomShape` | whatever the subclass's `describe()` drew — see below |

### Shapes the engine does not know about

`CustomShape` is `buildGeometry()` turned outward. Subclass it, implement `describe(ctx)`, and
draw the outline into the context you are handed:

```ts
class Star extends CustomShape {
  protected describe(ctx: ShapeContext): void {
    ctx.moveTo(0, 90)
    ctx.lineTo(26, 28)
    // ...
    ctx.closePath()
    ctx.fillAndStroke()
  }
}
```

`ShapeContext` is a path builder with the vocabulary everyone already has — `beginPath`,
`moveTo`, `lineTo`, `quadraticCurveTo`, `bezierCurveTo`, `arc`, `ellipse`, `rect`, `circle`,
`closePath`, plus `pathData(d)` for SVG path data — and it produces **mesh geometry, not
pixels**. Closed subpaths go through the same earcut path a `Path` node's contours do (so a
subpath inside another is a hole); open ones go through the shared stroker. Coordinates are the
shape's own local space, y-up.

Everything downstream then treats it as what it is — triangles. Picking tests the real outline,
bounds come from it, a shadow is baked from that silhouette, and gradients, object opacity and
the scene-wide stacking order all work because none of them ever asked what drew the geometry.

**Segments carry their own properties.** `ctx.style({ stroke, strokeWidth, lineJoin, ... })`
applies to everything added after it, and each segment remembers the style it was added in, so
one continuous outline can change colour and thickness partway along without becoming several
nodes. Each distinct *paint* becomes one material record on the shape — the same `materials()`
mechanism a styled `VectorText` run uses — while a change to stroke *geometry* adds no record,
because that difference is already in the triangles. A run of segments sharing a style is
stroked as one polyline with proper joins throughout; where the style changes, the runs meet end
to end with a cap each.

`describe()` runs **once**, lazily, and then not again until `markGeometryDirty()`. So it is the
right place for real work and the wrong place for anything per-frame: moving, turning or
recolouring the node never re-runs it, and a shape whose outline depends on a property of its
own has to say so when that property changes — exactly like `Circle.radius`.

### The tessellation cache

`tessellate()` runs `buildGeometry()` once, keeps the vertex/triangle arrays, and replays them
into whatever sink asks. It is invalidated only by `markGeometryDirty()`.

A second, flattened structure (`xs`/`ys`/`tris`/`bounds`) is derived lazily from the same
output for hit testing and bounds. It is not a second tessellation, just a layout better suited
to point-in-triangle tests — which is why a mousemove over a hovered shape redoes no work.

---

## One frame, end to end

`webgpu/FrameRenderer.ts` owns the loop and the boilerplate:

```
requestAnimationFrame tick
  ├─ resize check; (re)create the depth and MSAA textures if the canvas changed size
  ├─ createCommandEncoder()
  ├─ onPrePass(encoder)          ← shadow silhouette baking, in its own passes
  ├─ beginRenderPass({ colour: MSAA texture, resolveTarget: swapchain, depth: depth24plus })
  │    └─ onFrame({ pass, dt, width, height })    ← SceneRenderer records every draw here
  │         ├─ pass 1: the opaque half, batched per lane, writing depth
  │         ├─ pass 2: everything translucent, back to front, depth read-only
  │         └─ pass 3: the overlay tail, depth off entirely
  ├─ pass.end()
  └─ queue.submit([encoder.finish()])
```

- **MSAA 4x.** Rendering goes into a four-sample texture that resolves into the swapchain when
  the pass ends. Anti-aliased edges everywhere, for free.
- **Depth.** `depth24plus`, cleared to 1.0 every frame, compared `less-equal` — not `less`, so
  that shapes sharing a depth still resolve by draw order.
- **Prepass.** Shadow baking needs its own render passes against different targets, which a
  single `beginRenderPass` cannot express — hence a hook before the main pass, on the same
  encoder.

Startup lives in `createSceneRenderer()`: acquire the device, subscribe to `uncapturederror`
(an invalid pipeline does not throw, it just quietly poisons the command buffer and leaves the
canvas blank), load the MSDF font atlases, then build the renderer inside a validation error
scope.

---

## The gather

The first thing a frame does, before any drawing — and the one part of a frame that knows
nothing about the GPU. It lives in `render/gather.ts`, names no graphics type at all, and is
shared by both render paths (see [Two render paths](#two-render-paths)): which shapes are
visible, what depth each takes and in what order they interleave are not rendering decisions,
and the answer is the same whichever API ends up submitting it.

**Z-order.** `collectZOrder()` walks the tree and stable-sorts every shape by `zIndex`. Stable,
so ties keep scene-graph order.

**Where `zIndex` comes from.** Every `Shape` takes the next number from a running counter
(`shapes/zOrder.ts`) at construction, so shapes stack in the order they were made: the first is
at 0, the next at 1 and therefore in front of it, and drawing something new puts it on top with
nothing to set. Higher is in **front** — `collectZOrder()` sorts ascending and `depthForRank()`
turns a higher rank into a nearer depth.

Creation order, not tree order: a shape exists before it is added to anything and may be moved
between parents afterwards, and neither should silently restack it. The counter is module-global
because a `Shape` is constructed without knowing which scene it will join; two scenes sharing it
costs nothing, since a `zIndex` is only ever compared against another in the same scene. It never
goes backwards, so the numbers climb for as long as the page lives — which is free, because depth
comes from a shape's **rank** in the sorted list and never from the `zIndex` value itself.

An explicit `zIndex` overrides all of that and is absolute on the same scale, so a small literal
is not "near the bottom of these few shapes", it is near the bottom of the whole scene. To place
one shape relative to another, say so: `front.zIndex = back.zIndex + 1`. The two idioms the
counter is built around are `shape.zIndex = nextZIndex()` (bring to front) and any negative value
(send behind everything, since the counter only counts up from zero).

**Depth assignment.** Each shape's rank becomes a depth:

```ts
depthForRank(rank, count) = (count - rank) / (count + 1)
```

Rank 0 (lowest zIndex) sits near 1.0, the far plane; the last sits near 0. Depths are assigned
**scene-wide, before culling**, so ranks never shift as content scrolls off screen.

**Bucketing into lanes**, in one pass rather than three filters:

```ts
if (shape instanceof Text)       texts.push(shape)
else if (shape instanceof Image) images.push(shape)
else { meshShapes.push(shape); meshDepths.push(depth) }
```

`VectorText` deliberately lands in the mesh bucket: it is text drawn *as* geometry, so it wants
the mesh lane and gets picking, bounds and shadows without a single special case.

**Cull.** Drop anything whose world bounds miss the camera's view rectangle (plus a debug
margin). Depths are filtered in step with their shapes by an explicit loop —
`.filter()` cannot keep a second array in sync.

**Overlay split.** Overlay shapes (transformer handles, marquee box) are packed **last**, so
they occupy a contiguous tail of the index buffer. That is what lets one buffer be drawn as
several ranges under different pipelines.

**Opacity split.** Ahead of that tail the mesh lane splits again: shapes that provably paint no
partial alpha are moved to the **front** of the list, so they too occupy a contiguous range and
can be drawn as a single call (see [The two passes](#the-two-passes)). The partition is stable,
so the translucent half keeps the back-to-front order it needs — and a lane that is entirely one
or the other is handed straight back, unreordered and uncopied.

The mesh lane's packed order is therefore `[ opaque | translucent | overlay ]`, and every draw
in the frame is a half-open range of it.

**The fast path.** When culling and z-sorting are both off and nothing is dirty, the entire
gather is skipped and last frame's arrays are reused. That is how a 100k-shape scene avoids
re-traversing itself sixty times a second. The opacity split is part of what gets reused, and it
is the one thing here derived from something a caller can change silently — a fill or stroke
alpha. In that state (culling *and* the z-sort both off), an alpha that crosses 1 needs a
`markGeometryDirty()` to be noticed; every other state re-gathers, and re-splits, anyway.

---

## The buffers

### Frequency model (bind groups)

Layouts are created explicitly and shared across pipelines rather than using `layout: 'auto'`,
precisely so groups 0 and 1 can be bound once and reused across lanes.

| Group | Contents | Written |
| --- | --- | --- |
| **0** | `viewProjection` mat4 + `resolution` vec2 (80 bytes, uniform) | once per frame |
| **1** | array of object records (read-only storage) | per frame, changed slots only |
| **2** | texture + sampler (font atlas array, image, shadow atlas) | per draw range |

### Vertex buffers

| Lane | Stride | Attributes |
| --- | --- | --- |
| Mesh | 12 B | `position` f32x2, `packedId` u32 |
| Text | 36 B | `position` f32x2, `uv` f32x2, `color` f32x4, `packedId` u32 |
| Image | 20 B | `position` f32x2, `uv` f32x2, `packedId` u32 |
| Shadow | 12 B | `position` f32x2, `packedId` u32 |

`packedId` carries an object index in its low 31 bits and a flag in the top bit — `isFill` in
the mesh lane, `isGlyph` in the text lane.

### The mesh object record — 304 bytes

```
  0   model               mat4x4<f32>    the world matrix
 64   fillType            u32            0 = solid, 1 = linear, 2 = radial
 68   stopCount           u32
 72   gradientStart       vec2<f32>
 80   gradientStartRadius f32
 84   depth               f32            from depthForRank, not from any z coordinate
 88   gradientEnd         vec2<f32>
 96   gradientEndRadius   f32
100   stopPositions       f32[8]
144   stopColors          vec4<f32>[8]
272   fillColor           vec4<f32>
288   strokeColor         vec4<f32>
```

`depth` sits in what would otherwise be alignment padding, so it costs nothing.

The text record is 320 bytes — the same transform and gradient fields, extended with a
per-letter outline colour and width, the atlas distance range, and which layer of the shared
font atlas array the run samples. The image record is 96 (model, tint, depth) and the shadow
record 128.

An "object" is a **(shape, material) pair**, not a shape. A shape claims a contiguous block of
records, one per material, and its vertices pick within that block.

---

## The shaders

The vertex shader, in the mesh lane and in the same shape everywhere else:

```wgsl
let objectId = input.packedId & OBJECT_ID_MASK;
let model = objects[objectId].model;
out.clip = frame.viewProjection * model * vec4(input.position, 0.0, 1.0);
out.clip.z = objects[objectId].depth * out.clip.w;   // override the projected z
out.localPos = input.position;                        // for gradient evaluation
```

That fourth line is the crux of the whole design. Every 2D shape sits at z = 0, so the
projected z carries no information. The renderer injects the stacking depth instead, multiplied
by `w` so it survives the GPU's perspective divide intact.

The fragment shader reads `fillType` and either returns `strokeColor`/`fillColor` flat, or
evaluates a linear or radial gradient analytically from `localPos` — in the shape's own space,
so the gradient rotates and scales with the shape for nothing.

---

## The four lanes

All four share group 0, the depth buffer, the sample count and the render pass. They differ
only in vertex format and fragment maths.

| Lane | Fragment work | Can be opaque? |
| --- | --- | --- |
| **Mesh** | flat colour, or an analytic gradient | **yes**, when every material's fill and stroke are at alpha 1 |
| **Text** | MSDF: `median(r,g,b)`, an `fwidth`-based screen-pixel range, an optional second threshold for per-letter outline | never — see below |
| **Image** | `textureSample(...) * tint` | never — see below |
| **Shadow** | sample the pre-blurred silhouette, tint it | never; a shadow is translucent by definition |

### What group(2) costs, and the font atlas array

Everything above is about *pipeline* switches. The other thing that ends a draw call is a
**group(2) rebind** — a different texture — and WebGPU has no bindless: no `binding_array`, no
descriptor indexing, one texture per bind group. A draw call per distinct texture is a floor
that no amount of shader merging gets under.

Which makes it worth not having distinct textures. All four Inter styles live in **one
`texture_2d_array`**, a layer each, behind one bind group; a run's layer travels in its object
record (`webgpu/FontBook.ts`). The text lane used to segment its draws per atlas, so a paragraph
alternating regular and bold paid a bind and a draw per switch — four pages of mixed-style
lorem ipsum cost **108 draws against 4 distinct atlases**. It is now 1.

Array layers must be identically sized and the generator packs each style to its own tight
bounds (280×285 through 306×324), so each image is copied into the top-left of a layer sized
for the largest and uvs are measured against the **layer**, not the image
(`text/msdfMetrics.ts`). The padding costs about 11% of a texture under two megabytes. The
shader needs no adjustment for it: `textureDimensions` is the layer size and `distanceRange` is
divided by exactly that, so packing a smaller image into a bigger layer scales `fwidth(uv)`
down and `unitRange` up by the same factor and the screen-pixel range comes out unchanged.

The image lane has the same opportunity and has not taken it: its textures are the
application's, of any size and format, so pooling them means a real atlas allocator rather than
four fixed layers. That is why `images` is still the scene with the most draw calls.

---

## The two passes

Alpha blending is order-dependent and the depth test is not, and **no single draw order serves
both**. So the frame is drawn twice over, splitting the scene by whether an object can be
*proven* to paint only opaque fragments (`render/opacity.ts`).

These are phases of the one WebGPU render pass, not separate `beginRenderPass` calls — the
colour and depth attachments are never rebound, only the pipelines and the draw ranges change.

| | order | batching | depth test | depth write |
| --- | --- | --- | --- | --- |
| **1. Opaque** | irrelevant | one draw per lane | yes | **yes** |
| **2. Translucent** | strictly back to front, all lanes merged | one draw per *lane change* | yes | no |
| **3. Overlay** | packed tail of the mesh buffer | one draw | no (`always`) | no |

**Pass 1** needs no ordering at all, because for fully opaque fragments the depth buffer *is*
the sort: two overlapping solid shapes resolve to the nearer one whichever draws first. So an
opaque lane collapses to one draw however finely its shapes are stacked among the translucent
ones. It writes depth, which is what pass 2 then reads.

**Pass 2** is the opposite: back-to-front is the only order alpha blending composites correctly
in, so the lanes are merged into one furthest-first sequence and drawn in runs, one draw per
lane change (`render/drawOrder.ts`). It still *tests* depth — an opaque shape in front hides all
of it — but never *writes* it, because translucent fragments have no business rejecting each
other.

**Pass 3** is the editor furniture, on top of everything, touching depth not at all.

### Why the split has to be conservative

"Opaque" is a promise that **every** fragment an object can produce comes out at alpha 1,
because that is what earns it the right to write depth ahead of everything behind it. A wrong
"translucent" costs one draw call; a wrong "opaque" punches a hole in the picture. So anything
the CPU cannot prove from the object's own fields is translucent, and two whole lanes fail by
construction:

- **Text.** An MSDF glyph's alpha *is* its coverage — the shader turns the sampled distance
  into a soft edge — so every glyph outline is a ring of partial-alpha fragments however solid
  the run's colour is. (Mesh shapes get their edges from MSAA instead, which resolves per
  *sample*: a covered sample is fully covered, so a solid fill really is opaque everywhere it
  draws.)
- **Images.** What is in a texture is the application's business and is never read back, so
  nothing on the CPU can rule out an alpha channel. A tint alpha below 1 proves an image
  translucent; a tint alpha of 1 proves nothing. The cheap fix, should an image-heavy scene
  ever want the opaque pass, is for the caller to declare it when building the `ImageTexture` —
  it is the one party that knows.

A mesh shape is opaque when every material it declares has an opaque stroke colour and either a
flat fill at alpha 1 or a gradient whose every stop is. The stroke is checked whether or not the
shape strokes anything, since a material carries no stroke *width*; that costs nothing in
practice, because an unstroked shape keeps the default opaque black.

And before any of that, `Shape.opacity` below 1 disqualifies a shape outright, in every lane —
see below.

### Object opacity

`Shape.opacity` (0…1, default 1) fades a whole object, and is deliberately **not** the alpha in
its `fill`/`stroke`. A colour's alpha is part of how the shape is painted and belongs to its
design; this is a property of the object — what an editor's opacity slider drives and what an
animation fades. Baking one into the other means a fade has to know, and afterwards restore,
every colour it touched. The two multiply.

It rides in the per-object record, in padding each format already had: byte 132 for mesh and
text, byte 84 for images. **No record grew and no stride changed**, so the WebGL data-texture
texel counts (19 / 20 / 6) are exactly what they were. Each lane's shader multiplies it into the
fragment's **alpha only** — these lanes blend straight, non-premultiplied alpha, so scaling rgb
would darken the shape instead of fading it. The shadow lane needs no record change at all: its
colour alpha is already `shadowColor.a × shadowOpacity` on the CPU, so object opacity is one
more factor there, and a faded shape's shadow fades with it rather than reading as a second
object.

The load-bearing part is the classifier. `isOpaqueShape()` checks `opacity < 1` **first**, ahead
of any material, because an opacity it could not see is precisely the "wrong opaque" the section
above warns about — a faded shape would write depth ahead of everything behind it and punch a
hole. Opacity can only ever move a shape *out* of the opaque pass, never into it.

**It does not cascade.** A group's opacity is a different and much harder feature: doing it
correctly means drawing the group to an offscreen target and compositing that once, because
multiplying the value down onto each child instead makes the children show through *each other*
wherever they overlap. Rather than ship the cheap version under the right name, this stays what
it says it is — one object's transparency. The same caveat applies in miniature to a shape whose
parts are styled independently (`VectorText`'s runs are separate object records), which is why
it is a note rather than a blocker: runs rarely overlap.

### What it was before

The lanes used to draw one at a time — all the mesh, then all the text, then all the images —
and the depth buffer was supposed to arbitrate. It cannot, for anything translucent: a fragment
at alpha 0.4 still writes depth, so whatever sat behind it **in a later lane** was rejected
outright instead of showing through. Transparency worked in one direction and not the other,
decided by which lane a thing happened to be in.

Interleaving everything back-to-front fixed that but charged every scene for it: each lane
change is a draw call, so a scene that alternated kinds paid one draw per object even where
nothing was translucent at all. Splitting the passes pays that cost only where it buys
something — and pooling the font atlases (above) removes the binds the split cannot.

Draw calls in one full frame, measured on the real app at each stage:

| scene | one interleaved pass | + opaque/translucent split | + pooled font atlas |
| --- | --: | --: | --: |
| Shapes & gradients | 2 | 2 | **2** |
| Shape stress test (100k) | 4 | 4 | **3** |
| Stacking order | 4 | 5 | **5** |
| Shadows | 27 | 5 | **5** |
| MSDF text | 14 | 14 | **3** |
| MSDF text stress test | 112 | 108 | **3** |
| Transparency across lanes | 45 | 41 | **32** |
| Images | 36 | 37 | **37** |

Stacking order is the honest cost of the split: pulling an opaque shape out of the middle of a
back-to-front run splits that run in two, so a scene whose mesh lane is nearly all translucent
can pay one extra draw per lane. It is bounded at that. Images is the lane that has not been
pooled yet, and it shows.

Total indices submitted are unchanged in every scene at every stage — the draws are merged, not
dropped.

Classifying costs a scan of the visible mesh shapes per gather — around 10 ms at 100k shapes,
against roughly 88 ms for the viewport-cull scan sitting beside it, and nothing at all on the
fast path where the whole gather is reused.

### Shadows

Shadows join pass 2 like anything else. A shadow is a translucent blob with exactly the problem
the content lanes have: it must composite over what is behind it and under what is in front. It
sits **half a depth step behind its caster**, which places it immediately before that caster in
the sequence — late enough to land on whatever is below, early enough for its own caster to
paint over it.

Drawing shadows last, as they used to be, worked only while everything above them was opaque. A
translucent panel over a shadow had already written depth by the time the shadow lane ran, so
the shadow was rejected outright instead of showing through.

---

## What happens when a property changes

The most subtle part of the system, and the one most worth understanding before changing
anything.

### A transform changes — `x`, `y`, `rotation`, `scale`, `skew`, `offset`, `zIndex`

Nothing is rebuilt. `localMatrix()` misses its cache, produces a new matrix instance, and next
frame `updateObjects()` sees a different `model` reference and rewrites that object's record.

These are **accessors, not plain fields**, and that is what makes the previous paragraph
affordable. Refreshing records used to be O(everything visible) whether or not anything had
happened: two function calls and a couple of dozen property reads per object, to conclude every
time that nothing had. At 100k objects that is ~40 ms of a frame spent asking. Each setter now
bumps the object-record epoch — guarded on the value actually differing, so writing a node's own
value back (which a `Transformer` does to its handles on every frame it is up) announces
nothing — and `updateObjects` returns immediately when the epoch has not moved and the visible
set is the same objects in the same order. Depths need no separate check: they are a function of
rank and count.

Measured at 100k static objects: **40 ms → 0.6 ms**, the remainder being the membership compare.
The trade is a ~10% slower `worldMatrix()` (nine getter reads instead of nine field reads in the
cache check, on a path that now runs far less often) and ~19 ns per changed field on assignment.

**A value assigned is seen; a value edited in place is not.** Assigning
`shape.fillLinearGradientStartPoint = { x, y }` announces itself; reaching through it to write
`.x` does not, and neither does editing a colour tuple through a cast. That is the convention
`Matrix4x4` and the colour tuples already relied on, now with a consequence attached.

**With one exception**, and it is the only one in the engine: a shape with
`strokeScaleEnabled = false` has its stroke width baked into geometry in a way that depends on
the world scale, so a scale change *does* rebuild it. See below.

The upload is by **dirty range**. Each slot keeps an `ObjectCache` of what was last written;
unchanged slots are skipped outright. Changed slots are collected into ranges, merging any two
within 8 slots of each other — a few hundred wasted bytes beat an extra `writeBuffer` call. If
a frame's changes scatter into more than 512 ranges, it falls back to one whole-buffer upload
rather than issuing an unbounded number of small writes. At 100k objects that is the difference
between a ~30 MB copy every frame and a few hundred bytes while dragging one shape.

### Which side the stroke goes on — `strokeAlign`

A stroke is a ribbon offset from the outline it follows, and `strokeAlign` decides how far it
reaches to each side: `half, half` for `'center'`, `width, 0` for one of the other two and
`0, width` for the last. Those two numbers are the *whole* implementation — every join, miter,
bevel and cap in `render/stroke.ts` reads them rather than a single half-width, so there is one
stroker rather than three, and a centred stroke is byte-for-byte the geometry it always was.

Which side is which comes from the ring's own winding: `perp()` gives the right normal, so a
counter-clockwise ring (positive shoelace area) encloses the −normal side. An **open** path has
no enclosed side, so it stays centred whatever is asked for.

A hole is the interesting case. "Inside" is a statement about the shape, and a hole's ring is
wound against the outline containing it — the material lies *outside* the hole's own ring — so
`strokeContours()` asks the same even-odd nesting question the fill asks (`render/contours.ts`,
shared by the SVG fill, glyph fill and this) and strokes hole rings with the alignment flipped.
A donut with an inside stroke therefore keeps both of its silhouettes exactly.

Because the ribbon is geometry, this changes what the node measures: `localBounds()` is the
extent of the triangles a shape emits, so an inside stroke leaves a node exactly the size of its
fill and an outside one grows it by the full width. That is a feature, not a side effect — it is
what everything downstream of bounds (the selection frame, marquee hits, the shadow silhouette,
culling) needs in order to agree with the picture.

### A stroke that does not scale — `strokeScaleEnabled = false`

The exception above, and the reason it is opt-in per shape.

A stroke width is normally a local-space measurement like any other coordinate: the ribbon is
tessellated once and the transform stretches it along with the rest of the shape. An outline
that must stay the same width whatever the shape's size cannot work that way — the triangles
genuinely differ per scale — so the shape re-tessellates whenever its world scale changes, and
that costs its lane a repack.

How the ribbon is built is the interesting half. It is **not** the width divided by a scale
factor: under a 4:1 stretch a diagonal edge is thickened by neither 4 nor 1 but by something
between, and by a different amount for every direction around the shape, so no single number
fixes it. Instead the stroker is handed a `StrokeGauge` — the linear part of the world matrix —
and pushes the path *through* it, strokes there where the width is the width that was asked
for, and maps every vertex back through the inverse. Non-uniform scale and skew come out exact,
round joins correctly returning as the ellipse arcs they have to be. There is still one
stroker: this is a wrapper around it, so the gauged case cannot disagree with the ungauged one.

Noticing is a sweep. `render/gather.ts` asks every shape once a frame whether the scale its
stroke was built against still holds (`Shape.refreshStrokeGauge`) — one boolean read for a
shape that never opted out, which is what makes it affordable over the whole scene. It has to
be a sweep rather than a setter: a shape's world scale depends on every ancestor, and no setter
is in a position to say that a whole subtree's strokes are now stale.

Rotation and translation are free, and provably so. Stroking commutes with rotation, so a gauge
and that gauge turned by any angle give identical triangles; the staleness check compares
`GᵀG` — the two axis lengths and the angle between them — which is invariant under exactly the
rotations that do not matter and sensitive to every scale and skew that does.

### A colour changes

Same path. Solid colours and gradient parameters live in the object record, never in geometry.

One caveat, and only on the fast path: an **alpha** that crosses 1 moves the shape between the
opaque and translucent halves of the mesh list, and that split is computed in the gather. Every
ordinary scene re-gathers each frame and picks it up for free. A scene that has switched both
culling and the z-sort off is reusing last frame's gather wholesale, and needs a
`markGeometryDirty()` for the change to be seen.

### Geometry changes — `Circle.radius`, `Polyline.points`, `strokeWidth`, `Path.filled`

Call `markGeometryDirty()`. It drops the shape's tessellation and pick caches, bumps its
`geometryVersion` (the shadow atlas keys its baked silhouette on that), and bumps a lane-wide
content epoch.

### Text content changes — `setRuns`, `setText`, or `markDirty()` after editing a layout option

`TextBlock.invalidateShaping()` bumps the text epoch and calls the subclass's
`dropShapingCache()`.

### The content epochs, and why they exist

A lane packs many nodes into shared buffers and never revisits them. Dropping a node's own
cache tells the *node*; nothing told the *renderer*, so the buffers kept the geometry they were
packed with and the change never appeared until something unrelated forced a rebuild. Animating
a node's **content** rather than its **transform** hit this every frame — text following a
curve advanced its offset and sat still, with the text lane rebuilding 0 times in 62 frames.

`shapes/contentEpoch.ts` holds one counter per lane. `markGeometryDirty()` and a text re-shape
bump it; the renderer compares one integer per frame. A counter rather than a flag per node is
what keeps it free when the visible set is in the tens of thousands.

A **third** counter answers a different question: has any per-object *record* changed — a
transform, a depth, an opacity, a colour? Those are refreshed every frame without touching
geometry, and the batchers skip a slot whose values are unchanged; but they could only find
that out by looking, and looking at 100k objects costs **~40 ms** to conclude there was
nothing to do. So the record-relevant properties announce themselves instead (see below), and
a frame where nothing announced skips the whole pass.

It over-rebuilds rather than under-rebuilds: any node bumps the whole lane, and a node from
another scene bumps it just the same. That is the right way round — a needless rebuild is only
slow, a missed one is wrong — and it fires rarely. Measured across every example scene, the
only rebuilds are in the one scene that animates its content; the other ten are at zero, with
frame rates unchanged.

Transforms bump neither of the two geometry counters — they are re-uploaded from the world
matrix and never baked into a packed buffer — but they do bump the object-record one, because
that is exactly what they change.

### The structure changes — shapes added or removed, or the visible set shifts

A full lane rebuild: re-tessellate everyone, repack the vertex and index buffers, recreate the
object buffer and its bind group. Expensive, and rare.

---

## Where glyphs come from

Both text paths draw from **generated assets**, and neither reads a font file. That is a
deliberate boundary: the engine's whole dependency list is `earcut` and `svgpath`, and turning
a `.ttf` into something drawable happens once, offline, in `packages/scripts`.

| Path | Asset | Per style | What the runtime does with it |
| --- | --- | --- | --- |
| `Text` | MSDF atlas — `inter-*.png` + `inter-*.json` | ~90–120 kB PNG | samples a distance field in the text lane |
| `VectorText` | polygon atlas — `inter-*.polygons.json` | ~50 kB | triangulates rings into mesh geometry |

The polygon atlas is the newer of the two and the reason the parser left. It holds each glyph's
outline already flattened to line segments in **whole font units** (at Inter's 2048 units per em
that is a rounding error of 1/2048 em, far below the 1/400 em tolerance the curves were
flattened at, and it makes the file a fraction of the size it would be as floats), plus the
boxes, advances, kerning pairs and decoration metrics the shaper needs. `PolygonFont` reads it
into the same `FontMetrics` the MSDF path uses and triangulates a glyph the first time it is
drawn.

What that replaced was 1.6 MB of TTF plus a 240 kB parser, downloaded to recompute a fixed
answer on every load — the flattened outline of Inter's 'A' does not change between sessions.
Four polygon atlases are about 200 kB in total and need no parser at all.

The cost is that a polygon atlas, like an MSDF one, covers the charset it was generated for.
Where the font genuinely is not known until runtime — a user upload, a font picker — the opt-in
`@mvpaint/ttf` package parses one in the browser and satisfies the same `VectorFonts` interface
(`text/vectorGlyphs.ts`), so a `VectorText` cannot tell the difference. It shares its extraction
code with the offline generator, which is what makes a baked glyph and a live-parsed one
identical rather than merely similar; the generator's self-test asserts it, and also that the
committed atlases are the ones the tool produces today.

## Why text repacks more often than shapes do

The rule above is single: a rebuild is needed when a value **baked into the vertex buffer**
changes, because everything in the object record is rewritten every frame anyway. What makes
the two lanes feel so different is only *which* of their values sit where.

```
Shape (mesh):   position f32x2 · packedId u32                              12 B
Text:           position f32x2 · uv f32x2 · color f32x4 · packedId u32     36 B
```

### Shape

**Repacks** — everything `buildGeometry()` reads: `Circle.radius`; `Polyline.points`;
`Path.contours` and `Path.filled`; `strokeWidth`, `lineJoin`, `lineCap`, `miterLimit`; a Rect's
or Image's `width`/`height`. Toggling `visible` also repacks, though by a different route — an
invisible shape never enters the ordered list at all (`scene/picking.ts`), so the visible set
changes and `sameMembers` catches it without any epoch.

**Free** — the transform (`x`, `y`, `rotation`, `scale`, `skew`, `offset`), `zIndex` via depth,
`fill` and `stroke` colours, and every gradient parameter.

### Text

**Repacks** — very nearly everything: the string and its runs; `fontStyle`, `fontSize`,
`letterSpacing`, `baselineShift`; `align`, `maxWidth`, `lineHeight`, `direction`, `orientation`,
`textPath`; `underline`, `strikethrough` and `highlight`, which add and remove whole quads;
`shadow` and `glow`, which add a duplicate copy of every glyph; faux italic, whose shear is
baked into each corner by `quadCorner()`; and `color`, which is packed per vertex.

**Free** — the node's transform, `zIndex` via depth, per-run gradient parameters, and
`strokeColor`, `strokeWidth`, `distanceRange` and `dilate`.

### The two inversions

| | Shape | Text |
| --- | --- | --- |
| `strokeWidth` | **repacks** — the stroker emits real triangles for the outline | **free** — a distance threshold the fragment shader compares against: `obj.strokeWidth * screenPerWorld` |
| fill colour | **free** — `fillColor` at byte 272 of the object record | **repacks** — packed into every vertex |

Exactly opposite, on both. That is the point worth carrying away: the rule has nothing to do
with what a property is called or how structural it feels. `strokeWidth` sounds geometric, and
is, for a shape — but for text it is a number compared against a signed distance, so changing it
costs four bytes. `color` sounds cosmetic, and is, for a shape — but for text it lives in the
vertex stream, so changing it repacks the lane.

### Why the difference exists at all

A shape has **one geometry and one transform**. Every vertex of a rect is affected by `x` in
exactly the same way, so `x` factors out of the vertex data into a single matrix the shader
applies to all of them. The geometry is *invariant* under the transform, and that invariance is
what makes the indirection possible in the first place.

A text node has **many glyphs at many different places**, and those places are the output of
shaping. There is no per-node value from which a shader could derive where glyph 47 sits.
Change the font size and every glyph moves by a different amount; change the wrap width and some
jump to another line. **The layout is the geometry.** So under a non-instanced design it has to
be in the vertex stream.

Put the other way round: for a shape, the thing that varies per frame is shared by all its
vertices; for text, the thing that varies is different for every quad.

`VectorText` has the same property for the same reason. It draws through the *mesh* lane, but
its glyph outlines are baked, so re-shaping repacks the mesh buffer exactly as re-shaping
repacks the text buffer.

This is also why a missing rebuild signal went unnoticed for so long. The mesh lane's repack
list is short and mostly one-time — few applications animate a circle's radius — while the text
lane's is "nearly everything about the text", so any animated text content lands in it. The gap
was invisible for the whole life of the mesh lane and surfaced the moment a scene animated a
`textPath` offset.

If the per-glyph placement were moved into a storage buffer and the quads drawn with
instancing, re-shaping would land in the cheap per-frame path too, and the text lane would
behave like the mesh lane in this respect. Nothing needs that today.

---

## Shadows

Different from everything else, because a blurred silhouette cannot be computed per-fragment
cheaply.

In the **prepass**, each caster's local-space geometry is rasterized as coverage into a scratch
texture, optionally grown or shrunk (`shadowSpread`, two separable morphology passes), blurred
horizontally into a second scratch, then blurred vertically straight into its slot of a shared
atlas. Every pass is bounded by the slot size, never by the canvas — which is the whole
difference from rendering each shadow through a full-screen pass. Coverage is single-channel
`r8unorm`; a shadow is a stencil, and its colour lives in the object record.

The slot is sized from things a transform cannot affect: local silhouette bounds and blur
radius. It is re-baked only when `geometryVersion`, `shadowBlur`, `shadowSpread` or
`shadowForStrokeEnabled` changes. Position, rotation, scale, parenting, the shadow's own offset
and camera zoom are all applied afterwards, to the quad that samples the slot — so dragging,
spinning or zooming a shadowed shape re-bakes nothing. Moving the shadow stress scene's 1344 shadowed shapes
costs zero bakes.

Casters are deliberately **not** culled: a shape just off-screen can still throw a shadow into
view, and keeping its slot baked avoids a stutter the moment it scrolls in.

Then in the main pass, one textured quad per shadow samples its slot. Nothing outside the atlas
caches a slot, because a re-bake can move a shape to a different rectangle without the set of
casters changing at all. The shadow offset is applied along **world** axes rather than the
shape's own, matching canvas 2D — where a shadow's offset lives outside the current transform,
so a rotated shape's shadow still falls in the direction the notional light comes from.

---

## A worked example

You write:

```ts
scene.root.addChild(new Circle({ x: 100, y: 50, radius: 40, fill: [1, 0, 0, 1] }))
```

1. The constructor stores fields. No GPU work, no geometry.
2. The app calls `markGeometryDirty()` on the renderer — the visible set changed.
3. **Gather.** The circle sorts into z-order at rank *r*, takes `depth = (n - r) / (n + 1)`,
   buckets into the mesh lane, survives the cull. Its fill is at alpha 1 and its stroke colour
   defaults to opaque, so it classifies as opaque and lands in the head of the mesh list.
4. **Rebuild.** Set membership changed, so `batcher.rebuild()` runs. `tessellate()` calls
   `buildGeometry()` once: a fan of 101 vertices and 100 triangles around **(0, 0)** — its own
   local space, the segment count chosen from the radius. The batcher rebases the indices, stamps object id 37 into
   each vertex's `packedId`, appends to the shared arrays, and uploads one vertex buffer and
   one index buffer for the entire scene.
5. **`updateObjects()`.** Slot 37 receives the world matrix (a translation to 100, 50), the
   depth, `fillType = 0`, `fillColor = (1, 0, 0, 1)`. 304 bytes, uploaded inside a merged dirty
   range.
6. **Draw.** In the opaque pass: `setBindGroup(0, frame)`, `setBindGroup(1, objects)`,
   `setVertexBuffer`, `setIndexBuffer`, and one `drawIndexed` covering every opaque mesh shape
   in the scene.
7. **Vertex shader.** Reads `objects[37].model`, transforms the local origin-centred positions
   to clip space, overwrites `clip.z` with the object's depth.
8. **Fragment shader.** `fillType == 0`, so it returns `fillColor`. The depth test decides
   whether the fragment survives.
9. The pass ends and the four-sample texture resolves into the swapchain.

Then you set `circle.x = 200`. Steps 1–4 and 6–9 are unchanged; only step 5 runs again, and
only for slot 37.

---

## Two render paths

The engine is WebGPU. `webgl/` is a **second, separate implementation** for machines that do
not have WebGPU yet, and it is meant to be deleted again once they are rare enough.

It is separate in the strong sense. There is no device abstraction, no backend interface and
no lane abstraction anywhere in this engine, because building one would mean shaping the
permanent path around the temporary one. The WebGPU files call `device.queue.writeBuffer` and
`pass.drawIndexed` directly, exactly as they always have, and nothing in them knows a second
path exists.

What the two share is everything that was never about graphics in the first place: the whole
scene graph, the gather, the byte layouts in `render/*Format.ts`, the draw-order merge, the
opacity split, the stroker, the shadow maths, the shaper. What they do not share is anything
that touches an API.

The seam between them is one function with one branch —
`renderer/createSceneRenderer.ts` — and one interface, `SceneRendererHandle`, which is just
"everything an application does with a renderer" and mentions no API. The fallback is reached
through a dynamic `import()`, so a browser with WebGPU never downloads it. Removing it later
is deleting `src/webgl/` and a `catch`.

Where the fallback differs is **scale**, not edge quality. It renders with 4x MSAA too, from
the browser's own multisampled drawing buffer (`antialias: true`) rather than from a
multisampled target it drives itself — the picture is the same, and it saves a full-screen
blit and a second colour buffer every frame, at the cost of not being able to *name* a sample
count (the implementation picks; `Gl2Context.sampleCount` reports what was granted). What it
does target is tens of thousands of objects rather than hundreds of thousands. WebGL2 has no
storage buffers, so the per-object
records that carry every transform and material become a float data texture read with
`texelFetch` — the same architecture, reached a slower way. `webgl/ObjectTexture.ts` explains
that substitution, including why integer fields are stored as floats rather than as
reinterpreted bits.

The GLSL is a template string that interpolates the same `OBJECT_*_OFFSET` constants the WGSL
and the batchers use (`webgl/shaders/`), so the two shaders cannot drift apart — there is only
one copy of the record layout and both read it.

All four lanes are implemented — mesh, text, image and shadow. The shadow bake ports without
a compute shader because it never needed one: silhouette, separable morphology and separable
Gaussian are already ordinary render passes into small textures. The one thing that genuinely
diverges is render-to-texture orientation — WebGPU puts NDC y = +1 in a texture's *first*
texel row and GL in its *last* — and it is corrected in exactly two places, pinned by
`webgl/selfTest.ts` because getting one without the other gives upside-down shadows.

`npx tsx src/webgl/selfTest.ts` covers the pure half: the data texture's index maths, and
every generated shader's agreement with the record layout it was generated from.

### Choosing a GPU

Both paths take the same option and both default it the same way (`renderer/adapter.ts`):

```ts
createSceneRenderer(canvas, { powerPreference: 'high-performance' })  // the default
```

WebGPU passes it to `requestAdapter()`, WebGL2 to `getContext('webgl2', …)`. It is a **hint
with two settings** and the only control the platform offers — there is no device list to
enumerate and no way to name a GPU, because an exact hardware list is a strong fingerprint.
On a machine with an integrated GPU and a discrete card it selects between them; on a machine
with one it does nothing; and it loses outright to a browser already pinned to an adapter from
outside the page (Windows Graphics Settings, the vendor control panel — `chrome://gpu` says
which one the browser is on).

The default is deliberately **not** the platform's. Left to choose, browsers pick the
integrated GPU — right for a page that draws a form, wrong for a renderer whose premise is a
hundred thousand shapes through a depth-tested pass.

Since the request can be silently ignored, what came back is reported rather than assumed.
`handle.adapter` carries vendor, architecture, device and the driver's description as far as
the browser discloses them (WebGPU's `adapter.info`; WebGL's `WEBGL_debug_renderer_info`,
which is more specific but more often withheld), plus a `fallback` flag for a software
renderer, which both paths also warn about once at startup.

---

## Where to look

| Concern | Files |
| --- | --- |
| Nodes, transforms, events | `shapes/Node.ts`, `shapes/Shape.ts`, `shapes/Group.ts`, `shapes/Layer.ts`, `events/` |
| The view: pan, zoom, rotate | `camera/Camera2D.ts`, `input/viewport.ts`, `input/cameraControls.ts` |
| Geometry per shape | `shapes/Rect.ts`, `Circle.ts`, `Polyline.ts`, `Path.ts`, `Image.ts` |
| Shapes you write yourself | `shapes/CustomShape.ts`, `shapes/ShapeContext.ts` |
| Stroking, SVG flattening | `render/stroke.ts`, `svg/flattenPath.ts` |
| Text shaping | `text/layout.ts`, `text/textQuad.ts`, `text/textPath.ts` |
| Where glyphs come from | `text/msdfMetrics.ts`, `text/PolygonFont.ts`, `text/vectorGlyphs.ts` |
| Generating those assets | `packages/scripts/text/msdf/`, `packages/scripts/text/polygon/` |
| Parsing a font at runtime | `packages/ttf/` (opt-in; not a dependency of the engine) |
| Buffer formats | `render/meshFormat.ts`, `textFormat.ts`, `imageFormat.ts`, `shadowFormat.ts` |
| Packing and uploads | `webgpu/lanes/MeshBatcher.ts`, `TextBatcher.ts`, `ImageBatcher.ts`, `ShadowBatcher.ts` |
| Shaders | `webgpu/shaders/mesh.wgsl.ts`, `text.wgsl.ts`, `image.wgsl.ts`, `shadowQuad.wgsl.ts`, `shadowBake.wgsl.ts` |
| Pipelines, bind layouts | `webgpu/pipelines/`, `webgpu/layouts.ts`, `webgpu/vertexLayouts.ts`, `webgpu/depthFormat.ts` |
| The gather (shared, GPU-free) | `render/gather.ts` |
| Orchestration | `webgpu/index.ts`, `webgpu/SceneRenderer.ts`, `webgpu/FrameRenderer.ts`, `webgpu/GpuContext.ts` |
| Choosing a render path | `renderer/createSceneRenderer.ts`, `renderer/SceneRendererHandle.ts` |
| Where the canvas comes from | `renderer/canvasTarget.ts` |
| Choosing a GPU | `renderer/adapter.ts`, `webgpu/GpuContext.ts`, `webgl/Gl2Context.ts` |
| The WebGL2 fallback (temporary) | `webgl/` |
| Z-order, picking, culling | `scene/picking.ts`, `scene/culling.ts`, `scene/selection.ts` |
| Draw order and the two passes | `render/opacity.ts`, `render/drawOrder.ts` |
| Invalidation | `shapes/contentEpoch.ts` |
| Input and gestures | `input/SceneInputDispatcher.ts`, `shapes/Transformer.ts` |
| The bindings themselves | `input/inputOptions.ts`, `input/sceneInput.ts`, `input/MarqueeOverlay.ts` |

Each engine subdirectory carries a `selfTest.ts` covering its pure half, run with
`npx tsx src/<dir>/selfTest.ts`. Everything needing a GPU or a DOM is verified in a browser
instead.
