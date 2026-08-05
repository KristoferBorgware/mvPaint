---
"@mvpaint/engine": minor
---

The engine no longer ships a font. Four Inter MSDF atlases — the PNGs and their metrics JSON — were bundled as a fallback for applications that had not chosen a typeface; they are gone, along with `MSDF_ATLAS_SOURCES`, `STYLE_JSON` and `ATLAS_LAYER_SIZE`. An atlas is an application's asset, exactly as glyph outlines have always been, and half a megabyte of somebody else's typeface has no business in the tarball of an application that supplies its own.

**`fonts` omitted now means no atlases**, where it used to mean Inter. The renderer starts with an empty font book: nothing is fetched, no texture is uploaded, and `Text` draws nothing until `setFonts()` supplies a set. A scene of rectangles issues no font request at all. Applications already passing `fonts` are unaffected.

**`msdfFontProvider()` requires its `styles` argument.** There is no default set left to measure against, and measuring against metrics you are not drawing with wraps text in the wrong place. Pass the same sources you passed to `createSceneRenderer`.

`atlasLayerSize([])` returns 1x1 rather than `-Infinity`, which is the size of the placeholder texture behind an empty book.

Two things fall out of this. A consumer's bundle no longer carries four unrequested PNGs. And `optimizeDeps: { exclude: ['@mvpaint/engine'] }` is no longer needed on a Vite dev server: that workaround existed because the atlases resolved through `import.meta.url`, which points into `node_modules/.vite/deps/` once the engine is pre-bundled, and the dist now contains no `import.meta.url` and no assets to resolve.

`packages/example-app` serves this repository's Inter set from `public/fonts/`, fetched at runtime — a datasource like any other, and the shape an application's own asset folder takes. The SIL Open Font Licence moved there with the files: the tarball no longer carries `LICENSE-Inter.txt`, because it no longer carries anything that licence covers. MIT is now the whole of this package's licensing.
