# mvPaint

A 2D scene-graph renderer for the browser, built directly on **WebGPU**, with a WebGL2
fallback for machines that do not have it.

You build a tree of nodes — rectangles, circles, paths, images, text — set their transforms
and paint, and the engine turns the whole thing into a handful of GPU draw calls per frame. It
is the drawing layer for a canvas-style application: a diagram editor, a design tool, a
whiteboard, a document viewer. It is not a game engine and not a React renderer; it owns
pixels, and nothing above them.

Starting one takes two arguments, both optional — where to draw, and what a pointer means:

```ts
// Selection, dragging, resize/rotate, marquee, pan, pinch, wheel and keyboard, wired up.
const handle = await createSceneRenderer('#board', { input: 'editor' })
handle.scene.root.addChild(new Rect({ width: 260, height: 140, cornerRadius: 12, fill: 'tomato' }))
```

That is the whole of the setup. Pass a canvas instead of a selector, or nothing at all;
ask for `'view'` (camera only) or leave `input` out for a static render. See
[Setup](#setup).

**[Live examples →](https://kristoferborgware.github.io/mvPaint/)**

---

## Render paths

WebGPU is the engine. `createSceneRenderer()` uses it, and falls back to a second, separate
WebGL2 implementation only when it is unavailable — `handle.path` says which one you got, and
`backend: 'webgl2'` forces the fallback, which is how it gets tested on a machine that has
WebGPU. The fallback is dynamic-imported, so a browser with WebGPU never downloads it.

Both draw every node type, through the same scene graph, the same picking, the same
z-ordering and **4x MSAA**. What differs is scale: WebGL2 has no storage buffers, so per-object
records travel through a float texture instead, and the fallback targets tens of thousands of
objects rather than hundreds of thousands.

It is temporary, and built to be deleted: `src/webgl/` plus one branch in
`renderer/createSceneRenderer.ts`. Nothing in the WebGPU path was reshaped to accommodate it.

### Which GPU

On a machine with two — an integrated one and a discrete card — both paths ask for the
**discrete** one, which is not what the platform does on its own: browsers left to choose pick
the integrated GPU. `powerPreference: 'low-power'` asks for the other, for an application that
would rather have the battery.

That is the whole of the control available. Neither WebGPU nor WebGL lets a page enumerate the
GPUs in a machine or name one, deliberately — an exact hardware list is a strong fingerprint —
so what there is is a two-setting hint, and a machine with one GPU ignores it. A browser
already pinned elsewhere overrides it too: on Windows the GPU process follows the per-app
setting in Windows Graphics Settings and in the vendor's control panel, and no page can undo
that from inside. `chrome://gpu` says which adapter the browser itself is on.

Because a hint that was not honoured is otherwise invisible, `handle.adapter` reports what
actually came back — vendor, family and the driver's own description, as far as the browser
will disclose them — and flags a **software** renderer (SwiftShader, llvmpipe, WARP), which
draws the right picture slowly and otherwise looks exactly like the engine being slow.

## What it is for

Applications that draw a lot of vector content, keep it interactive, and need it to stay sharp
at any zoom. The design targets three things that are awkward in a 2D canvas API:

- **Scale.** 100,000 shapes render in a single draw call. Geometry is tessellated once on the
  CPU into shared buffers; per-frame work is a transform refresh, uploaded only for the objects
  that actually changed — and skipped entirely, on one integer compare, when nothing did.
- **Correct transparency.** Alpha blending is order-dependent and the depth test is not, so the
  frame is drawn in two passes — provably-opaque objects first, batched and writing depth, then
  everything translucent strictly back-to-front, testing depth but never writing it. A
  translucent shape shows what is behind it regardless of which lane that thing lives in.
- **Real text.** Not `fillText` into a texture. Glyphs are multi-channel signed distance fields
  from a generated atlas, so a paragraph is crisp at any camera zoom, and all four styles share
  one atlas array — a page mixing regular, bold and italic is still one draw call.

## Prime features

**Shapes and paint**
`Rect` (with per-corner rounding), `Circle`, `Polyline`, `Path`, `Image`, `Group`. Solid fills,
plus linear and radial gradients evaluated analytically in the shape's own local space, so a
gradient rotates and scales with its shape for free. Strokes with miter/round/bevel joins, butt
/round/square caps and a miter limit.

`strokeScaleEnabled: false` holds a stroke at the width it was given however the shape (or an
ancestor) is scaled — a keyline, a selection frame, a hairline on a drawing. It stays even under
non-uniform scale and skew, not just uniform: the ribbon is built through the transform rather
than divided by a factor, because a 4:1 stretch thickens a diagonal by neither 4 nor 1.

Every colour takes either form — the `[r, g, b, a]` tuple in 0..1, or a string: `'#f80'`,
`'#ff8800cc'`, `'rgb(255 136 0)'`, `'rgba(255,136,0,0.5)'`, `'hsl(32 100% 50%)'`, `'tomato'`,
`'transparent'`. Strings are converted on assignment and read back as the tuple, so nothing
below the scene graph ever sees one.

**Shapes you write yourself**
`CustomShape` is the base for a shape the engine does not know about: subclass it, implement
`describe(ctx)`, and draw the outline into a path builder that speaks `moveTo`/`lineTo`/curves/
arcs/`closePath` and produces mesh geometry rather than pixels. It is then a shape like any
other — picked on its real outline, framed by its real bounds, casting a blurred shadow from its
own silhouette, wearing a gradient, and stacked with everything else. `ctx.style()` gives an
individual run of segments its own colour and thickness, so one continuous outline can change
partway along without becoming several nodes.

**Object opacity**
`shape.opacity` fades a whole object — fill, stroke, gradient, glyph, texture and its shadow
alike — and is kept out of its colours, so a fade never has to know or restore what it touched.
It multiplies with a colour's own alpha rather than replacing it, rides in padding the per-object
records already had (so nothing grew), and keeps the shape out of the opaque pass automatically.

**Stacking that just works**
Things stack in the order you make them — every shape takes the next number from a running
counter as its `zIndex`, so a new one lands on top with nothing to set, across lanes as much as
within one. Override it when you mean to: `front.zIndex = back.zIndex + 1` to put one shape over
another, `shape.zIndex = nextZIndex()` to bring an existing one to the front, and any negative
value to send one behind everything.

**Lifecycle**
`node.remove()` takes something out of the scene and leaves it entirely reusable;
`node.destroy()` finishes with it and its subtree, dropping listeners and caches;
`node.moveTo(parent)` re-homes it, optionally keeping it exactly where it is on screen. Nothing
needs telling either way — the renderer rebuilds its visible set from the tree every frame, so
a removed node stops drawing on the next one and its shadow-atlas slot comes back on its own.

**Grouping and layers**
A `Group` is a *unit*: it places its contents, sizes itself to them, hides them together, and a
drag inside one takes hold of the whole thing. A `Layer` is the opposite trade — optional (not a
canvas, and not a draw-order boundary; `zIndex` still decides what is on top, scene-wide), it
names a slice of the scene and switches it off with one `enabled`, while every shape inside stays
independently selectable and draggable.

**Text, two ways**
`Text` draws through the MSDF atlas — cheap, four vertices per glyph. `VectorText` tessellates
the real glyph outlines through the mesh lane, so letterforms get true blurred shadows and
per-glyph picking. Both share one shaper: wrapping, alignment (including justified), kerning,
letter spacing, line height, baseline shift, RTL and vertical flow, per-run colour or gradient,
underline/strikethrough, highlight, per-letter outline, and text laid along an arbitrary path.

Both read **generated assets** — a distance-field PNG for one, a polygon atlas of flattened
outlines for the other — so the engine carries no font parser: its whole dependency list is
`earcut` and `svgpath`. Outlines are flattened once, offline, rather than in every browser on
every load, which is smaller *and* faster than shipping the font. Where the font genuinely
isn't known until runtime — a user upload, a font picker — `@mvpaint/ttf` parses one and hands
the engine the same interface; an application that doesn't need it never downloads a parser.

**Shadows**
The canvas 2D model — colour, blur, offset, opacity — plus CSS `box-shadow`'s spread. Blurred
silhouettes are baked once into a shared atlas keyed on geometry, so moving, spinning or
zooming a shadowed shape re-bakes nothing and every shadow in the scene draws in one call.

**Scene graph and interaction**
Nodes carry the transform (position, rotation, scale, skew, offset); shapes add the paint.
Events bubble, so one listener on the root covers a whole subtree. Hit-testing is against real
tessellated triangles, not bounding boxes — and is skipped wherever its answer cannot matter:
a scene with no hover handler never hit-tests a pointer move, and an event whose only listeners
are on the root resolves `event.target` lazily, since everything bubbles there regardless. On a
100k-shape scene that is the difference between 82 ms and 0.1 ms per wheel event. Included: node dragging, marquee selection, and a
`Transformer` for resize/rotate with angle snapping.

**Input by name**
`input: 'editor'` is the whole of it: selection, dragging, the resize/rotate frame, marquee,
pan, pinch, wheel and keyboard, wired to the canvas by the engine. `input: 'view'` is the
camera alone and never picks anything; leaving it out is a static render that still owns its
camera. See [Setup](#setup) — the presets are built from the same public parts an application
would use to write its own, and switch off a behaviour at a time.

**Screenshots**
`handle.toCanvas()` / `toDataURL()` / `toBlob()` render the scene again offscreen and hand back
the pixels. A second render, not a copy of the canvas, so the image can be any region of world at
any resolution — and the engine builds the camera from the rectangle you ask for, leaving the
live view untouched. Captures are 4× MSAA on **both** paths, including the WebGL2 fallback whose
live frames have none: that cost is per-frame and a screenshot is taken once.

**Camera**
`Camera2D` is a plain object the application owns and mutates — pan, zoom, rotate. Supplying
none is a valid choice, not a missing one: the scene then renders with world (0, 0) at the
viewport's top-left at one unit per CSS pixel. The `'view'` and `'editor'` input sets move that
same object for you; a static render leaves it entirely yours, and it is still yours to move
from code under either.

**SVG**
`loadSvg()` parses a document into `Path` nodes, flattening curves and carrying fills,
gradients and strokes across.

---

## A small example

```ts
import { Circle, Group, Rect, Text, createSceneRenderer } from '@mvpaint/engine'

// Where to draw, and what a pointer means. Both are optional: a canvas element, a CSS
// selector, an element to build one inside, or null for a canvas over the whole window.
// 'editor' is the full interactive set - see Setup below for the other two.
const handle = await createSceneRenderer('#board', { input: 'editor' })

// A card: a rounded rect with a soft shadow, and a label sitting on top of it.
const card = new Group({ x: 120, y: -80 })

card.addChild(
  new Rect({
    name: 'card-face',
    width: 260,
    height: 140,
    cornerRadius: 12,
    fill: [1, 1, 1, 1],
    stroke: [0.8, 0.84, 0.9, 1],
    strokeWidth: 1.5,
    shadowColor: [0, 0, 0, 0.25],
    shadowBlur: 24,
    shadowOffsetY: 8,
  }),
)

card.addChild(
  new Text({
    x: 20,
    y: -34,
    text: 'Hello, mvPaint',
    style: { fontSize: 22, fontStyle: 'bold', color: [0.1, 0.12, 0.16, 1] },
  }),
)

// A circle behind the card, with a gradient fill.
const dot = new Circle({ name: 'dot', x: 90, y: -150, radius: 46, zIndex: -1 })
dot.fillPriority = 'linear-gradient'
dot.fillLinearGradientStartPoint = { x: -46, y: 0 }
dot.fillLinearGradientEndPoint = { x: 46, y: 0 }
dot.fillLinearGradientColorStops = [
  { offset: 0, color: [0.2, 0.7, 0.9, 1] },
  { offset: 1, color: [0.5, 0.3, 0.9, 1] },
]

// Content appears on the next frame - no dirty mark, no rebuild call.
handle.scene.root.addChild(dot)
handle.scene.root.addChild(card)

// Animation is attached the same way, so it can just close over what it animates.
handle.onFrame = (dt) => {
  dot.rotation += dt
}

// Events bubble, so one listener on the root covers the whole subtree.
handle.scene.root.on('click', (event) => {
  console.log('clicked', event.target.name)
})

// Everything the 'editor' set does is already live: pressing a shape selects and drags it,
// a rectangle dragged over empty space selects what it covers, ctrl-drag and the wheel move
// the view. What is selected is here, and is the application's to read or replace.
handle.input?.transformer?.on('attachchange', () => {
  console.log('selected', handle.input?.selection.map((node) => node.name))
})
```

Two conventions worth knowing up front. The scene is **y-up**, so a shape hangs *downward* from
its origin. And a shape's origin is its top-left corner, except for radius-defined shapes like
`Circle`, which are centred — which is also the pivot rotation and scale turn about. To spin a
rect around its own middle, give it `offsetX: width / 2, offsetY: -height / 2`.

Changing a transform, a colour or a gradient is free — those live in a per-object GPU buffer
refreshed every frame. Changing what a shape *is* (a radius, a point list, a stroke width) needs
`shape.markGeometryDirty()`, because it invalidates cached tessellation. Adding or removing
nodes needs `handle.markGeometryDirty()`.

---

## Setup

Two arguments, both optional: **where to draw**, and **what a pointer means**.

```ts
await createSceneRenderer()                              // a canvas over the whole window
await createSceneRenderer('#board')                      // that canvas
await createSceneRenderer('#stage', { input: 'view' })   // a canvas built inside that element
await createSceneRenderer(canvasEl, { input: 'editor' }) // the element you already have
```

A **selector naming a canvas** uses it; one naming anything else treats that element as the
container and builds a canvas filling it, so the page's own CSS decides the size. `null` (or
nothing) builds one over the viewport — for a sketch or a test page, where writing the HTML
first is the only thing between an idea and seeing it drawn.

Input is **opt-in**, in three settings:

| `input` | what listens | what a press does |
| --- | --- | --- |
| *omitted* | nothing at all | nothing — a **static** render. The camera is still yours to move from code |
| `'view'` | canvas + keyboard | pans; wheel/pinch zoom about the cursor. Nothing is ever picked, so a press always lands on empty space |
| `'editor'` | canvas + keyboard | selects, drags, resizes and rotates through the frame; a drag over empty space pulls out a marquee; ctrl/space-drag pans |

`'view'` does not merely ignore what is under the pointer — it never asks. A pick walks every
shape in the scene, so on a large one the difference between *picked and discarded* and *never
picked* is the whole frame.

Nothing is all-or-nothing: the long form turns individual behaviours off, and everything the
preset built is reachable afterwards.

```ts
const handle = await createSceneRenderer('#board', {
  input: {
    camera: { zoom: false },            // a fixed-scale view that still pans
    objects: { drag: false },           // select and frame, but never move anything
    keyboardTarget: null,               // an embedded canvas that must not eat the space bar
  },
})

handle.input?.select(node)              // the selection is an ordinary API too
handle.input?.dispatcher.grabContent = false   // what a hand tool does
```

An application whose bindings genuinely differ leaves `input` out and builds its own on the
same public parts — `SceneInputDispatcher`, `MarqueeTool`, `Transformer`, `panToAnchor`,
`zoomToward`. The presets are the ordinary answers, not the only ones.

---

## Getting started

Requires **Node 20+** and a browser with WebGPU (Chrome and Edge 113+, and anything else that
has shipped it).

```bash
npm install
npm run dev          # the example app, with every demo scene
npm test             # self-tests across every package (no GPU needed)
npm run build        # typecheck + production build
npm run gen:fonts    # regenerate the glyph atlases from the fonts in packages/scripts
```

### Repository layout

```
packages/engine        the renderer - no demo content, no framework, no font parser
  src/shapes/          Node, Container, Group, Layer, Shape and the concrete shapes
  src/render/          buffer formats, batchers, pipelines, WGSL, draw order
  src/text/            the shaper, MSDF metrics, and the polygon atlas glyphs are read from
  src/input/           the pointer dispatcher, and the 'view'/'editor' bindings over it
  src/renderer/        choosing a render path, and finding or building the canvas
  src/webgpu/          SceneRenderer: the gather, the passes, createSceneRenderer()
packages/scripts       offline tools: MSDF and polygon atlas generation, and the font sources
packages/ttf           opt-in: parse a TTF in the browser, for fonts unknown until runtime
packages/example-app   a React host for the demo scenes; the engine needs none of them
```

Each engine subdirectory carries a `selfTest.ts` covering its pure half, and the two satellite
packages carry their own — 2,140 assertions across thirteen suites, run under plain Node with no
GPU. Anything needing a GPU or a DOM is verified in a browser instead.

### Demo scenes

Shapes and gradients · Custom shapes · Stroke and scale · Groups · Layers · Colour forms · Object opacity · MSDF text · Outline text · Text on a path ·
Runtime TTF · Images · Transparency across lanes · Shadows · SVG document · Stacking order · and four stress tests
(100k shapes, 1k+ shadows, and twenty A4 pages of styled prose through each text implementation).

---

## How it works

**[ARCHITECTURE.md](ARCHITECTURE.md)** is the real documentation: one frame end to end, the
gather, the buffer formats byte by byte, the four render lanes and the two passes, what happens
when each kind of property changes, and how shadows are baked. Start there before changing
anything.

The short version: every shape tessellates once into shared vertex/index buffers, with its
transform and material in a storage buffer indexed by an id packed into each vertex. Stacking
order comes from a `zIndex` rank injected as the depth value, so shapes, text and images
interleave freely instead of one lane always winning. Four lanes (mesh, text, image, shadow)
share the frame uniforms, the depth buffer and one render pass, and the frame is drawn as an
opaque batch, then a back-to-front translucent merge, then the always-on-top overlay.
