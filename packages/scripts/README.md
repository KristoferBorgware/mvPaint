# @mvpaint/scripts

Offline tools. Nothing here ships in an application — these are run by hand, on a developer's
machine, and what they write is committed.

```bash
npm run gen:msdf       # font files -> MSDF atlas PNG + metrics JSON, per style
npm run gen:polygons   # font files -> polygon atlas JSON, per style
npm run gen:fonts      # both
npm test               # the polygon generator's self-test
```

Input is `fonts/` (the Inter TTFs and their licence). Output is
`packages/engine/src/text/fonts/`, where the engine imports it.

## Why they are out here

Both tools need a font parser and one of them needs an SDF generator — together a good deal
more code than the renderer itself. Keeping them in the engine package meant every application
that installed the engine installed a build-time toolchain it would never call, and made it
easy for a runtime module to reach for a parser that was, after all, right there. Out here they
cannot be imported by accident, and the engine's dependency list is `earcut` and `svgpath`.

## text/msdf

`genMsdfAtlas.ts` packs a distance-field glyph atlas per style: one PNG plus the BMFont-shaped
metrics JSON the shaper reads, with the underline/strikethrough metrics added. This is the
default text path's asset — cheap, four vertices per glyph, crisp at any zoom.

## text/polygon

`genPolygonAtlas.ts` writes each glyph's **outline** instead: closed rings of whole font units,
flattened from the curves once, plus the boxes, advances, kerning pairs and decoration metrics.
That is everything the vector text path needs and nothing else, and it is what let the font
parser leave the engine — the browser now reads geometry rather than computing it.

The extraction is `@mvpaint/ttf`'s, the same code that package uses to parse a font at runtime,
so an atlas glyph and a live-parsed one are identical geometry. The self-test checks exactly
that, and also that the committed atlases are the ones this tool produces today — regenerate
them and the test tells you if you forgot.

Both tools take the same charset (printable ASCII) deliberately: a scene that switches between
the two text paths should not find different characters missing.
