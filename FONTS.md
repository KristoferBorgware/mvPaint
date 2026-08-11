# Fonts

How type gets from a `.ttf` file to pixels, and how the two text paths differ.

File paths are relative to the repository root. For the renderer as a whole see
[ARCHITECTURE.md](ARCHITECTURE.md); for the public API see [README.md](README.md).

## Contents

- [The two paths](#the-two-paths)
- [1. Source fonts](#1-source-fonts)
- [2. Atlas generation](#2-atlas-generation)
- [3. Distribution](#3-distribution)
- [4. Loading](#4-loading)
- [5. Shaping](#5-shaping)
- [6. Rendering](#6-rendering)
- [7. Switching fonts](#7-switching-fonts)
- [8. Invalidation and re-render](#8-invalidation-and-re-render)
- [MSDF vs. vector](#msdf-vs-vector)
- [Reference](#reference)

---

## The two paths

Both draw the same styled runs through the same shaper. They differ in what a glyph *becomes*
after shaping.

| | `MSDFText` | `VectorText` |
| --- | --- | --- |
| Glyph representation | textured quad sampling a distance field | tessellated outline |
| Render lane | text | mesh |
| Cost per glyph | 4 vertices, 2 triangles | hundreds of vertices |
| Asset | MSDF atlas: PNG + metrics JSON | polygon atlas: flattened outlines JSON |
| Supplied by | the renderer, per family name | the node, as an object |
| Engine ships one? | no | no |
| Blurred drop shadow | offset duplicate of the glyphs | real silhouette through the shadow atlas |
| Hit testing | bounding box of the shaped quads | per-glyph, against the real triangles |

Neither path parses a font file at runtime. The engine's only dependency is `earcut`. Runtime
parsing is opt-in through [`@mvpaint/ttf`](packages/ttf).

---

## 1. Source fonts

Font files live in `packages/scripts/textgen/fonts/` as `.ttf`, `.otf` or `.woff2`, or in
whatever directory `--fonts` names. The directory is enumerated — no tool holds a list of
typefaces — so adding a face means dropping a file in.

A `.woff2` is a brotli-compressed sfnt whose `glyf` and `loca` tables are stored re-encoded.
Both generators are handed the TTF/OTF bytes inside it, unpacked in memory by `wawoff2`, so
nothing downstream knows which container a face arrived in.

**The file says which face it is.** A font names its own family in the `name` table and marks
bold and italic in `head.macStyle`, and that is what the generators read — filenames are used
only to report which file something came from:

| Read from | Gives |
| --- | --- |
| `name` ID 16, else ID 1 | the family, lowercased with every run of non-alphanumerics as one dash |
| `head.macStyle` bits 0 and 1, corroborated by `OS/2.fsSelection` bits 5 and 0 | one of `regular`, `bold`, `italic`, `bold-italic` |

So `Poppins-700-italic-latin.woff2` and `Poppins-BoldItalic.ttf` both resolve to
`poppins-bold-italic`. Weight class stays out of the style: a face at semibold usually says so
in its family name rather than in the bold bit, so `Quicksand Light` becomes the family
`quicksand-light` and its atlas is `quicksand-light-regular`. A font that declares no family
name is a hard error rather than a silently skipped face.

**Several files can be one face.** Subset files — a `latin` slice beside a `latin-ext` one —
carry the same family and style and different parts of the character set, so they collect into
one face and one atlas. The first file that has a code point draws it, and the first file also
supplies the face's metrics and its `unitsPerEm` (which the others must match). A file that adds
nothing an earlier one already provides is left out, and the run prints a line naming it and the
file that beat it.

Sources are ordered by, in turn:

1. **How much of the charset each covers** — a whole typeface leads a subset of it.
2. **How near `OS/2.usWeightClass` is to the style's own weight** (400, or 700 for the bold
   pair). A family whose files all give the same typographic family name arrives as several
   weights competing for four slots: Space Grotesk ships 300, 400, 500 and 600 all naming
   themselves `Space Grotesk` Regular, and 400 is the regular of that set.
3. **How many glyphs the file holds**, then **its name**, so the order never depends on the
   order the folder happens to be read in.

Enumeration, identification and grouping live in `packages/scripts/textgen/fontSources.ts`.

---

## 2. Atlas generation

Two generators read the same directory and the same charset, declared once in `textgen/charset.ts`.
Both paths cover identical characters deliberately: switching a node between them must not change
which glyphs are missing. The charset is also what decides how a face is assembled, since it is
the set each of a face's files is asked to draw part of.

```bash
npm run gen:msdf       # -> packages/scripts/textgen/out/msdf/
npm run gen:polygons   # -> packages/scripts/textgen/out/polygons/
npm run gen:fonts      # both, over one charset

npm run gen:fonts -- --charset latin        # a named set
npm run gen:fonts -- --charset U+0020-007E,U+00C0-00FF
npm run gen:fonts -- --charset @chars.txt   # the characters in a UTF-8 file

npm run gen:fonts -- --fonts ./my-fonts     # read that directory instead
npm run gen:fonts -- --out ./public/fonts   # write msdf/ and polygons/ under that one
```

### The directories

`--fonts <dir>` and `--out <dir>` take a path relative to the working directory or an absolute
one; given neither flag a run reads `textgen/fonts/` and writes `textgen/out/`. Each generator
adds its own subfolder to the out directory, so `--out ./public/fonts` gives
`./public/fonts/msdf/` and `./public/fonts/polygons/`. The run prints the directory it read and
the one it wrote.

This is what lets a project outside this repository generate its own atlases without a file of
its own landing in `textgen/`.

### The charset

`--charset` takes a name, explicit code points, or `@path` to a file whose characters are the
set. Given nothing it uses `DEFAULT_CHARSET`, which is the one the committed atlases were built
with — so **the shipped set is the constant in `charset.ts`, and the flag is for experiments**.
Change the constant and the polygon self-test will tell you the app's copies are stale.

| Name | Code points | Covers |
| --- | --- | --- |
| `ascii` | 95 | Printable ASCII, U+0020–U+007E |
| `latin1` **(default)** | 191 | ASCII + Latin-1 Supplement — `å ä ö`, `æ ø`, `é ü ñ ç ß`. Every face in `fonts/` draws all of it |
| `latin` | 388 | `latin1` + Latin Extended-A + punctuation, currency and symbols |

A code point no font in a face has is left out of the atlas and **spaced by the shaper rather
than drawn as a tofu box**, so widening the set is additive — it can only add letters. Coverage
past Latin-1 is a property of the typeface: of the families in `fonts/`, Permanent Marker has 10
of Latin Extended-A's 128 and Poppins 107, so `latin` leaves real holes in Central and Eastern
European text for those faces.

A wider set means a larger page. The MSDF packer shrinks each page to the glyphs it was given —
`ascii` packs to around 300×300, `latin1` to 476×469, `latin` to 661×655 — against a 2048 cap.

### MSDF atlas — `textgen/msdf/genMsdfAtlas.ts`

Wraps `msdf-bmfont-xml`. Per face it emits a PNG and a JSON:

- **`<base>.png`** — a multi-channel signed distance field. Each texel stores three signed
  distances to the nearest edge; the median of the three reconstructs a distance that preserves
  sharp corners, which is what a single-channel field loses.
- **`<base>.json`** — BMFont layout (`chars`, `kernings`, `common`, `distanceField`) plus a
  `decoration` block: underline and strikethrough offset and thickness as em fractions, read
  from the font tables through `@mvpaint/ttf` so both paths place rules identically.

Generation parameters: `fontSize` 42 px, `distanceRange` 4 px, `smartSize` against a 2048×2048
cap. The cap is not a size — `smartSize` shrinks each page to the glyphs it was given, so ASCII
packs to 300×300 whether the cap says 512 or 2048 — and 2048 is WebGL2's guaranteed
`MAX_TEXTURE_SIZE`, so a larger page would work on most machines and fail on the ones that only
promise the minimum. At roughly 1,200 texels a glyph it holds some 3,400 of them.

**The charset must fit one page.** Spilling to a second is an error, because the array layer a
glyph samples from *is* its style: there is no second page to address, and page-1 glyphs would
silently take page-0's texels. Widening past what fits means narrowing the charset or moving
that face to the vector path, which has no such ceiling.

Texture memory is `pageWidth × pageHeight × 4 bytes × 4 layers` per family — four layers are
always allocated, sized to the family's largest style. At `latin1` that is 3.4 MB a family.

The packer takes one font file per call, so a face spread over subset files is packed in several
passes. Each pass after the first is handed the packer state and the page the last one wrote, and
adds its glyphs to both: the page grows to fit, and what is already on it keeps the position it
was packed at.

### Polygon atlas — `textgen/polygon/genPolygonAtlas.ts`

Emits one JSON per face. Per glyph: the outline flattened to closed rings of **integer font
units**, plus box, advance, and — per file — `unitsPerEm`, vertical metrics, the decoration
block, and every non-zero kerning pair over the charset. That pass is quadratic in the charset —
95 characters is 9,025 ordered pairs and 191 is 36,481 — of which a few hundred kern. A pair
whose two glyphs come from different files of the same face has no entry to find: kerning is a
fact one file holds about two glyphs it draws itself.

Coordinates are whole font units. At Inter's 2048 units/em that quantization is 1/2048 em, well
below the curve-flattening tolerance the outline was produced at, and it keeps the file a
fraction of the size the same values would be as floats.

Outline extraction is `@mvpaint/ttf`'s — the same code that parses a font at runtime — so a baked
glyph and a live-parsed one are identical geometry. The self-test in
`packages/scripts/textgen/polygon/polygonAtlas.test.ts` asserts that, and that the committed copies
match what the tool produces today.

### Output is not committed

`packages/scripts/textgen/out/` is gitignored. Copying the atlases you want into your application is a
deliberate step: an atlas is the *application's* asset, and regenerating never silently changes
what ships. `--out` pointed at an application's own font directory writes there instead, which
is the same decision made once on the command line rather than once per file.

---

## 3. Distribution

```
packages/scripts/textgen/fonts/          source .ttf files (generator input)
packages/scripts/textgen/out/            generated atlases (gitignored)
        ↓ copied by hand
<your app>/fonts/msdf/           PNG + JSON per style
<your app>/fonts/polygons/       outlines JSON per style
```

The engine bundles no font of either kind. `MSDFText` draws once `fonts` supplies atlases, and
`VectorText` is always given its outlines.

`packages/example-app` is a working example of the application side: the atlases live in
`public/fonts/` and `src/fonts/index.ts` is the loader module.

---

## 4. Loading

### MSDF

An `MsdfAtlasSource` is `{ style, url, json }`: the style it represents, a URL the engine fetches
the PNG from, and the parsed metrics. The metrics are a value rather than a URL because the
shaper needs them synchronously to measure a line; the image is a URL because it is a quarter of
a megabyte that belongs out of the JS bundle. Both fields accept absolute URLs, so a CDN-hosted
atlas needs no special handling.

```ts
await loadFontFamily('inter', { msdf: interAtlases })
```

Registering nothing loads no atlases at all, and `MSDFText` draws nothing until a family it names
is registered. A set may be **partial**: a style's index in
`STYLE_ORDER` *is* its texture array layer, so unsupplied styles leave their layers zeroed and
the style ladder resolves through whatever is present.

`MSDFFontBook.load` fetches each PNG, decodes it with `createImageBitmap({ colorSpaceConversion:
'none' })` — MSDF channels are distances, not sRGB color, and any conversion corrupts them — and
uploads it to its layer of a single `texture_2d_array`. Array layers share one size, so each
image is copied into the top-left of a layer sized for the largest in the set, and
`normalizeMetrics` measures every UV against the *layer* rather than the image.

Families are held by `MSDFFontLibrary` (`GlMSDFFontLibrary` on the WebGL2 path), keyed by name, one
`MSDFFontBook` each. The bind group layout and sampler are created once and shared by every book,
because the text pipeline is built from that layout.

### Vector

Outlines own no GPU resource, so there is nothing to upload and no device involved:

```ts
await loadFontFamily('inter', { vector: POLYGON_ATLAS_URLS })
new VectorText({ fontFamily: 'inter', text: 'Hello' })
```

`PolygonFontBook` implements `VectorFonts`, which is also what `TtfFontBook` from
`@mvpaint/ttf` implements — so a node cannot tell a baked atlas from a font parsed in the
browser. A book built any other way joins the same registry under a name of its own:

```ts
const book = await TtfFontBook.load([{ style: 'regular', data: await file.arrayBuffer() }])
registerFontFamily('dropped-file', { vector: book })
```

Fetching is entirely the application's business and can happen at any time; the registry is what
a node reads, so a family registered late is picked up on the next shape.

---

## 5. Shaping

`text/layout.ts` is the shaper for both paths. `layoutText(runs, options, fonts)` returns a
`ShapedText`: positioned quads, per-run materials, and block metrics.

Per run it resolves a style through the ladder in `resolveStyle`: exact style, then the nearest
that preserves whichever of bold/italic was requested, then regular, then the first style that is
loaded at all. Anything it had to substitute comes back flagged as `fauxBold` or `fauxItalic`,
which the renderer synthesizes — distance dilation for weight, horizontal shear for slant.

The shaper then applies kerning, letter spacing and baseline shift, greedily wraps to an optional
`maxWidth`, breaks on `\n`, aligns each line (left/center/right/justify), and emits quads
back-to-front: highlight backgrounds, drop shadows, glows, glyph bodies, then underline and
strikethrough. Horizontal text supports LTR and mechanically mirrored RTL; vertical orientation
stacks glyphs in right-to-left columns. `textPath` bends the finished block onto a curve, mapping
each glyph to a position and rotation along it.

Coordinates are the node's local space: +x right, +y up, block top-left at the origin.

Shaping is device-free. `msdfFontProvider(styles?)` builds a `FontProvider` from metrics alone, so
text can be measured before a canvas exists.

---

## 6. Rendering

### `Text` — the text lane

Each shaped quad becomes four vertices:

| Attribute | Format |
| --- | --- |
| `position` | `f32x2` |
| `uv` | `f32x2` |
| `color` | `f32x4` |
| `packedId` | `u32` — object index, top bit `isGlyph` |

36 bytes per vertex. Per-run state lives in a 320-byte object record (`render/textFormat.ts`):
model matrix, depth, opacity, fill or gradient, per-letter `strokeColor`/`strokeWidth`/
`hasStroke`, the atlas `distanceRange`, a coverage `dilate`, and `atlasLayer`. `atlasLayer` is a
property of the run, not the glyph, which is why it sits in the record rather than the vertex.

The fragment shader reconstructs coverage:

```wgsl
let sd = median(msd);                                           // channel median → signed distance
let unitRange = vec2<f32>(obj.distanceRange) / vec2<f32>(textureDimensions(atlasTex));
let screenPxRange = max(0.5 * dot(unitRange, screenTexSize), 1.0);
let screenPxDist = screenPxRange * (sd - 0.5) + obj.dilate * screenPerWorld;
```

`fwidth` on the interpolated UV gives the screen-space footprint of a texel, so the edge is
antialiased in *screen* pixels and stays crisp at any zoom — the distance field is resolution
independent, and only the threshold is resolution dependent. `dilate` offsets the threshold to
widen coverage, which is how faux bold and glow spread are implemented. A second threshold at
`strokeWidth` produces the per-letter outline.

Because every style of a family is a layer of one array texture behind one bind group, a
paragraph mixing regular, bold, italic and bold-italic draws in **one call**. Draw ranges break
only where the *family* changes (`TextBatcher.drawRange`).

MSDF glyph edges are partial-alpha by construction, so `Text` never qualifies for the opaque
pass and always composites back-to-front in the translucent merge.

### `VectorText` — the mesh lane

`buildGeometry` walks the same shaped quads. For each glyph it fetches the outline mesh from the
font, transforms it into place, and emits triangles:

```ts
const mesh = this.fonts.fontByIndex(quad.atlasIndex)?.mesh(quad.codePoint)
const place = (p) => quadCorner(quad, quad.originX + p.x * quad.unitScale, quad.originY + p.y * quad.unitScale)
```

`unitScale` converts font units to world units; `quadCorner` applies the same faux-italic shear
and curve rotation the MSDF path applies to a quad, so an outline shears and bends exactly as its
box does.

`PolygonFont.mesh(codePoint)` triangulates lazily and caches per code point per font: rings are
classified into solids-and-holes and run through earcut, exactly as an SVG path's contours are.
The cache is per font object, so the cost is paid once per glyph per typeface, not per instance.
Non-glyph quads (highlights, rules) become rectangles. A per-letter outline goes through the
shared contour stroker.

Everything downstream then treats the node as ordinary mesh geometry: it picks against real
triangles, bounds from them, casts a blurred shadow baked from the letterforms, and takes the
mesh lane's gradient implementation rather than a second one. Per-run styling survives because a
shape may claim several material records — one per distinct paint.

---

## 7. Switching fonts

### Per node

```ts
new MSDFText({ text: 'Heading', fontFamily: 'roboto' })   // atlas glyphs
new VectorText({ text: 'Heading', fontFamily: 'roboto' }) // outline glyphs
node.fontFamily = 'inter'
```

Family is a **node-level** property, and one name for both kinds. Mixing families between runs
inside one node is not supported. Where the two differ is only in where the name is looked up:
MSDF atlases are GPU resources shared by every `Text`, so the renderer's `MSDFFontLibrary` holds
them, while outlines own no GPU resource and sit in the global registry any node can read
synchronously.

A `fontFamily` naming a family nothing was registered under draws **nothing**, and the engine
writes one `console.warn` naming it — once per name, not once per frame. There is no fallback
face, because the engine ships no typeface to fall back to.

### Loading and replacing

```ts
await registerFontFamily(DEFAULT_FONT_FAMILY, { msdf: sources })   // replace the default family
await registerFontFamily('roboto', { msdf: sources })              // load or replace a named one
msdfSourcesFor('roboto')                                           // what that family holds
```

No renderer appears in any of those, and none has to exist yet: the registry holds the sources
and every renderer builds its own texture from them, whether it was created before the
registration or after it (see `onFontFamilyRegistered`). Awaiting the call means every renderer
drawing at the time has the atlas uploaded.

Registering replaces within a family rather than merging, so an application never ends up half its
own typeface and half the fallback; spread `msdfSourcesFor()` to add a style. The atlas is rebuilt
whole — a new set may want a different layer size, and a style dropped from the set has to stop
resolving — and the swap is atomic: a failed fetch rejects and leaves the previous atlases
drawing.

Pipelines are untouched. The bind group layout describes the *shape* of the binding, which every
atlas set shares, so only the texture and bind group behind it change.

### Draw cost

One draw call per family **change** along the packed node order — not per family, and not per
node. A single-family scene costs exactly what it did before; alternating families node by node
pays a bind and a draw at each switch.

---

## 8. Invalidation and re-render

Three global counters in `shapes/contentEpoch.ts` answer three questions. Each is a counter
rather than a per-node flag, so the renderer compares one integer per frame however large the
visible set.

| Counter | Bumped by | Effect |
| --- | --- | --- |
| Mesh geometry epoch | `Shape.markGeometryDirty()` | repack the mesh lane |
| Text shaping epoch | `Text.invalidateShaping()` | repack the text lane |
| Font epoch | a family's atlases replaced, or a new family loaded | drop **every** cached text layout |

**A lane repack is not a re-shape.** `TextBatcher.rebuild` calls `text.shaped(book)` per node and
gets the memoized layout back; only nodes whose own cache was dropped actually re-shape. This is
what makes the routes below differ so much in cost.

| Change | Route | Re-shapes |
| --- | --- | --- |
| One node's runs, layout options, `fontFamily`, or `fonts` | `invalidateShaping()` | that node only |
| A family's atlases replaced, or a family added | font epoch | every text node |

`Text.shaped()` memoizes and ignores the `FontProvider` it is handed once cached, which is right
for the usual case and wrong the moment metrics change underneath it — hence the font epoch,
which the cache is keyed on. Bumping the text shaping epoch alone would repack the lane from
exactly those stale layouts.

Loading a *new* family uses the font epoch even though only nodes naming that family are affected.
That is knowingly over-broad: it is a rare, deliberate operation, and the alternative is
interrogating every node's family on every access.

Transforms invalidate nothing on either path. A node's model matrix is re-uploaded each frame
from its object record, so moving, scaling or rotating text never re-shapes and never repacks.

### What forces a re-shape, per path

`Text` repacks on nearly every content change, because **the layout is the geometry**: the string
and runs, `fontStyle`, `fontSize`, `letterSpacing`, `baselineShift`, `align`, `maxWidth`,
`lineHeight`, `direction`, `orientation`, `textPath`, decorations, shadow and glow (each adds
quads), faux italic (sheared into the corners), and `color` (packed per vertex). Free: the
transform, `zIndex`, gradient parameters, `strokeColor`, `strokeWidth`, `distanceRange`, `dilate`.

`VectorText` has the same property for the same reason, and additionally re-tessellates, since its
triangles are derived from the shaping.

Two properties invert between the paths:

| | `MSDFText` | `VectorText` |
| --- | --- | --- |
| `strokeWidth` | free — a shader threshold | repacks — the stroker emits triangles |
| fill color | repacks — packed per vertex | free — `fillColor` in the object record |

---

## MSDF vs. vector

**Use `Text` by default.** Four vertices per glyph, one draw call per family, crisp at any zoom,
and a page of body copy costs almost nothing. Its limits: glyph edges are always partial alpha so
it never enters the opaque pass, hit testing is per bounding box, and a drop shadow is an offset
duplicate of the glyphs rather than a true blur.

**Use `VectorText` for display type** — headings, logotypes, anything large or few. It buys real
geometry: per-glyph hit testing, a genuine blurred shadow baked from the letterforms, and the
mesh lane's gradients. It costs triangles, so a page of body copy is tens of thousands of them.

Both are limited to the charset their atlas was generated for; a code point outside it is spaced
rather than drawn. For text whose font is unknown until runtime — a user upload, a font picker, a
document naming its own typeface — `@mvpaint/ttf` parses a real file in the browser and satisfies
the same `VectorFonts` interface, at the cost of a parser in the bundle.

---

## Reference

### Key modules

| Concern | Files |
| --- | --- |
| Source enumeration, face identity, woff2 unpacking | `packages/scripts/textgen/fontSources.ts` |
| The charset both atlases cover | `packages/scripts/textgen/charset.ts` |
| Generators | `packages/scripts/textgen/msdf/`, `packages/scripts/textgen/polygon/` |
| Shaper | `packages/engine/src/text/layout.ts` |
| MSDF metrics, style ladder | `packages/engine/src/text/msdfMetrics.ts`, `msdfProvider.ts` |
| Outline atlas reader | `packages/engine/src/text/PolygonFont.ts` |
| Outline interface, tessellation | `packages/engine/src/text/vectorGlyphs.ts` |
| GPU atlases and families | `packages/engine/src/webgpu/MSDFFontBook.ts`, `MSDFFontLibrary.ts` (+ `Gl*` equivalents) |
| Packing and draw ranges | `packages/engine/src/webgpu/lanes/TextBatcher.ts` |
| Record layouts | `packages/engine/src/render/textFormat.ts`, `meshFormat.ts` |
| Runtime parsing | `packages/ttf/` |

### Constants

| | Value |
| --- | --- |
| Charset | `latin1` (191 code points), both generators; `--charset` overrides |
| MSDF generation size | 42 px |
| MSDF distance range | 4 px |
| MSDF page cap | 2048×2048, one page per style (476×469 at `latin1`) |
| Styles per family | 4 — `regular`, `bold`, `italic`, `bold-italic` (`STYLE_ORDER`) |
| Text vertex stride | 36 bytes |
| Text object record | 320 bytes |
| Polygon coordinates | integer font units |
