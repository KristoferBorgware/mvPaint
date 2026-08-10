# mvPaint

A 2D scene-graph renderer for the browser, built natively for **WebGPU**, with a **WebGL2**
fallback on unsupported devices.

You build a tree of nodes — rectangles, circles, paths, images, text — set their transforms and
paint. The engine tessellates the geometry once, keeps per-object state in GPU buffers, and
draws the scene in a small, fixed number of draw calls per frame.

It is the drawing layer for a canvas-style application: a diagram editor, a design tool, a
whiteboard, a document viewer. It is not a game engine and not a React renderer. It owns the
pixels of one canvas and nothing above them.

**[Live examples →](https://kristoferborgware.github.io/mvPaint/)**

## Who it is for

Applications that draw large amounts of vector content, keep it interactive, and need it to
stay sharp at any zoom level. Three properties make this different from a Canvas2D or SVG
implementation:

- **Batched drawing.** Geometry is tessellated on the CPU into shared vertex and index buffers.
  Per-frame work is a transform refresh, uploaded only for objects that changed, and skipped
  entirely when nothing did. Object count is not draw-call count.
- **Order-correct transparency.** The frame is drawn in two passes: opaque objects first,
  batched and writing depth, then translucent objects strictly back-to-front, testing depth but
  not writing it. Translucency is correct regardless of which render lane an object belongs to.
- **Resolution-independent text.** Glyphs are multi-channel signed distance fields from a
  generated atlas, not `fillText` into a texture. Text stays crisp at any camera zoom, and all
  four styles share one atlas array.

## Requirements

- Node 20+
- A browser with WebGPU (Chrome/Edge 113+). Browsers without it take the WebGL2 path.


## Example

```ts
import { Circle, Group, Rect, MSDFText, createSceneRenderer } from '@mvpaint/engine'

const handle = await createSceneRenderer('#board', { input: 'editor' })

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
  new MSDFText({
    x: 20,
    y: -34,
    text: 'Hello, mvPaint',
    style: { fontSize: 22, fontStyle: 'bold', color: [0.1, 0.12, 0.16, 1] },
  }),
)

const dot = new Circle({ name: 'dot', x: 90, y: -150, radius: 46, zIndex: -1 })
dot.fillPriority = 'linear-gradient'
dot.fillLinearGradientStartPoint = { x: -46, y: 0 }
dot.fillLinearGradientEndPoint = { x: 46, y: 0 }
dot.fillLinearGradientColorStops = [
  { offset: 0, color: [0.2, 0.7, 0.9, 1] },
  { offset: 1, color: [0.5, 0.3, 0.9, 1] },
]

handle.scene.root.addChild(dot)
handle.scene.root.addChild(card)

handle.onFrame = (dt) => {
  dot.rotation += dt * 60
}

handle.scene.root.on('click', (event) => {
  console.log('clicked', event.target.name)
})

handle.input?.transformer?.on('attachchange', () => {
  console.log('selected', handle.input?.selection.map((node) => node.name))
})
```

## Setup

```bash
npm install
npm run dev          # example app with every demo scene
npm test             # Vitest suite across all packages (no GPU required)
npm run test:watch   # rerun affected tests on change
npm run build        # build the packages, then the example app
npm run typecheck    # tsc --noEmit across every package
npm run gen:fonts    # regenerate glyph atlases from the fonts in packages/assets
npm run changeset    # describe a change for the next release (see Releasing)
```

Inside this repo the packages resolve to each other's `src/`, not their `dist/` — every entry in
their `exports` lists a `development` condition ahead of the built one, which Vite, Vitest and
`tsc` all honour here. So the dev server, the test suite and the typechecker all read the
source, and there is no build step between editing a file and running it. The one exception is
the offline generators, which run under plain Node: their npm scripts pass
`--conditions=development` explicitly.

That condition must never reach the registry. `src/` is not in the tarball, and consumers match
`development` too — Vite does in dev, out of the box — so a published copy resolves the package
to a file that does not exist and fails with "Failed to resolve entry for package", which is
what 0.2.0 did. `npm run release` therefore strips the condition from every publishable manifest
before it hands over to `changeset publish`, and restores it afterwards
(`scripts/strip-dev-condition.mjs`). Stripping before rather than during the publish is
deliberate: npm builds the manifest it sends to the registry from the package.json it read
*before* a `prepack` hook runs but packs the directory *after*, so stripping in `prepack` — the
obvious place — yields a correct tarball advertised by stale registry metadata.

Two things keep that honest. Each package runs the same script as `prepublishOnly`, so a bare
`npm publish` that skips the release script aborts rather than republishing the bug. And CI packs
through the strip and asserts the packed manifests are clean, because this is a failure nobody
sees locally — the repo wants the condition — and it only surfaces in someone else's dev server.

The strip removes that `prepublishOnly` entry as well, since it runs a `../../scripts/` path that
does not exist once the package is unpacked into someone's `node_modules`. The guard is not lost:
a publish that bypasses the release script never strips, so it still reads the manifest with the
guard in place, and the release path repeats the check itself after stripping.

## Creating a renderer

To instance the engine use the `createSceneRenderer` function:

```ts
import { Rect, createSceneRenderer } from '@mvpaint/engine'

const handle = await createSceneRenderer('#board', { input: 'editor' })
handle.scene.root.addChild(new Rect({ width: 260, height: 140, cornerRadius: 12, fill: 'tomato' }))
```

Both arguments are optional. The first is the render target, the second is the options object.

### Render target

| Argument | Result |
| --- | --- |
| omitted or `null` | a canvas is created over the viewport |
| a canvas element | that canvas is used |
| a selector naming a canvas | that canvas is used |
| a selector naming any other element | a canvas is created inside it, sized by the page's CSS |

### Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `input` | preset, boolean, object or `null` | omitted | Which pointer and keyboard bindings to install. See below. |
| `camera` | `Camera2D` | a default camera | The view the scene is drawn through. |
| `backend` | `'auto' \| 'webgpu' \| 'webgl2'` | `'auto'` | Render path. `'webgl2'` forces the fallback. |
| `powerPreference` | `'high-performance' \| 'low-power'` | `'high-performance'` | Which GPU to request on a multi-GPU machine. |
| `onDeviceError` | `(message: string) => void` | none | Called on asynchronous device errors, which otherwise render as a blank canvas. |

The default camera puts world (0, 0) at the viewport's top-left corner at one world unit per
CSS pixel.

### Input

Input is opt-in and comes in three settings.

| `input` | Listeners | Pointer behaviour |
| --- | --- | --- |
| omitted | none | Static render. Nothing is listened for and nothing is hit-tested. The camera is still movable from code. |
| `'view'` | canvas + keyboard | Drag pans, wheel and pinch zoom about the cursor. Nothing is picked. |
| `'editor'` | canvas + keyboard | Select, drag, resize and rotate through the transformer frame; marquee over empty space; ctrl/space-drag pans. |

`'view'` never runs a hit test, so pointer moves cost nothing regardless of scene size.

The long form turns individual behaviours off, and everything a preset installs stays reachable
through `handle.input`:

```ts
const handle = await createSceneRenderer('#board', {
  input: {
    camera: { zoom: false },     // fixed-scale view that still pans
    objects: { drag: false },    // select and frame, but never move anything
    keyboardTarget: null,        // do not listen for keys on the window
  },
})

handle.input?.select(node)
handle.input?.dispatcher.grabContent = false
```

Applications needing different bindings omit `input` and compose their own from the same public
parts: `SceneInputDispatcher`, `MarqueeTool`, `Transformer`, `panToAnchor`, `zoomToward`.

## The handle

`createSceneRenderer` resolves to a `SceneRendererHandle`. It is the only interface either
render path implements, and it mentions no graphics API.

| Member | Purpose |
| --- | --- |
| `scene` | The scene graph. Content is added after construction: `handle.scene.root.addChild(node)`. |
| `images` | Build a texture — see [Shared resources](#shared-resources). |
| `fonts` | The loaded families, for measuring text. |
| `setMSDFFonts`, `getMSDFFonts` | Load or replace a family's MSDF atlases at any point. |
| `camera`, `setCamera`, `setZoom`, `getZoom` | The view. |
| `path` | `'webgpu'` or `'webgl2'` — which path was taken. |
| `adapter` | Which GPU is drawing, and whether it is a software renderer. |
| `input` | The installed `SceneInput`, or `null` for a static render. |
| `onFrame`, `addFrameListener` | Per-frame callbacks, called with seconds elapsed. |
| `pick`, `nodesInBox`, `localBoundsOf` | Hit testing against real tessellated triangles. |
| `toCanvas`, `toDataURL`, `toBlob` | Offscreen capture. |
| `setCullingEnabled`, `setZSortEnabled`, `setShadowsEnabled`, `setCullMargin` | Debug and profiling switches. |
| `markGeometryDirty`, `markTextGeometryDirty`, `markImageGeometryDirty` | Invalidation. |
| `destroy` | Tear down the renderer and its listeners. |

### Dirty marking

- Changing a transform, colour, gradient or image tint is free. These live in a per-object GPU
  buffer refreshed every frame.
- Changing what a shape *is* — a radius, a point list, a stroke width, a dash pattern — 
  re-tessellates it, and says so on its own. Assign and it appears.
- Changing what an `Image` shows — its texture, crop, fit, tiling, flip, wrap or filter — repacks
  the image lane, and says so on its own too.
- Changing how text is laid out — `align`, `maxWidth`, `lineHeight`, `padding`, `fontFamily`,
  `textPath` — re-shapes it, and says so on its own.
- Adding or removing nodes needs no mark. The visible set is recomputed each frame.
- `shape.markGeometryDirty()` is left for the two cases no setter can see: an array edited in
  place (`points.push(...)` rather than assigning a new list), and a property of your own
  `CustomShape` that its `describe()` reads. `text.markDirty()` is the same for a `textPath`
  object edited rather than replaced.

### Shared resources

A picture, a rasterized SVG and a parsed set of glyph outlines are all built once and handed to
everyone who asks for the same one. `destroy()` releases **one holder**; the resource itself goes
when the last of them lets go.

```ts
const a = await handle.images.load('/logo.png')   // fetched, decoded, uploaded
const b = await handle.images.load('/logo.png')   // the same texture, no work at all
a.destroy()                                        // b is still drawing; nothing is freed
b.destroy()                                        // now it is
```

`load` is keyed by URL and `fromSvg` by the document plus its resolved pixel size, so the same
badge at 24px and at 128px are two textures and asking twice for either is one raster.
`fromSource` and `fromPixels` take an optional trailing `key` to opt in — a bitmap is an object
rather than a name, and nothing can tell two of them apart unless the caller says what makes them
the same picture.

Font data is cached globally rather than per renderer, since outlines and metrics own nothing on
a device: `loadPolygonFonts(urls)` and `loadMsdfAtlases(urls)` deduplicate across remounts,
across renderers and across two scenes wanting the same face.

Hand a resource's lifetime to the scene that built it and it is released with that scene:

```ts
const checker = scene.own(handle.images.fromPixels(pixels, 256, 256, 'checker'))
scene.dispose()   // destroys the tree, then releases everything own()ed
```

The builder is the holder, not the `Image` node — one texture is often drawn by ten of them.
Destroying a renderer disposes its scene.

### Capture

`toCanvas()`, `toDataURL()` and `toBlob()` render the scene again into an offscreen target and
return the pixels. It is a second render, not a canvas copy, so the capture can cover any world
region at any resolution, and the live view is unaffected. Captures use 4x MSAA on both paths.

```ts
const blob = await handle.toBlob({ x: 0, y: 0, width: 1200, height: 800, pixelRatio: 2 })
```

## Scene graph

Nodes carry the transform: position, rotation, scale, skew and offset. Shapes add the paint.
Angles are in **degrees** everywhere an application writes one — `rotation` on a node or a
camera, the marks a rotate drag snaps onto, the sweep of a `ShapeContext` arc.

Two conventions:

- The scene is **y-down**, so a shape extends downward from its origin and `+y` is toward the
  bottom of the viewport, matching Canvas2D, SVG and the coordinates pointer events arrive in.
- A shape's origin is its top-left corner, except radius-defined shapes such as `Circle`, which
  are centred. The origin is also the pivot for rotation and scale. To rotate a rect about its
  own centre, set `offsetX: width / 2, offsetY: height / 2`.

### Nodes and containers

`Node` is the base — id, name, parent link, transform, events. `Container` extends it with
children, and `Group` and `Layer` extend that. `Shape` extends `Node` directly and adds
everything that paints.

Every node carries the same attribute set, drawable or not:
`width`/`height`, `visible`, `opacity`, `zIndex`, `listening`, `preventDefault`, `draggable`,
`dragDistance` and `dragBoundFunc` sit alongside the transform, with `position`, `scale`,
`skew`, `offset`, `size` and `absolutePosition` as compound accessors over the components.
`globalCompositeOperation`, `transformsEnabled` and `filters` are not implemented — see
`ARCHITECTURE.md` for what each would take.

- **`Group`** behaves as a single unit: it places its contents, measures itself against them,
  hides and fades them together, and a drag inside it moves the whole group.
- **`Layer`** names a slice of the scene and takes it out with `visible = false`. It is not a
  separate canvas and not a draw-order boundary; shapes inside stay individually selectable.

Lifecycle: `node.remove()` detaches a node and leaves it reusable. `node.destroy()` disposes it
and its subtree, dropping listeners and caches. `node.moveTo(parent)` re-parents it, optionally
preserving its on-screen position.

### Events

Events bubble, so a single listener on the root covers a subtree.

```ts
handle.scene.root.on('click', (event) => console.log(event.target.name))
```

Hit testing runs against tessellated triangles rather than bounding boxes, and is skipped when
its result cannot matter — a scene with no hover handler does not hit-test pointer moves, and an
event whose only listeners are on the root resolves `event.target` lazily.

### Stacking order

Every shape takes the next value from a running counter as its `zIndex`, so newly created shapes
land on top with nothing to configure. Ordering is scene-wide and crosses render lanes: shapes,
text and images interleave freely.

```ts
front.zIndex = back.zIndex + 1   // place one shape above another
shape.zIndex = nextZIndex()      // bring an existing shape to the front
shape.zIndex = -1                // send it behind everything
```

## Shapes and paint

`Rect` (with per-corner rounding), `Circle`, `Polyline`, `Path`, `Image`, `CustomShape`,
`Text`, `VectorText`.

**Fills.** Solid colours, plus linear and radial gradients evaluated analytically in the shape's
local space, so a gradient transforms with its shape.

Nothing paints unless it is asked to: `fill` and `stroke` are both absent by default, so a shape
with neither draws no pixels while still being measured, picked and stacked like any other.
`hasFill()` and `hasStroke()` answer whether a shape paints; a stroke needs a colour as well as
a width, so the default `strokeWidth` of 2 outlines nothing on its own. `draggable` is likewise
off until a node opts in.

A colour is written as `[r, g, b, a]` in 0..1 or as a CSS string — hex, `rgb()`, `hsl()`, a
keyword, `transparent`. Reading one back gives the tuple, which is what the shape renders
through; `fillInput`, `strokeInput`, `shadowColorInput` and `tintInput` give back the form it
was written in. Anything that is neither a string nor four finite numbers is refused at
assignment, where it still has a name to report.

Gradient stops take either shape — a list of `{offset, color}`, or one flat array alternating
the two, `[0, 'red', 1, 'blue']`. A gradient holds at most eight.

**Strokes.** Miter, round and bevel joins; butt, round and square caps; a miter limit.

**`strokeAlign`** selects which side of the outline the width occupies: `'center'` (the default,
and the only option Canvas2D and SVG offer), `'inside'` or `'outside'`. It moves geometry, so it
also moves the measurement — a 100×60 rect with a 20-wide stroke measures 120×80 centred, 140×100
outside and 100×60 inside. Everything reading bounds follows: the transformer frame, marquee
selection, the shadow silhouette and culling.

**`strokeScaleEnabled: false`** holds a stroke at its given width however the shape or an
ancestor is scaled. The ribbon is built through the transform rather than divided by a factor,
so it holds under non-uniform scale and skew.

**`opacity`** fades a whole object — fill, stroke, gradient, glyph, texture and shadow — without
modifying its colours. It multiplies with each colour's own alpha and excludes the shape from
the opaque pass. It is every node's, and it multiplies through the chain, so fading a group
fades what is in it; `absoluteOpacity()` is that product. Overlapping children of a faded group
blend against one another, since each object is composited on its own.

**Shadows.** The Canvas2D model (colour, blur, offset, opacity) plus CSS `box-shadow`'s spread.
Blurred silhouettes are baked into a shared atlas keyed on geometry, so moving, rotating or
zooming a shadowed shape re-bakes nothing.

**Colours** accept either form: the `[r, g, b, a]` tuple in 0..1, or a string — `'#f80'`,
`'#ff8800cc'`, `'rgb(255 136 0)'`, `'rgba(255,136,0,0.5)'`, `'hsl(32 100% 50%)'`, `'tomato'`,
`'transparent'`. Strings are converted on assignment and read back as tuples.

### Custom shapes

`CustomShape` is the base class for geometry the engine does not provide. Subclass it and
implement `describe(ctx)`, drawing the outline into a path builder that accepts
`moveTo`/`lineTo`/curves/arcs/`closePath` and produces mesh geometry rather than pixels. The
result is a shape like any other: picked on its real outline, framed by its real bounds, casting
a shadow from its own silhouette, and stacked with everything else. `ctx.style()` gives an
individual run of segments its own colour and thickness.

### Text

Two implementations over one shaper:

- **`MSDFText`** draws through the MSDF atlas. Four vertices per glyph.
- **`VectorText`** tessellates real glyph outlines through the mesh lane, which gives true
  blurred shadows and per-glyph picking.

The shared shaper handles wrapping, alignment including justified, kerning, letter spacing, line
height, baseline shift, padding, RTL and vertical flow, per-run colour or gradient,
underline/strikethrough, highlight, per-letter outline, and text laid along an arbitrary path.

Content is a list of **runs** — segments of one string, styled independently — which is what lets
one node mix weights, sizes and colours. Where a whole string is one style, **`UniformMSDFText`**
and **`UniformVectorText`** put that style on the node instead:

```ts
const label = new UniformMSDFText({ text: 'Hello', fontSize: 18 })
label.fill = 'crimson'          // the glyphs' colour, not an inert Shape field
label.textDecoration = 'underline'
label.padding = 8
```

Every one of those re-shapes the node. They are ordinary `Text` nodes underneath, so wrapping,
curves, picking and the transformer are unchanged — and they carry the one deliberate exception
to "nothing paints unless asked": their `fill` starts opaque black, because text that renders
invisibly is a worse default than text that renders in black. Measuring goes through
`getTextWidth(fonts)` and `measureSize(text, fonts)`, where `fonts` is `SceneResources.msdfFonts`;
the outline class needs no argument, since it already holds its own.

Both read generated assets — a distance-field PNG for one, a polygon atlas of flattened outlines
for the other — so the engine ships no font parser. Its only dependency is `earcut`.

**Fonts are the application's.** Generate atlases from your own font files with
`packages/scripts`, keep them with your other assets, and hand them to the engine:

```ts
createSceneRenderer(canvas, { fonts: MSDF_ATLASES })              // what MSDFText samples
await loadFontFamily('inter', { vector: POLYGON_ATLAS_URLS })     // what VectorText tessellates
new VectorText({ text: 'Hello', fontFamily: 'inter' })
```

**A font reaches the engine by being registered under a name**, and both kinds of text name it
the same way — `fontFamily`. Which kind a node is stays a choice made when it is written; the
family name only says *which typeface*. One parsed at runtime goes in the same place:
`registerFontFamily('dropped-file', { vector: await parseTtf(file) })`, which is how
`@mvpaint/ttf` fits without the engine carrying a parser.

**The engine ships no typeface at all**, so there is nothing to fall back to: a node naming a
family nothing was registered under draws nothing, and says so once in the console. See
[RESOURCES.md](RESOURCES.md).

Two `Text` nodes can be different typefaces: load a named family with
`handle.setMSDFFonts(sources, 'roboto')` and select it per node with `fontFamily`. The full pipeline —
generation, loading, shaping, both render paths, and runtime font switching — is documented in
[FONTS.md](FONTS.md).

### SVG

`loadSvg()` parses a document into `Path` nodes, flattening curves and carrying across fills,
gradients and strokes.

## Render paths

`createSceneRenderer()` uses WebGPU and falls back to a separate WebGL2 implementation only when
WebGPU is unavailable. `handle.path` reports which one is active. `backend: 'webgl2'` forces the
fallback, which is how it is tested on a machine that has WebGPU. The fallback is loaded through
a dynamic import, so a browser with WebGPU never downloads it.

Both paths draw every node type through the same scene graph, picking, z-ordering and 4x MSAA.
They differ in scale: WebGL2 has no storage buffers, so per-object records travel through a
float texture instead, and the fallback targets a lower object count.

The fallback is contained in `src/webgl/` plus one branch in `systems/createSceneRenderer.ts`,
and is intended to be removable without touching the WebGPU path.

### GPU selection

Both paths request the discrete GPU by default, which is not the platform default — browsers
left to choose pick the integrated GPU. `powerPreference: 'low-power'` requests the other.

That is the full extent of the control available. Neither WebGPU nor WebGL lets a page enumerate
or name GPUs, because an exact hardware list is a strong fingerprint. The hint has two settings,
a single-GPU machine ignores it, and a browser already pinned elsewhere overrides it — on
Windows the GPU process follows Windows Graphics Settings and the vendor control panel, and no
page can change that. `chrome://gpu` reports which adapter the browser itself is using.

`handle.adapter` reports what actually came back — vendor, family and the driver's description,
as far as the browser discloses them — and flags a software renderer (SwiftShader, llvmpipe,
WARP), which draws correctly but slowly and otherwise looks like the engine being slow.


## Repository layout

```
packages/engine        the renderer - no demo content, no framework, no font parser
  src/index.ts         the public entry point; needs a bundler (it carries the MSDF atlas)
  src/core.ts          '@mvpaint/engine/core': the same engine minus device and assets,
                       for node, workers, and anything measuring text before a canvas exists
  src/shapes/          Node, Container, Group, Layer, Shape and the concrete shapes
  src/render/          buffer formats, batchers, pipelines, WGSL, draw order
  src/text/            the shaper, the MSDF fallback atlas, and the polygon atlas reader
  src/input/           the pointer dispatcher and the 'view'/'editor' bindings over it
  src/scene/           the scene graph, plus picking, culling and marquee selection
  src/systems/         render-path selection, canvas resolution, sizing, the handle interface
  src/webgpu/          SceneRenderer: the gather, the passes
  src/webgl/           the WebGL2 fallback
packages/scripts       offline tools: font files in, glyph atlases out
  fonts/               the input folder, enumerated - the Inter TTFs live here
  out/                 what they write; gitignored, copied into an app by hand
packages/ttf           opt-in: parse a TTF in the browser, for fonts unknown until runtime
packages/example-app   a React host for the demo scenes; the engine depends on none of it
  src/fonts/           its own copy of the atlases, and the module that loads them
```

Each engine subdirectory carries a Vitest suite covering its pure logic, as do `packages/ttf` and
the polygon generator. The suite runs under plain Node with no GPU and no DOM. Anything requiring
either is verified in a browser.

## Architecture

**[ARCHITECTURE.md](ARCHITECTURE.md)** documents the internals: one frame end to end, the gather,
the buffer formats byte by byte, the four render lanes and the two passes, what happens when each
kind of property changes, and how shadows are baked. Read it before changing the engine.

In short: every shape is tessellated once into shared vertex and index buffers, with its
transform and material in a storage buffer indexed by an id packed into each vertex. Stacking
order comes from a `zIndex` rank injected as the depth value. Four lanes — mesh, text, image and
shadow — share the frame uniforms, the depth buffer and one render pass. The frame is drawn as an
opaque batch, then a back-to-front translucent merge, then the always-on-top overlay.
