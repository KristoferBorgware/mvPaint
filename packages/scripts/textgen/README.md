# @mvpaint/scripts/textgen

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
`.ttf`, `.otf` or `.woff2` in and the next run generates atlases for it; take one out and it
stops. A `.woff2` is unpacked to the sfnt inside it in memory, so a face works the same whichever
container it arrives in.

**A file says which face it is.** The family comes from the font's `name` table and the style
from `head.macStyle`, so `Poppins-700-italic-latin.woff2` and `Poppins-BoldItalic.ttf` both come
out as `poppins-bold-italic`. Filenames are only ever used to report which file something came
from. A font whose family name carries a weight word names itself that way: `Quicksand Light`
becomes `quicksand-light-regular`.

**Files that agree on family and style are one face.** Subset files — a `latin` slice beside a
`latin-ext` one — collect into one atlas. The file covering most of the charset goes first and
supplies the metrics, ties going to the weight nearest the style's own; the rest fill in what it
lacks, and a file that adds nothing is named in a line the run prints. See
[FONTS.md](../../FONTS.md#1-source-fonts) for the full ordering.

What the folder holds is a developer's choice, not the tools'. Four Inter faces are committed,
with their licence beside them: the self-tests parse them and the example app's atlases are
generated from them, so a fresh clone can run the tests and the dev server. Everything else
dropped in is gitignored — a local library to generate from, not part of the repository.

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
draws no text until it calls `setMSDFFonts()`. The example app's copy is the only Inter in this
repository, and it is an application's asset like any other — served from `public/`, fetched at
runtime, swappable without a rebuild.

## Why they are out here

Both tools need a font parser and one of them needs an SDF generator — together a good deal
more code than the renderer itself. Keeping them in the engine package meant every application
that installed the engine installed a build-time toolchain it would never call, and made it
easy for a runtime module to reach for a parser that was, after all, right there. Out here they
cannot be imported by accident, and the engine's dependency list is `earcut` and `svgpath`.

## msdf

`genMsdfAtlas.ts` packs a distance-field glyph atlas per face: one PNG plus the BMFont-shaped
metrics JSON the shaper reads, with the underline/strikethrough metrics added. This is the
default text path's asset — four vertices per glyph, crisp at any zoom.

The packer takes one font file per call, so a face spread over subset files is packed in several
passes, each one adding its glyphs to the page the last left behind.

## polygon

`genPolygonAtlas.ts` writes each glyph's **outline** instead: closed rings of whole font units,
flattened from the curves once, plus the boxes, advances, kerning pairs and decoration metrics.
That is everything the vector text path needs and nothing else, and it is what let the font
parser leave the engine — the browser now reads geometry rather than computing it.

The extraction is `@mvpaint/ttf`'s, the same code that package uses to parse a font at runtime,
so an atlas glyph and a live-parsed one are identical geometry. The self-test checks exactly
that, and — since `out/` is transient — that the atlases the example app has copied in are the
ones this tool produces today. Change the fonts or the charset without re-copying and it says
so.

## The charset

Both tools take the same set, from `charset.ts`, deliberately: a scene that switches
between the two text paths should not find different characters missing. It is also the set a
face's files are each asked to draw part of, so widening it is what makes a subset file
contribute.

```bash
npm run gen:fonts                             # the default: latin1, 191 code points
npm run gen:fonts -- --charset ascii          # ascii | latin1 | latin
npm run gen:fonts -- --charset U+0020-007E,U+00C0-00FF
npm run gen:fonts -- --charset @chars.txt     # the characters in a UTF-8 file
```

The default is `latin1` — ASCII plus the Latin-1 Supplement, so `å ä ö`, `æ ø` and `é ü ñ ç ß`
are letters the atlases carry rather than gaps. It is also what the example app's committed
atlases were built with, which the self-test checks by rebuilding them, so **the shipped set is
the constant in `charset.ts` and the flag is for experiments**.

A code point no font in a face has is left out and spaced by the shaper rather than drawn as a
tofu box, so widening the set can only add letters. What it costs is texture: an MSDF page grows
with the set, and it has to stay one page per style, because the layer a glyph samples from is
its style and there is no second page to address. See
[FONTS.md](../../FONTS.md#2-atlas-generation) for the ceiling and what it holds.
