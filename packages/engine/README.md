# @mvpaint/engine

A 2D scene-graph renderer for the browser, built natively for **WebGPU**, with a **WebGL2**
fallback on unsupported devices.

You build a tree of nodes — rectangles, circles, paths, images, text — set their transforms and
paint. The engine tessellates the geometry once, keeps per-object state in GPU buffers, and
draws the scene in a small, fixed number of draw calls per frame.

**[Live examples →](https://kristoferborgware.github.io/mvPaint/)** ·
**[Full documentation →](https://github.com/KristoferBorgware/mvPaint#readme)**

```bash
npm install @mvpaint/engine
```

```ts
import { createSceneRenderer, Circle, Rect } from '@mvpaint/engine'

const handle = await createSceneRenderer({ canvas })

handle.scene.root.addChild(new Rect({ x: 40, y: 40, width: 200, height: 120, fill: '#1f6feb' }))
handle.scene.root.addChild(new Circle({ x: 320, y: 100, radius: 60, fill: '#2ea043' }))

handle.start()
```

`createSceneRenderer` picks WebGPU where it exists and WebGL2 where it does not; the scene you
build is the same either way.

## Two entry points

```ts
import { createSceneRenderer } from '@mvpaint/engine' // everything
import { STYLE_ORDER, resolveStyle } from '@mvpaint/engine/core' // no device, no assets
```

The main entry point carries the fallback MSDF atlas, imported as URLs, so it needs a bundler —
any application build already is one. `@mvpaint/engine/core` is the subset with no device and no
assets in it: geometry, glyph metrics, the style ladder and the outline tessellator. Import that
to shape or measure text under node, in a worker, or before a canvas exists.

## Text

Two implementations, both drawn from atlases generated ahead of time, so nothing here parses a
font at runtime:

- **MSDF text** (`Text`, `TextBlock`) — four vertices per glyph, sampled from a distance field,
  crisp at any zoom. The default.
- **Vector text** (`VectorText`) — real letterform geometry, tessellated from outlines. True
  blurred shadows and per-glyph picking, at the cost of triangles.

**The fonts are yours.** Generate atlases from your own font files with `packages/scripts` in
the repository, then supply them:

```ts
// MSDF: one entry per style, each a metrics JSON and a URL for its PNG.
const handle = await createSceneRenderer(canvas, { fonts: MSDF_ATLASES })

// Outlines: any VectorFonts, per node.
new VectorText({ fonts: new PolygonFontBook(sources), text: 'Hello' })
```

Neither has to be ready before the canvas is, which is what an atlas served from a CDN needs.
`VectorText` takes its outlines per node, so you simply construct the node once they arrive; the
MSDF atlas is shared by every `Text`, so it is swapped on the renderer:

```ts
const handle = await createSceneRenderer(canvas)   // draws with the fallback
await handle.setFonts(await fetchAtlasesFromCdn()) // ...then with yours, text re-shapes
```

The engine fetches each PNG from the `url` you give it, so that field is already a CDN URL. The
metrics are a value rather than a URL because the shaper needs them synchronously to measure a
line — fetch them yourself and pass the parsed JSON.

### More than one family

Name a family when you load it, and name it on the node:

```ts
await handle.setFonts(robotoAtlases, 'roboto')
scene.root.addChild(new Text({ text: 'Heading', fontFamily: 'roboto' }))
scene.root.addChild(new Text({ text: 'Body' }))            // the default family
new VectorText({ fonts: robotoOutlines, text: 'Outlined' }) // outlines are handed over directly
```

Family is a **node-level** choice — a paragraph is one face, and mixing families between runs
inside a node is not supported. A name that is not loaded draws in the default family rather
than failing, so a node built while its atlas is still in flight shows text now and switches
over when it arrives.

Each family is one array texture, so the text lane issues one draw per family *change* along
the packed order. A scene in a single family costs exactly what it did before, and a paragraph
mixing all four styles is still a single draw.

This package ships **no typeface at all**. Omit `fonts` and the renderer starts with no atlases:
nothing is fetched, no texture is uploaded, and `Text` draws nothing until you call
`setFonts()`. A scene of rectangles issues no font request at all. A set you supply may be
partial: give it bold alone and the style ladder synthesizes the rest. Outlines work the same
way — `VectorText` is always given its own.

Generate atlases with [`@mvpaint/scripts`](https://github.com/KristoferBorgware/mvPaint/tree/master/packages/scripts)
and serve them as your application's assets.
[`packages/example-app`](https://github.com/KristoferBorgware/mvPaint/tree/master/packages/example-app)
is a working example: its Inter set lives in `public/fonts/` and is fetched at runtime, so the
atlases can be swapped without rebuilding.

For a font the application has never seen — one the user drops in, or a document that names its
own typeface — add [`@mvpaint/ttf`](https://www.npmjs.com/package/@mvpaint/ttf), which parses a
real file at runtime and satisfies the same `VectorFonts` interface. Applications that never
import it never download a font parser.

## Requirements

A browser with WebGPU or WebGL2, and an ES module bundler. The package ships ES modules and
type declarations, and no CommonJS build.

## Licence

MIT — see [LICENSE](./LICENSE).

That is the whole of it: this package contains no font data, so no font licence applies to
anything it ships. Whatever typeface you generate atlases from carries its own terms, and they
are between you and that typeface — this repository's own Inter set, and the SIL Open Font
Licence that travels with it, lives with the example app under `public/fonts/`.
