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

| | `Text` | `VectorText` |
| --- | --- | --- |
| Glyph representation | textured quad sampling a distance field | tessellated outline |
| Render lane | text | mesh |
| Cost per glyph | 4 vertices, 2 triangles | hundreds of vertices |
| Asset | MSDF atlas: PNG + metrics JSON | polygon atlas: flattened outlines JSON |
| Supplied by | the renderer, per family name | the node, as an object |
| Engine ships one? | yes, Inter, as a fallback | no |
| Blurred drop shadow | offset duplicate of the glyphs | real silhouette through the shadow atlas |
| Hit testing | bounding box of the shaped quads | per-glyph, against the real triangles |

Neither path parses a font file at runtime. The engine's dependencies are `earcut` and
`svgpath`. Runtime parsing is opt-in through [`@mvpaint/ttf`](packages/ttf).

---

## 1. Source fonts

Font files live in `packages/scripts/fonts/`. The directory is enumerated — no tool holds a list
of typefaces — so adding a face means dropping a file in.

Files are named `<Family>-<Style>.ttf` (or `.otf`). The style suffix must resolve to one of the
four the renderer selects between; case and separators are ignored, and a file with no suffix is
treated as `Regular`:

| Suffix | Style |
| --- | --- |
| `Regular`, or none | `regular` |
| `Bold` | `bold` |
| `Italic` | `italic` |
| `BoldItalic`, `ItalicBold` | `bold-italic` |

The output basename is `<family>-<style>`, lowercased: `Inter-BoldItalic.ttf` →
`inter-bold-italic`. A file whose style cannot be parsed is a hard error rather than a silently
skipped face. Parsing and enumeration live in `packages/scripts/text/fontSources.ts`.

---

## 2. Atlas generation

Two generators read the same directory and the same charset — **printable ASCII, U+0020–U+007E**.
Both paths cover identical characters deliberately: switching a node between them must not change
which glyphs are missing.

```bash
npm run gen:msdf       # -> packages/scripts/out/msdf/
npm run gen:polygons   # -> packages/scripts/out/polygons/
npm run gen:fonts      # both
```

### MSDF atlas — `text/msdf/genMsdfAtlas.ts`

Wraps `msdf-bmfont-xml`. Per style it emits a PNG and a JSON:

- **`<base>.png`** — a multi-channel signed distance field. Each texel stores three signed
  distances to the nearest edge; the median of the three reconstructs a distance that preserves
  sharp corners, which is what a single-channel field loses.
- **`<base>.json`** — BMFont layout (`chars`, `kernings`, `common`, `distanceField`) plus a
  `decoration` block: underline and strikethrough offset and thickness as em fractions, read
  from the font tables through `@mvpaint/ttf` so both paths place rules identically.

Generation parameters: `fontSize` 42 px, `distanceRange` 4 px, texture 512×512 with `smartSize`.
The charset must fit one page; spilling to a second is an error rather than a silent multi-page
atlas.

### Polygon atlas — `text/polygon/genPolygonAtlas.ts`

Emits one JSON per style. Per glyph: the outline flattened to closed rings of **integer font
units**, plus box, advance, and — per file — `unitsPerEm`, vertical metrics, the decoration
block, and every non-zero kerning pair over the charset (95 characters is 9,025 ordered pairs,
of which a few hundred kern).

Coordinates are whole font units. At Inter's 2048 units/em that quantization is 1/2048 em, well
below the curve-flattening tolerance the outline was produced at, and it keeps the file a
fraction of the size the same values would be as floats.

Outline extraction is `@mvpaint/ttf`'s — the same code that parses a font at runtime — so a baked
glyph and a live-parsed one are identical geometry. The self-test in
`packages/scripts/text/polygon/polygonAtlas.test.ts` asserts that, and that the committed copies
match what the tool produces today.

### Output is not committed

`packages/scripts/out/` is gitignored. Copying the atlases you want into your application is a
deliberate step: an atlas is the *application's* asset, and regenerating never silently changes
what ships.

---

## 3. Distribution

```
packages/scripts/fonts/          source .ttf files (generator input)
packages/scripts/out/            generated atlases (gitignored)
        ↓ copied by hand
<your app>/fonts/msdf/           PNG + JSON per style
<your app>/fonts/polygons/       outlines JSON per style
packages/engine/src/text/fonts/  Inter MSDF only — the fallback the engine ships
```

The engine bundles exactly one asset: the Inter MSDF atlas, so `Text` renders before an
application has chosen a typeface. It is a fallback, not the way to select a font, and there is
no outline equivalent — `VectorText` is always given its outlines.

`packages/example-app/src/fonts/` is a working example of the application side, including the
loader module.

---

## 4. Loading

### MSDF

An `MsdfAtlasSource` is `{ style, url, json }`: the style it represents, a URL the engine fetches
the PNG from, and the parsed metrics. The metrics are a value rather than a URL because the
shaper needs them synchronously to measure a line; the image is a URL because it is a quarter of
a megabyte that belongs out of the JS bundle. Both fields accept absolute URLs, so a CDN-hosted
atlas needs no special handling.

```ts
const handle = await createSceneRenderer(canvas, { fonts: interAtlases })
```

Omitting `fonts` loads the bundled fallback. A set may be **partial**: a style's index in
`STYLE_ORDER` *is* its texture array layer, so unsupplied styles leave their layers zeroed and
the style ladder resolves through whatever is present.

`FontBook.load` fetches each PNG, decodes it with `createImageBitmap({ colorSpaceConversion:
'none' })` — MSDF channels are distances, not sRGB color, and any conversion corrupts them — and
uploads it to its layer of a single `texture_2d_array`. Array layers share one size, so each
image is copied into the top-left of a layer sized for the largest in the set, and
`normalizeMetrics` measures every UV against the *layer* rather than the image.

Families are held by `FontLibrary` (`GlFontLibrary` on the WebGL2 path), keyed by name, one
`FontBook` each. The bind group layout and sampler are created once and shared by every book,
because the text pipeline is built from that layout.

### Vector

Outlines own no GPU resource, so there is nothing to upload and no device involved:

```ts
const book = new PolygonFontBook(sources)   // sources: { style, json }[]
new VectorText({ fonts: book, text: 'Hello' })
```

`PolygonFontBook` implements `VectorFonts`, which is also what `TtfFontBook` from
`@mvpaint/ttf` implements — so a node cannot tell a baked atlas from a font parsed in the
browser. Fetching is entirely the application's business and can happen at any time.

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
new Text({ text: 'Heading', fontFamily: 'roboto' })   // MSDF: a name
node.fontFamily = 'inter'

new VectorText({ fonts: robotoOutlines, text: '…' })  // vector: the object
node.fonts = interOutlines
```

Family is a **node-level** property. Mixing families between runs inside one node is not
supported. The two paths express the same thing differently for a reason: MSDF atlases are GPU
resources shared by every `Text`, so the renderer holds them and a node names one; outlines own
no GPU resource, so the node holds them directly.

A `fontFamily` naming a family that is not loaded resolves to the default rather than failing,
so a node constructed while its atlas is still in flight renders immediately and switches over
when the atlas lands.

### Per renderer

```ts
await handle.setFonts(sources)              // replace the default family
await handle.setFonts(sources, 'roboto')    // load or replace a named family
handle.getFonts('roboto')                   // what that family currently holds
```

`setFonts` replaces within a family rather than merging, so an application never ends up half its
own typeface and half the fallback; spread `getFonts()` to add a style. The atlas is rebuilt
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
| Text shaping epoch | `TextBlock.invalidateShaping()` | repack the text lane |
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

| | `Text` | `VectorText` |
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
| Source enumeration and naming | `packages/scripts/text/fontSources.ts` |
| Generators | `packages/scripts/text/msdf/`, `packages/scripts/text/polygon/` |
| Shaper | `packages/engine/src/text/layout.ts` |
| MSDF metrics, style ladder | `packages/engine/src/text/msdfMetrics.ts`, `msdfProvider.ts` |
| Outline atlas reader | `packages/engine/src/text/PolygonFont.ts` |
| Outline interface, tessellation | `packages/engine/src/text/vectorGlyphs.ts` |
| GPU atlases and families | `packages/engine/src/webgpu/FontBook.ts`, `FontLibrary.ts` (+ `Gl*` equivalents) |
| Packing and draw ranges | `packages/engine/src/webgpu/lanes/TextBatcher.ts` |
| Record layouts | `packages/engine/src/render/textFormat.ts`, `meshFormat.ts` |
| Runtime parsing | `packages/ttf/` |

### Constants

| | Value |
| --- | --- |
| Charset | U+0020–U+007E (printable ASCII), both generators |
| MSDF generation size | 42 px |
| MSDF distance range | 4 px |
| MSDF page size | 512×512, one page per style |
| Styles per family | 4 — `regular`, `bold`, `italic`, `bold-italic` (`STYLE_ORDER`) |
| Text vertex stride | 36 bytes |
| Text object record | 320 bytes |
| Polygon coordinates | integer font units |
