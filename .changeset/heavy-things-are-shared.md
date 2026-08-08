---
"@mvpaint/engine": major
---

Heavy resources are built once and freed when the last holder lets go.

`images.load(url)` used to fetch, decode and upload on every call, so two nodes wanting the same picture caused two of everything; `images.fromSvg()` re-ran the browser decode and `getImageData` round trip per call. Font data was worse: outlines had no engine-side cache at all, so every application wrote the same memo.

```ts
const a = await images.load('/logo.png')   // fetched, decoded, uploaded
const b = await images.load('/logo.png')   // the same texture, no work at all
a.destroy()                                 // b is still drawing; nothing is freed
b.destroy()                                 // now it is
```

`destroy()` means *release one holder*. A texture built directly has exactly one, so nothing changes for code that was already balancing its own calls — what changes is that a texture two scenes share survives the first of them being torn down.

### What is shared, and where

Two layers, because a `GPUTexture` belongs to a device and cannot be handed to a second renderer while a parsed glyph outline belongs to no device at all.

| | scope | keyed by |
| --- | --- | --- |
| `images.load` | per renderer | the URL |
| `images.fromSvg` | per renderer | the document **and** its resolved pixel size |
| `images.fromSource` / `fromPixels` | per renderer | an explicit `key` argument — otherwise not shared |
| `loadPolygonFonts()` | global | the set of source URLs |
| `loadMsdfAtlases()` | global | each metrics URL |

A bitmap and a pixel buffer are objects rather than names, so nothing can tell two of them apart; both gained a trailing optional `key` to opt in. The debug `label` is deliberately not used for this — a debug string that silently decided which callers shared a texture would be a trap.

Nothing keeps a second CPU copy of what is already on the GPU: the global layer caches the fetch and the parse, and the picture itself is deduplicated at the texture layer.

### Two engine-side loaders replace a memo every application writes

```ts
const book = await loadPolygonFonts([{ style: 'regular', url: '/fonts/inter-regular.polygons.json' }, ...])
const { sources } = await loadMsdfAtlases([{ style: 'regular', metricsUrl: '…json', imageUrl: '…png' }, ...])
```

Both dedupe across remounts, across renderers, and across two scenes wanting the same face. `packages/example-app/src/fonts/index.ts` shows the shape it leaves behind: addresses, and nothing else.

### Unloading with a scene

`Scene` gained `own()` and `dispose()`:

```ts
const checker = scene.own(images.fromPixels(pixels, 256, 256, 'checker'))
// …later
scene.dispose()   // destroys the tree, then releases everything own()ed, last first
```

The scene builder is the holder, because an `Image` node is not — one texture is often drawn by ten of them, and `Shape`'s position that a texture belongs to the application is unchanged. A resource two scenes `own()` survives the first `dispose()`.

**Destroying a renderer now disposes its scene**, so a page that tears one down releases what its scene was holding rather than leaving it on the device.

### Breaking

- `ImageTexture` carries a `lifetime`. A custom implementation of the interface has to supply one (`new SharedLifetime()`) and route `destroy()` through it: `if (!this.lifetime.release()) return`.
- `SceneResources` carries `fonts: FontFamilies` — the provider an `MSDFText` is measured against, which scene-building code previously had no way to reach. Anything constructing a `SceneResources` by hand supplies it; `handle.fonts` is where it comes from.
- `Shape.strokeWidth` is an accessor rather than a plain field, so a subclass can hear the assignment. It stores and nothing more; changing it still needs `markGeometryDirty()`.
