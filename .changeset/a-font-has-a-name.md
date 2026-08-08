---
"@mvpaint/engine": major
---

**Breaking.** A font reaches the engine by being registered under a name, and both kinds of text name it the same way.

`VectorText` used to be handed a book — `new VectorText({ fonts: myPolygonFontBook })` — while `MSDFText` named a family. Two mechanisms for one question, and the object form meant every scene threaded a book through its own `prepare()` hook and every application wrote its own memo around the fetch.

```ts
await loadFontFamily('inter', { vector: POLYGON_ATLAS_URLS })

new MSDFText({ text: 'Hello', fontFamily: 'inter' })    // atlas glyphs
new VectorText({ text: 'Hello', fontFamily: 'inter' })  // outline glyphs
```

`fontFamily` now lives on `Text`, so it is one attribute for both. Which kind a node is stays a **choice made when it is written** — one samples a distance field, the other tessellates real contours, and they have different strengths. Two kinds in one scene naming one family is the ordinary case.

A font parsed at runtime goes to the same place, which is why there is no escape hatch:

```ts
registerFontFamily('dropped-file', { vector: await TtfFontBook.load(…) })
new VectorText({ text, fontFamily: 'dropped-file' })
```

### There is no fallback face

The engine ships **no typeface**. A node naming a family nothing was registered under draws **nothing**, and writes one `console.warn` naming the family — once per name, not once per frame, since the gather runs every frame and a per-frame warning makes a log useless.

This replaces a fallback that could not work: an unresolved name previously resolved to the "default" family, which is empty unless the application loaded into it. Where an application had loaded one, a typo silently drew in the wrong face; where it had not, the text vanished with no explanation. Now it says so.

`DEFAULT_FONT_FAMILY` survives as the name a node gets when it chooses none. It is not a fallback.

### Migrating

| was | is |
| --- | --- |
| `new VectorText({ fonts: book })` | `registerFontFamily('name', { vector: book })`, then `fontFamily: 'name'` |
| `new PolygonFontBook(sources)` per app | `loadFontFamily('name', { vector: urls })` — fetch, parse and register, deduplicated |
| `vectorText.fonts = otherBook` | `vectorText.fontFamily = 'other-name'` |

`VectorText.fonts` remains as a **read-only** getter resolving the current family, or `undefined`. `VectorTextOptions` no longer has a `fonts` member, and `MSDFTextOptions` is now just `TextOptions`.

### Also

Several places claimed the engine bundles an Inter MSDF atlas "so text draws out of the box". It does not, and has not: there is no `?url` PNG import in `packages/engine/src`, and a renderer built without `fonts` holds an empty book. The claim is corrected in `README.md`, `index.ts`, `core.ts`, `text/layout.ts`, `packages/ttf/README.md` — and in `LICENSE`, which declared redistribution of a font at `packages/engine/src/text/fonts`, a path that does not exist.

New: [RESOURCES.md](../RESOURCES.md) documents how fonts and pictures are shared, and what the cache holds.
