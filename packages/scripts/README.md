# @mvpaint/scripts

Offline tools: font files in, glyph atlases out. Nothing here ships in an application — these
are run by hand, on a developer's machine.

```bash
npm run gen:msdf       # fonts/ -> out/msdf/      PNG + metrics JSON, per face
npm run gen:polygons   # fonts/ -> out/polygons/  flattened outlines, per face
npm run gen:fonts      # both
npm test               # the polygon generator's self-test
```

## In and out

**Input is the `fonts/` folder, enumerated.** Neither tool holds a list of typefaces. Drop a
font file in and the next run generates atlases for it; take one out and it stops. Name files
`<Family>-<Style>.ttf` (or `.otf`), where `<Style>` is `Regular`, `Bold`, `Italic` or
`BoldItalic` — the four the renderer selects between per text run. Case and separators are
ignored, and a file with no style suffix is taken as Regular. The output basename is
`<family>-<style>`, so `Inter-BoldItalic.ttf` becomes `inter-bold-italic`.

Inter is simply what this repository keeps in the folder, and its licence sits there with it.

**Output is `out/`, and it is gitignored.** Copying what you want from there into your
application is a deliberate step, and that is the point: an atlas is the *application's* asset.
It chooses the faces, the charset and when to pay for them, and regenerating never silently
changes what ships.

```
out/msdf/      -> your app's font folder;  pass them to createSceneRenderer({ fonts })
out/polygons/  -> your app's font folder;  build a PolygonFontBook for VectorText
```

`packages/example-app/public/fonts/` is this repository's copy of exactly that, and
[its index.ts](../example-app/src/fonts/index.ts) is a working example of both halves.

The engine ships **no font at all**. An application that passes no `fonts` gets a renderer that
draws no text until it calls `setFonts()`. The example app's copy is the only Inter in this
repository, and it is an application's asset like any other — served from `public/`, fetched at
runtime, swappable without a rebuild.

## Why they are out here

Both tools need a font parser and one of them needs an SDF generator — together a good deal
more code than the renderer itself. Keeping them in the engine package meant every application
that installed the engine installed a build-time toolchain it would never call, and made it
easy for a runtime module to reach for a parser that was, after all, right there. Out here they
cannot be imported by accident, and the engine's dependency list is `earcut` and `svgpath`.

## text/msdf

`genMsdfAtlas.ts` packs a distance-field glyph atlas per face: one PNG plus the BMFont-shaped
metrics JSON the shaper reads, with the underline/strikethrough metrics added. This is the
default text path's asset — cheap, four vertices per glyph, crisp at any zoom.

## text/polygon

`genPolygonAtlas.ts` writes each glyph's **outline** instead: closed rings of whole font units,
flattened from the curves once, plus the boxes, advances, kerning pairs and decoration metrics.
That is everything the vector text path needs and nothing else, and it is what let the font
parser leave the engine — the browser now reads geometry rather than computing it.

The extraction is `@mvpaint/ttf`'s, the same code that package uses to parse a font at runtime,
so an atlas glyph and a live-parsed one are identical geometry. The self-test checks exactly
that, and — since `out/` is transient — that the atlases the example app has copied in are the
ones this tool produces today. Change the fonts or the charset without re-copying and it says
so.

Both tools take the same charset (printable ASCII) deliberately: a scene that switches between
the two text paths should not find different characters missing.
