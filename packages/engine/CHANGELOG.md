# @mvpaint/engine

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
