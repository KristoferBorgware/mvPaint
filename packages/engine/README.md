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

The main entry point carries the bundled Inter atlases, imported as URLs, so it needs a bundler
— any application build already is one. `@mvpaint/engine/core` is the subset with no device and
no assets in it: geometry, glyph metrics, the style ladder and the outline tessellator. Import
that to shape or measure text under node, in a worker, or before a canvas exists.

## Text

Two implementations, both drawn from atlases generated ahead of time and shipped with the
package, so nothing here parses a font at runtime:

- **MSDF text** (`Text`, `TextBlock`) — four vertices per glyph, sampled from a distance field,
  crisp at any zoom. The default.
- **Vector text** (`VectorText`) — real letterform geometry, tessellated from outlines.

Both cover printable ASCII in Inter Regular, Bold, Italic and Bold Italic. For a font the
application has never seen — one the user drops in, or a document that names its own typeface —
add [`@mvpaint/ttf`](https://www.npmjs.com/package/@mvpaint/ttf), which parses a real file at
runtime and satisfies the same interface. Applications that never import it never download a
font parser.

## Requirements

A browser with WebGPU or WebGL2, and an ES module bundler. The package ships ES modules and
type declarations, and no CommonJS build.

## Licence

MIT — see [LICENSE](./LICENSE).

The bundled glyph atlases in `dist/assets` are generated from the **Inter** typeface, which is
licensed separately under the SIL Open Font License 1.1; that licence travels with them in
[LICENSE-Inter.txt](./LICENSE-Inter.txt) and applies to those files wherever they end up,
including inside an application built on this package.
