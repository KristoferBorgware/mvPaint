---
"@mvpaint/engine": major
---

**Breaking.** Creating a renderer is about a canvas and a device. It no longer knows anything about fonts.

`CreateSceneRendererOptions.fonts` is gone, and so are `handle.setMSDFFonts()` and `handle.getMSDFFonts()`. Atlases now arrive the way outlines always have — by being registered under a name:

```ts
const handle = await createSceneRenderer(canvas)        // first the renderer,
await loadFontFamily('inter', { vector, msdf })         // then the fonts,
buildScene(handle.scene)                                // then the scene
```

`registerFontFamily` and `loadFontFamily` take either half or both, and replace only the halves they name — so a family can gain its atlases long after its outlines. Both return a promise: the outlines are in place synchronously, and awaiting it means every device drawing at the time has its texture uploaded.

### How an atlas gets to a device without the renderer being told

The registry holds atlas SOURCES — metrics and a URL, plain data. A renderer subscribes when it is created (`onFontFamilyRegistered`), catches up on `registeredMsdfFamilies()`, and unsubscribes when it is destroyed. So the two orders both work: a family registered before a device existed is uploaded when the renderer is created, and one registered afterwards arrives through the subscription. Two canvases each build their own texture from the one registration.

### Migrating

| was | is |
| --- | --- |
| `createSceneRenderer(canvas, { fonts })` | `createSceneRenderer(canvas)` then `registerFontFamily(name, { msdf: fonts })` |
| `handle.setMSDFFonts(sources)` | `registerFontFamily(DEFAULT_FONT_FAMILY, { msdf: sources })` |
| `handle.setMSDFFonts(sources, 'roboto')` | `registerFontFamily('roboto', { msdf: sources })` |
| `handle.getMSDFFonts(family)` | `msdfSourcesFor(family)` |

`handle.msdfFonts` is unchanged — it is what shaping and measuring read, and it still belongs to the renderer, because a book holds a texture.
