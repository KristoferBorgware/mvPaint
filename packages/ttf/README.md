# @mvpaint/ttf

Vector glyphs from a font **file**, at runtime — the opt-in half of mvPaint's vector text path.

```ts
import { VectorText, createSceneRenderer } from '@mvpaint/engine'
import { TtfFontBook } from '@mvpaint/ttf'

const fonts = await TtfFontBook.load([
  { style: 'regular', data: await file.arrayBuffer() },
  { style: 'bold', data: await boldFile.arrayBuffer() },
])

handle.scene.root.addChild(new VectorText({ fonts, text: 'Hello', style: { fontSize: 48 } }))
```

## When you want this, and when you do not

`VectorText` normally draws from a **polygon atlas**: glyph outlines flattened once, offline
(`@mvpaint/fontgen`), and supplied by the application as data. That is the right default for any
application whose fonts are known when it is built — it needs no parser at all, and the atlas is
a fraction of the size of the font it came from. The engine ships neither, and no typeface of
any kind.

This package is for the case an atlas cannot cover: a font the application has never seen. A
file the user just dropped in, a font picker over a directory, a document that names its own
typeface. Then you need to read the real thing, and `opentype.js` (a quarter of a megabyte) is
the price.

Keeping that price outside the engine is the entire point of the split. An application that
never imports this package never downloads a parser; one that does, downloads it lazily — the
parser is behind a dynamic `import()`, so it arrives when the first font is parsed rather than
on page load.

## What it gives you

`TtfFontBook` satisfies the engine's `VectorFonts` interface, so a `VectorText` cannot tell the
difference between it and a polygon atlas: the same shaper, the same faux bold/italic ladder,
the same per-glyph picking and real blurred shadows.

Two things do differ, both in this package's favour and both because a parser has the whole
file:

- **Any character the font has**, not just the charset an atlas was generated for.
- **Measured on demand** — `ensure()` resolves exactly the code points and kerning pairs a
  piece of text uses, rather than everything up front.

`TtfFont` also exposes `contours()`, `hasGlyph()` and `kerning()`, which is what the offline
polygon-atlas generator is built on: the atlas and a live parse run the same extraction, so
they produce the same letterforms rather than merely similar ones. The self-tests here check
that against the committed atlas.

```bash
npm test    # parser, outline extraction, and the atlas comparison — node, no GPU
```
