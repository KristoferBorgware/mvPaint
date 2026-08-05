# @mvpaint/engine

## 1.0.0

### Major Changes

- 1eada49: **Breaking.** The text classes are renamed so each says where its glyphs come from.

  | was                | is                |
  | ------------------ | ----------------- |
  | `Text`             | `MSDFText`        |
  | `TextOptions`      | `MSDFTextOptions` |
  | `TextBlock`        | `Text`            |
  | `TextBlockOptions` | `TextOptions`     |

  `MSDFText` samples a distance-field atlas and `VectorText` tessellates real outlines, so the pair now reads as the choice it is. `Text` is the abstract base both extend — the runs, the block layout options and the shaping-invalidation protocol — and naming it `Text` puts the plain word on the shared idea rather than on one of the two implementations.

  To migrate: `Text` becomes `MSDFText` at every construction site, and any code naming `TextBlock` as a base or a parameter type becomes `Text`. `TextOptions` changes meaning rather than disappearing — it is the base options interface now, and the MSDF one is `MSDFTextOptions`.

  Selectors move with the class, since `nodeName` is the concrete class name: `find('Text')` matched the MSDF node and now matches nothing, `find('MSDFText')` matches it. `nodeType` is unchanged at `'Shape'` for both.

  No behaviour changes.

### Minor Changes

- 61c0880: The engine no longer ships a font. Four Inter MSDF atlases — the PNGs and their metrics JSON — were bundled as a fallback for applications that had not chosen a typeface; they are gone, along with `MSDF_ATLAS_SOURCES`, `STYLE_JSON` and `ATLAS_LAYER_SIZE`. An atlas is an application's asset, exactly as glyph outlines have always been, and half a megabyte of somebody else's typeface has no business in the tarball of an application that supplies its own.

  **`fonts` omitted now means no atlases**, where it used to mean Inter. The renderer starts with an empty font book: nothing is fetched, no texture is uploaded, and `Text` draws nothing until `setFonts()` supplies a set. A scene of rectangles issues no font request at all. Applications already passing `fonts` are unaffected.

  **`msdfFontProvider()` requires its `styles` argument.** There is no default set left to measure against, and measuring against metrics you are not drawing with wraps text in the wrong place. Pass the same sources you passed to `createSceneRenderer`.

  `atlasLayerSize([])` returns 1x1 rather than `-Infinity`, which is the size of the placeholder texture behind an empty book.

  Two things fall out of this. A consumer's bundle no longer carries four unrequested PNGs. And `optimizeDeps: { exclude: ['@mvpaint/engine'] }` is no longer needed on a Vite dev server: that workaround existed because the atlases resolved through `import.meta.url`, which points into `node_modules/.vite/deps/` once the engine is pre-bundled, and the dist now contains no `import.meta.url` and no assets to resolve.

  `packages/example-app` serves this repository's Inter set from `public/fonts/`, fetched at runtime — a datasource like any other, and the shape an application's own asset folder takes. The SIL Open Font Licence moved there with the files: the tarball no longer carries `LICENSE-Inter.txt`, because it no longer carries anything that licence covers. MIT is now the whole of this package's licensing.

- 8a441b1: Read SVG path data in-house. `svgpath` was the engine's second runtime dependency and its only CommonJS one; `earcut` is now the only one it has.

  Two new modules cover what it did. `svg/pathData.ts` reads the `d` grammar — the carried-over command letters, the optional separators, the packed arc flags — and hands over absolute movetos, linetos, cubics and quadratics, with the relative forms, the axis shorthands and the smooth shorthands all resolved. `svg/arcToCubic.ts` converts elliptical arcs to cubics. Both are written from the SVG 1.1 specification: section 8.3.9 for the grammar, appendix F.6 for the endpoint-to-centre arc conversion, with section numbers cited against each step.

  Behaviour is held to the library it replaces by a differential test, which keeps `svgpath` as a devDependency and compares flattened contours across the grammar, six transform matrices, three flattening tolerances, and all 287 paths in the example app's tiger and Tux artwork. Agreement is to 1e-9, four orders of magnitude under the default flattening tolerance.

  One deliberate difference. An arc whose endpoints coincide is now omitted, which is what the specification asks for (F.6.2); `svgpath` emits a zero-length lineto, reaching the mesh builder as a contour of two identical points. Nothing else changes.

  Dropping the CommonJS dependency also makes the package loadable with no build step: `earcut` is already ESM, so a browser reaches the whole engine through a two-line import map, with no bundler and no CDN conversion in between.

### Patch Changes

- 9c941ee: Ship `src/` alongside `dist/`, so Go to Definition lands on the real TypeScript. Both packages emit declaration maps, and every one of them names a path under `src/` — following that path from an editor reaches the file it names. The source is where this codebase's documentation lives, so reading it is the point of jumping to it. `@mvpaint/ttf` emits declaration maps for the first time here.

  `src/**/*.test.ts` stays out through a negated pattern in `files`. Nothing in `src/` reaches an application's bundle: `exports` lists only the package entry points and routes each to `dist/`, so `src/` is never in the module graph and occupies disk in `node_modules` only. The engine's tarball goes from 644 kB to 893 kB packed; ttf's adds four files.

- 68d7ba8: Prune down to what an application imports. Two changes together: `sideEffects: false` in both manifests, which tells a bundler a file can be dropped whole when nothing is imported from it, and `preserveModules` in both builds, which emits one file per source module rather than concatenating them into shared chunks. `dist/` now mirrors `src/` in each package, so a bundler prunes at module granularity instead of at chunk granularity.

  Measured with esbuild against the real tarball, ESM and minified:

  | Consumer import                                  | before | after  |
  | ------------------------------------------------ | ------ | ------ |
  | `import { Vector2 } from '@mvpaint/engine'`      | 23 kB  | 1 kB   |
  | `import { Vector2 } from '@mvpaint/engine/core'` | 14 kB  | 1 kB   |
  | `import { Rect }`                                | 58 kB  | 38 kB  |
  | `import * as E`                                  | 273 kB | 283 kB |

  Importing the whole surface grows by 10 kB, because per-module boundaries leave less for a bundler to hoist across. Everything narrower shrinks. What remains behind `Rect` is its own dependency cone — `Node`, `Shape`, the stroke builder and the math types.

  `@mvpaint/ttf` measures the same either way at its current size; it emits three modules so that the property holds as the package grows rather than being noticed later.

  No API change, and no change to what is exported from any entry point. The WebGL2 fallback is still reached through a dynamic import and still lands in its own chunk in a consumer's build.

- 61c0880: Build against Vite 8. The engine's one dynamic import — the WebGL2 fallback in `createSceneRenderer` — made Vite inline its module-preload helper into the published chunk as `const __vitePreload = …`. A consumer bundling that dist sees the same dynamic import and injects the helper again: Vite 6 and 7 notice the existing declaration and skip, Vite 8 does import analysis in Rolldown, which has no such guard, and the build dies with `Identifier '__vitePreload' has already been declared`. Every consumer on Vite 8 hit it and no configuration of theirs avoided it.

  The engine now builds in Vite's **library mode**, which is what it should always have been. Vite gates the helper injection on `!build.lib`, so nothing is generated and the dist carries a bare `import()` for the consumer's bundler to analyse and preload properly. Library mode was previously impossible because it base64-inlines every asset regardless of `assetsInlineLimit`, and the engine bundled four MSDF atlas PNGs; with the fonts gone there is nothing left to inline and the objection with it.

  Being on the library side of that switch also stops Vite substituting `process.env.NODE_ENV`, which would otherwise bake the publishing machine's build mode into every consumer's bundle.

  No API change, and the fallback still loads on demand as its own chunk. `@mvpaint/ttf` was never affected: it has used library mode all along.

## 0.2.2

### Patch Changes

- ecc6967: Publish registry metadata that matches the tarball. 0.2.1 shipped a correct tarball — the `development` export condition was stripped from the packaged `package.json`, so installs resolve to `dist/` — but the metadata npm recorded for it still advertised the condition, because npm builds that metadata from the manifest it reads before `prepack` runs. The strip now happens before `changeset publish` starts, so `npm view @mvpaint/engine exports` agrees with what actually installs.

  The published manifest also no longer carries the repo's internal `prepublishOnly` guard, which referenced a path outside the package.

## 0.2.1

### Patch Changes

- 7b9ac82: Strip the `development` export condition from the published manifest. The condition points at `src/`, which is not part of the tarball, so any consumer whose bundler matched it — Vite matches `development` in dev mode by default — failed with "Failed to resolve entry for package". The condition still drives src-resolution inside the monorepo; `prepack` now removes it from the manifest that lands in the tarball and `postpack` restores the original file.

## 0.2.0

### Minor Changes

- d41382d: Fonts are the application's, and the atlas the engine ships is now only a fallback.

  **MSDF text.** `createSceneRenderer` takes a `fonts` option: an `MsdfAtlasSource` per style —
  the generated metrics JSON plus a URL for its PNG — which `FontBook.load` and `GlFontBook.load`
  now accept as an argument rather than reading a hardwired module. Omit it and you get the Inter
  atlas this package ships, exactly as before, so `Text` still draws with no setup. A supplied set
  may be partial: a style's `STYLE_ORDER` index is its texture array layer, unnamed layers stay
  empty, and the style ladder falls through to whatever is loaded.

  Atlases can also be replaced **after** the renderer exists, so fonts hosted on a CDN need not be
  in hand before the canvas is: `handle.setFonts(sources)` swaps them, `handle.getFonts()` reads
  back what is loaded. Every cached text layout is re-shaped against the new metrics and the text
  lane repacks; pipelines are untouched. It replaces rather than merges — spread `getFonts()` to
  add a style — and a failed fetch rejects with the previous atlases left in place.

  **Multiple font families.** `handle.setFonts(sources, 'roboto')` loads a second typeface
  alongside the default, and `new Text({ fontFamily: 'roboto' })` draws with it — so two `Text`
  nodes in one scene can be different faces. Family is a node-level property, not a per-run one;
  mixing families inside a single node is not supported. A name that is not loaded resolves to the
  default family rather than failing, so a node built while its atlas is still being fetched draws
  now and switches over when it lands.

  Each family is one array texture, so the text lane emits one draw per family _change_ along the
  packed order — a scene in a single family is exactly as cheap as before, and a paragraph mixing
  four styles is still one draw. Changing one node's `fontFamily` re-shapes that node alone.

  `VectorText` already took its outlines per node; its `fonts` is now settable for the same reason.

  Two internal signatures changed with it: the gather, picking, culling and marquee helpers take a
  `FontFamilies` (resolve a family name to a `FontProvider`) where they took a bare `FontProvider`,
  and `MarqueeOptions.fontBook` is now `fonts`.

  `resolveStyle` no longer assumes `regular` is present. Given a set without it, it resolves to the
  first style that is loaded and flags the difference as faux bold/italic, instead of handing back
  an undefined its caller dereferences.

  `msdfFontProvider(styles?)` takes the same styles, so text can be measured against the atlases it
  will actually be rendered with. Called with no argument it still measures against the fallback.

  **Vector text.** The four Inter polygon atlases and `loadDefaultVectorFonts()` are gone from the
  package. `VectorText` has always taken its outlines through the `VectorFonts` interface, and that
  is now the only way they arrive: a `PolygonFontBook` over atlases you ship, or `@mvpaint/ttf` for
  a font not known until runtime. `PolygonFont`, `PolygonFontBook` and the rest of the reader stay
  exported from `@mvpaint/engine/core` — only the data has left, dropping about 200 kB of outlines
  from `dist/assets` for every application, including those that never draw vector text.

  **Migrating.** Replace `loadDefaultVectorFonts()` with a loader over your own atlases; generate
  them with `packages/scripts` in the repository, which enumerates a folder of font files and
  writes both kinds. `packages/example-app/src/fonts/index.ts` is a working example of both halves.
