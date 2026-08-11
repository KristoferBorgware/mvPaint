# @mvpaint/fontgen

Font files in, glyph atlases out — the offline generator for
[`@mvpaint/engine`](https://github.com/KristoferBorgware/mvPaint/tree/master/packages/engine)'s two
text paths. Nothing here ships in an application: it runs at build time and writes assets your
application then serves.

```bash
npm install --save-dev @mvpaint/fontgen
npx mvpaint-fontgen              # fonts/ -> out/msdf/ and out/polygons/
```

```
out/msdf/      PNG + metrics JSON per face;  pass them to createSceneRenderer({ fonts })
out/polygons/  flattened outlines per face;  build a PolygonFontBook for VectorText
```

## The command

```bash
npx mvpaint-fontgen                      # both kinds of atlas
npx mvpaint-fontgen polygons             # outlines only
npx mvpaint-fontgen msdf                 # distance fields only

  --fonts <dir>      the folder of .ttf/.otf/.woff2 files to read   (default ./fonts)
  --out <dir>        the folder msdf/ and polygons/ are written to  (default ./out)
  --charset <spec>   ascii | latin1 | latin, or U+0020-007E, or @chars.txt
```

Both directories take a path relative to the working directory or an absolute one, and each kind
of atlas gets its own subfolder — `--out ./public/fonts` gives `./public/fonts/msdf/` and
`./public/fonts/polygons/`.

## The API

The command line is a thin wrapper around three functions, and a build pipeline should call them
instead of spawning a process and reading its output back:

```ts
import { relative } from 'node:path'
import { generatePolygonAtlases, resolveCharset } from '@mvpaint/fontgen'

const run = await generatePolygonAtlases({
  fontsDir: 'assets/fonts',
  outDir: 'public/fonts',
  charset: await resolveCharset('latin'),
})

for (const atlas of run.atlases) {
  manifest[atlas.face] = {
    url: `/${relative('public', atlas.path!)}`,
    style: atlas.style,
    bytes: atlas.bytes,
    glyphs: atlas.glyphs,
  }
}
for (const skip of run.skipped) {
  console.warn(`${skip.file} is in no atlas (${skip.reason})`, skip.drawnBy)
}
```

`generateMsdfAtlases` and `generateFontAtlases` take the same options; the last returns both runs
from one reading of the folder. Every run reports the folder it read, the charset it covered, one
entry per atlas — face, family, style, the files it was drawn from, the counts, the document
itself and the path it was written to — and one entry per font file that ended up in no atlas.
Paths in a report are absolute whether the run was given relative directories or not, so a report
still means the same thing wherever it is read.

**Leave out `outDir` and nothing is written**: the atlases come back in the report and the caller
decides where they go.

Nothing prints unless a run is given `log`, which receives the lines the command line shows.

Also exported: `buildMsdfAtlas` and `buildPolygonAtlas` for one face whose bytes you already
have, `readFontFaces` for the folder-to-faces step on its own, and `CHARSETS` / `DEFAULT_CHARSET`
/ `resolveCharset`.

## Installing

`@mvpaint/engine` is a peer dependency: the atlas formats are the engine's own types, so the
version you generate for is the version you have.

**The MSDF packer is an optional peer.** `msdf-bmfont-xml` and the tree it brings with it are
what makes a distance field, and the vector path needs none of it:

```bash
npm install --save-dev msdf-bmfont-xml     # only if you generate MSDF atlases
```

It is imported the first time a face is packed rather than when the package loads, so generating
outlines never touches it. Asking for MSDF without it names the package to install and stops.

## In and out

**Input is a folder of font files, enumerated.** This package holds no list of typefaces. Drop a
`.ttf`, `.otf` or `.woff2` in and the next run generates atlases for it; take one out and it
stops. A `.woff2` is unpacked to the sfnt inside it in memory, so a face works the same whichever
container it arrives in.

**A file says which face it is.** The family comes from the font's `name` table and the style from
`head.macStyle`, so `Poppins-700-italic-latin.woff2` and `Poppins-BoldItalic.ttf` both come out as
`poppins-bold-italic`. Filenames are only ever used to report which file something came from. A
font whose family name carries a weight word names itself that way: `Quicksand Light` becomes
`quicksand-light-regular`.

**Files that agree on family and style are one face.** Subset files — a `latin` slice beside a
`latin-ext` one — collect into one atlas. The file covering most of the charset goes first and
supplies the metrics, ties going to the weight nearest the style's own; the rest fill in what it
lacks, and a file that adds nothing is reported in `skipped` with the file that took its place.
See [FONTS.md](https://github.com/KristoferBorgware/mvPaint/blob/master/FONTS.md#1-source-fonts)
for the full ordering.

**Copying the output into your application is a deliberate step**, and that is the point: an atlas
is the *application's* asset. It chooses the faces, the charset and when to generate them, and
regenerating never silently changes what ships. Pointing `--out` at the folder your application
serves from is the same decision, made once.

## The charset

Both kinds of atlas take the same set, deliberately: a scene that switches a node between the two
text paths should not find different characters missing. It is also the set each of a face's files
is asked to draw part of, so widening it is what makes a subset file contribute.

```bash
npx mvpaint-fontgen --charset ascii          # ascii | latin1 | latin
npx mvpaint-fontgen --charset U+0020-007E,U+00C0-00FF
npx mvpaint-fontgen --charset @chars.txt     # the characters in a UTF-8 file
```

The default is `latin1` — ASCII plus the Latin-1 Supplement, so `å ä ö`, `æ ø` and `é ü ñ ç ß` are
letters the atlases carry rather than gaps.

A code point no font in a face has is left out and spaced by the shaper rather than drawn as a tofu
box, so widening the set can only add letters. What it costs is texture: an MSDF page grows with
the set, and it has to stay one page per style, because the layer a glyph samples from is its style
and there is no second page to address. See
[FONTS.md](https://github.com/KristoferBorgware/mvPaint/blob/master/FONTS.md#2-atlas-generation)
for the ceiling and what it holds.

## msdf

`msdfAtlas.ts` packs a distance-field glyph atlas per face: one PNG plus the BMFont-shaped metrics
JSON the shaper reads, with the underline/strikethrough metrics added. This is the default text
path's asset — four vertices per glyph, crisp at any zoom.

The packer takes one font file per call, so a face spread over subset files is packed in several
passes, each one adding its glyphs to the page the last left behind.

## polygon

`polygonAtlas.ts` writes each glyph's **outline** instead: closed rings of whole font units,
flattened from the curves once, plus the boxes, advances, kerning pairs and decoration metrics.
That is everything the vector text path needs and nothing else, and it is what let the font parser
leave the engine — the browser reads geometry rather than computing it.

The extraction is [`@mvpaint/ttf`](https://github.com/KristoferBorgware/mvPaint/tree/master/packages/ttf)'s,
the same code that package uses to parse a font at runtime, so an atlas glyph and a live-parsed one
are identical geometry. The self-test checks exactly that.

## Why it is not in the engine

Both generators need a font parser and one needs an SDF generator — together a good deal more code
than the renderer itself. In the engine package, every application that installed the engine
installed a build-time toolchain it would never call, and a runtime module could reach for a parser
that was, after all, right there. Out here they cannot be imported by accident, and the engine's
dependency list is `earcut`.
