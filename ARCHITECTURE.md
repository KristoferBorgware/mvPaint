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

### The camera is not in the graph

`Camera2D` (`camera/Camera2D.ts`) is a plain object, not a node. A camera is not a thing *in*
the scene, it is the frame the scene is viewed through, and the **application owns it** —
`createSceneRenderer({ camera })`, or `setCamera` later. Nothing in the graph refers to it and
it refers to nothing in the graph, so one scene can be drawn through two cameras at once.

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

### The tessellation cache

`tessellate()` runs `buildGeometry()` once, keeps the vertex/triangle arrays, and replays them
into whatever sink asks. It is invalidated only by `markGeometryDirty()`.

A second, flattened structure (`xs`/`ys`/`tris`/`bounds`) is derived lazily from the same
output for hit testing and bounds. It is not a second tessellation, just a layout better suited
to point-in-triangle tests — which is why a mousemove over a hovered shape redoes no work.

---

## One frame, end to end

`systems/FrameRenderer.ts` owns the loop and the boilerplate:

```
requestAnimationFrame tick
  ├─ resize check; (re)create the depth and MSAA textures if the canvas changed size
  ├─ createCommandEncoder()
  ├─ onPrePass(encoder)          ← shadow silhouette baking, in its own passes
  ├─ beginRenderPass({ colour: MSAA texture, resolveTarget: swapchain, depth: depth24plus })
  │    └─ onFrame({ pass, dt, width, height })    ← SceneRenderer records every draw here
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

The first thing `SceneRenderer.draw()` does each frame, before any drawing.

**Z-order.** `collectZOrder()` walks the tree and stable-sorts every shape by `zIndex`. Stable,
so ties keep scene-graph order.

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
they occupy a contiguous tail of the index buffer. That is what lets one buffer be drawn as two
ranges under two pipelines.

**The fast path.** When culling and z-sorting are both off and nothing is dirty, the entire
gather is skipped and last frame's arrays are reused. That is how a 100k-shape scene avoids
re-traversing itself sixty times a second.

---

## The buffers

### Frequency model (bind groups)

Layouts are created explicitly and shared across pipelines rather than using `layout: 'auto'`,
precisely so groups 0 and 1 can be bound once and reused across lanes.

| Group | Contents | Written |
| --- | --- | --- |
| **0** | `viewProjection` mat4 + `resolution` vec2 (80 bytes, uniform) | once per frame |
| **1** | array of object records (read-only storage) | per frame, changed slots only |
| **2** | texture + sampler (font atlas, image, shadow atlas) | per draw range |

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

The text record is also 304 bytes — the same transform and gradient fields, extended with a
per-letter outline colour and width and the atlas distance range. The image record is 96 (model,
tint, depth) and the shadow record 128.

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

| Lane | Fragment work | Draw calls |
| --- | --- | --- |
| **Mesh** | flat colour, or an analytic gradient | one per run, plus one for the overlay tail |
| **Text** | MSDF: `median(r,g,b)`, an `fwidth`-based screen-pixel range, an optional second threshold for per-letter outline | one per run, split again per font atlas |
| **Image** | `textureSample(...) * tint` | one per run, split again per (texture, sampler state) |
| **Shadow** | sample the pre-blurred silhouette, tint it | one, after the content lanes |

### Why the content lanes interleave

The three content lanes are **not** drawn one after another. They are merged into a single
back-to-front sequence and drawn in runs — one draw per *lane change* (`render/drawOrder.ts`).

They used to draw one lane at a time, and the depth buffer was supposed to arbitrate. It
cannot, for anything translucent. Alpha blending and the depth test know nothing about each
other, so a fragment at alpha 0.4 still writes depth — and whatever sat behind it **in a later
lane** was then rejected outright instead of showing through. Transparency worked in one
direction and not the other, decided by which lane a thing happened to be in.

Back-to-front is the only order alpha blending composites correctly in, so that is the order
they go in. The depth test still runs, and still resolves the shadow lane against all of it;
it just no longer has to arbitrate between the content lanes, because every fragment now
arrives at or nearer than what it lands on and always passes.

The cost is proportional to how much the scene alternates. Measured on the merge itself:

| scene | runs | merge cost per gather |
| --- | --: | --: |
| 100k shapes, all one lane | **1** | 0.91 ms |
| 10k shapes, all one lane | **1** | 0.11 ms |
| 100k alternating mesh/text | 100000 | 9.71 ms |

Both stress tests are a single run, so nothing changed for them. A page of shapes with text
over it is two or three. Only a scene that genuinely alternates kinds at every depth pays per
object — and it pays that to be correct. If that ever becomes real, the fix is to batch the
*opaque* objects per lane (they need no ordering at all) and interleave only the translucent
ones; nothing today needs it.

The shadow lane is the exception that proves the rule. Shadows are drawn last, depth-**tested**
but never depth-**writing**, half a depth step behind their caster. By then every shape has
written its depth, so the test alone decides whether a shadow lands on a given shape or is
hidden behind it — including the shape casting it. Drawing shadows first instead would paint
every one of them under everything, which is only right for a single-layer scene.

---

## What happens when a property changes

The most subtle part of the system, and the one most worth understanding before changing
anything.

### A transform changes — `x`, `y`, `rotation`, `scale`, `skew`, `offset`, `zIndex`

Nothing is rebuilt. `localMatrix()` misses its cache, produces a new matrix instance, and next
frame `updateObjects()` sees a different `model` reference and rewrites that object's record.

The upload is by **dirty range**. Each slot keeps an `ObjectCache` of what was last written;
unchanged slots are skipped outright. Changed slots are collected into ranges, merging any two
within 8 slots of each other — a few hundred wasted bytes beat an extra `writeBuffer` call. If
a frame's changes scatter into more than 512 ranges, it falls back to one whole-buffer upload
rather than issuing an unbounded number of small writes. At 100k objects that is the difference
between a ~30 MB copy every frame and a few hundred bytes while dragging one shape.

### A colour changes

Same path. Solid colours and gradient parameters live in the object record, never in geometry.

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

It over-rebuilds rather than under-rebuilds: any node bumps the whole lane, and a node from
another scene bumps it just the same. That is the right way round — a needless rebuild is only
slow, a missed one is wrong — and it fires rarely. Measured across every example scene, the
only rebuilds are in the one scene that animates its content; the other ten are at zero, with
frame rates unchanged.

Transforms deliberately bump nothing.

### The structure changes — shapes added or removed, or the visible set shifts

A full lane rebuild: re-tessellate everyone, repack the vertex and index buffers, recreate the
object buffer and its bind group. Expensive, and rare.

---

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
   buckets into the mesh lane, survives the cull.
4. **Rebuild.** Set membership changed, so `batcher.rebuild()` runs. `tessellate()` calls
   `buildGeometry()` once: a fan of 101 vertices and 100 triangles around **(0, 0)** — its own
   local space, the segment count chosen from the radius. The batcher rebases the indices, stamps object id 37 into
   each vertex's `packedId`, appends to the shared arrays, and uploads one vertex buffer and
   one index buffer for the entire scene.
5. **`updateObjects()`.** Slot 37 receives the world matrix (a translation to 100, 50), the
   depth, `fillType = 0`, `fillColor = (1, 0, 0, 1)`. 304 bytes, uploaded inside a merged dirty
   range.
6. **Draw.** `setBindGroup(0, frame)`, `setBindGroup(1, objects)`, `setVertexBuffer`,
   `setIndexBuffer`, and one `drawIndexed` covering every mesh shape in the scene.
7. **Vertex shader.** Reads `objects[37].model`, transforms the local origin-centred positions
   to clip space, overwrites `clip.z` with the object's depth.
8. **Fragment shader.** `fillType == 0`, so it returns `fillColor`. The depth test decides
   whether the fragment survives.
9. The pass ends and the four-sample texture resolves into the swapchain.

Then you set `circle.x = 200`. Steps 1–4 and 6–9 are unchanged; only step 5 runs again, and
only for slot 37.

---

## Where to look

| Concern | Files |
| --- | --- |
| Nodes, transforms, events | `shapes/Node.ts`, `shapes/Shape.ts`, `shapes/Group.ts`, `events/` |
| The view: pan, zoom, rotate | `camera/Camera2D.ts`, `input/viewport.ts`, `input/cameraControls.ts` |
| Geometry per shape | `shapes/Rect.ts`, `Circle.ts`, `Polyline.ts`, `Path.ts`, `Image.ts` |
| Stroking, SVG flattening | `render/stroke.ts`, `svg/flattenPath.ts` |
| Text shaping | `text/layout.ts`, `text/textQuad.ts`, `text/textPath.ts` |
| Buffer formats | `render/meshFormat.ts`, `textFormat.ts`, `imageFormat.ts`, `shadowFormat.ts` |
| Packing and uploads | `render/MeshBatcher.ts`, `TextBatcher.ts`, `ImageBatcher.ts`, `ShadowBatcher.ts` |
| Shaders | `render/mesh.wgsl.ts`, `text.wgsl.ts`, `image.wgsl.ts`, `shadowQuad.wgsl.ts`, `shadowBake.wgsl.ts` |
| Pipelines, bind layouts | `render/*Pipeline.ts`, `render/layouts.ts`, `render/depthFormat.ts` |
| Orchestration | `webgpu/SceneRenderer.ts`, `systems/FrameRenderer.ts`, `systems/GpuContext.ts` |
| Z-order, picking, culling | `scene/picking.ts`, `scene/culling.ts`, `scene/selection.ts` |
| Invalidation | `shapes/contentEpoch.ts` |
| Input and gestures | `input/SceneInputDispatcher.ts`, `shapes/Transformer.ts` |

Each engine subdirectory carries a `selfTest.ts` covering its pure half, run with
`npx tsx src/<dir>/selfTest.ts`. Everything needing a GPU or a DOM is verified in a browser
instead.
