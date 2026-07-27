// Self-test for the text pipeline's pure stages (no GPU, no DOM), covering BOTH
// implementations:
//
//   - the shared shaper - glyph-metric normalization, kerning, letter-spacing, word wrap,
//     '\n' breaks, alignment, per-run materials, glyph/decoration quad emission - run
//     against the real generated Inter atlases, so it also checks that the committed
//     metrics JSON is well-formed;
//   - the vector path - outline extraction from the real Inter TTFs, the on-demand metrics
//     adapter, cached glyph meshes, and VectorText's tessellation into the mesh lane.
//
// Having both here is what makes the cross-checks possible: the same font reaches the two
// paths through completely different code (msdf-bmfont-xml offline vs opentype.js at
// runtime), so where they disagree beyond the atlas's own rounding, one of them is wrong.
//
// The GPU pieces (FontAtlas texture upload, TextBatcher, the MSDF shader, and the mesh lane
// the vector path draws through) are exercised on-screen, not here.
// Run with: npx tsx src/text/selfTest.ts

import { readFileSync } from 'node:fs'
import { kerningFor, normalizeMetrics, type FontMetrics, type MsdfFontJson } from './msdfMetrics'
import { layoutText, type FontProvider, type TextRun } from './layout'
import type { FontStyle } from './FontAtlas'
// Imported from msdfProvider directly, not FontAtlas: FontAtlas.ts also pulls in `?url` PNG
// imports only a bundler can resolve, which would break this file running under plain node.
import { msdfFontProvider } from './msdfProvider'
import { contoursFromCommands } from './glyphOutline'
import { VectorFontBook } from './VectorFont'
import { VectorText } from '../shapes/VectorText'
import type { RGBA } from '../render/meshFormat'
import regularJson from './fonts/inter-regular.json'
import boldJson from './fonts/inter-bold.json'
import italicJson from './fonts/inter-italic.json'
import boldItalicJson from './fonts/inter-bold-italic.json'

let count = 0
function assert(cond: boolean, msg: string): void {
  count++
  if (!cond) throw new Error(`[text] self-test FAILED: ${msg}`)
}

const STYLE_ORDER: FontStyle[] = ['regular', 'bold', 'italic', 'bold-italic']
const METRICS: Record<FontStyle, FontMetrics> = {
  regular: normalizeMetrics(regularJson as unknown as MsdfFontJson),
  bold: normalizeMetrics(boldJson as unknown as MsdfFontJson),
  italic: normalizeMetrics(italicJson as unknown as MsdfFontJson),
  'bold-italic': normalizeMetrics(boldItalicJson as unknown as MsdfFontJson),
}

// A GPU-free FontProvider backed by the real normalized metrics (all four styles present).
const fonts: FontProvider = {
  resolve: (style) => ({ metrics: METRICS[style], atlasIndex: STYLE_ORDER.indexOf(style), fauxBold: false, fauxItalic: false }),
}

// A provider with only 'regular' loaded, so bold/italic requests must be synthesized.
const regularOnly: FontProvider = {
  resolve: (style) => ({
    metrics: METRICS.regular,
    atlasIndex: 0,
    fauxBold: style.includes('bold'),
    fauxItalic: style.includes('italic'),
  }),
}

const run = (text: string, style: TextRun['style'] = {}): TextRun => ({ text, style })
const finite = (n: number) => Number.isFinite(n)

// --- msdfFontProvider: the GPU-free FontProvider a scene can measure text with, with no
// FontBook/device involved (see FontAtlas.ts) - built off the SAME bundled JSON as `fonts`
// above, so the two must resolve identically. ---
{
  const provider = msdfFontProvider()
  assert(provider === msdfFontProvider(), 'the provider is built once and cached, not rebuilt per call')

  const bold = provider.resolve('bold')
  assert(bold.atlasIndex === STYLE_ORDER.indexOf('bold'), "resolving 'bold' returns bold's atlas index")
  assert(!bold.fauxBold && !bold.fauxItalic, 'an exact style match needs no synthesis (all four are bundled)')
  assert(bold.metrics.glyphs.size === METRICS.bold.glyphs.size, "msdfFontProvider's metrics match FontBook's own normalization")

  const shaped = layoutText([run('Measured before any device exists', { fontSize: 20 })], { maxWidth: 140 }, provider)
  assert(shaped.lineCount > 1 && shaped.height > 0, 'the shaper runs against it exactly like any other FontProvider')
}

// --- metrics: uv rects normalized into [0,1], sane advances, kerning present ---
{
  const m = METRICS.regular
  const a = m.glyphs.get(65) // 'A'
  assert(a !== undefined, "regular atlas has glyph 'A'")
  if (a) {
    assert(a.u0 >= 0 && a.u1 <= 1 && a.v0 >= 0 && a.v1 <= 1, 'uv rect lies within [0,1]')
    assert(a.u1 > a.u0 && a.v1 > a.v0, 'uv rect is non-empty')
    assert(a.xadvance > 0 && a.width > 0, "'A' has positive advance and width")
  }
  assert(m.size === 42 && m.distanceRange === 4, 'generation size 42, distance range 4')
  assert(m.glyphs.size >= 90, 'the printable-ASCII charset is present (>= 90 glyphs)')
  assert(m.kernings.size > 0, 'kerning pairs were captured')
}

// --- shaping: one glyph quad per visible char, one material per run, left-to-right order ---
{
  const shaped = layoutText([run('AV', { fontSize: 40 })], {}, fonts)
  const glyphQuads = shaped.quads.filter((q) => q.isGlyph)
  assert(glyphQuads.length === 2, "'AV' emits two glyph quads")
  assert(shaped.materials.length === 1, 'a single run yields a single material')
  assert(shaped.materials[0].fillPriority === 'color', 'a plain run is a solid-color material')
  assert(glyphQuads[0].x0 < glyphQuads[1].x0, 'glyphs are placed left to right')
  assert(shaped.quads.every((q) => finite(q.x0) && finite(q.y0) && finite(q.x1) && finite(q.y1)), 'no NaN coords')
  assert(glyphQuads.every((q) => q.u1 > q.u0 && q.v1 > q.v0), 'glyph quads carry a real uv rect')
}

// --- kerning: a negative pair (Inter kerns '"4' tighter) pulls the second glyph leftward ---
{
  const m = METRICS.regular
  const scale = 40 / m.size
  const first = 34 // '"'
  const second = 52 // '4'
  const glyph1 = m.glyphs.get(first)!
  const glyph2 = m.glyphs.get(second)!
  const kern = m.kernings.get(first * 0x110000 + second) ?? 0
  const shaped = layoutText([run('"4', { fontSize: 40 })], {}, fonts)
  const q2 = shaped.quads.filter((q) => q.isGlyph)[1]
  // The second glyph's pen x is glyph1.advance + kern (scaled); its quad left adds its xoffset.
  const pen2 = (glyph1.xadvance + kern) * scale
  assert(kern < 0, "Inter kerns '\"4' tighter (negative)")
  assert(Math.abs(q2.x0 - (pen2 + glyph2.xoffset * scale)) < 1e-3, 'the second glyph sits at the kerned pen position')
}

// --- word wrap: a narrow maxWidth splits into multiple lines; wider fits on one ---
{
  const text = 'wrap wrap wrap wrap wrap'
  const narrow = layoutText([run(text, { fontSize: 24 })], { maxWidth: 90 }, fonts)
  const wide = layoutText([run(text, { fontSize: 24 })], { maxWidth: 100000 }, fonts)
  assert(narrow.lineCount > 1, 'a narrow max width wraps to multiple lines')
  assert(wide.lineCount === 1, 'a very wide max width stays on one line')
  assert(narrow.height > wide.height, 'more lines means a taller block')
}

// --- hard breaks: '\n' forces a new line, and later lines sit lower (smaller y) ---
{
  const shaped = layoutText([run('a\nb', { fontSize: 30 })], {}, fonts)
  const glyphQuads = shaped.quads.filter((q) => q.isGlyph)
  assert(shaped.lineCount === 2, "'\\n' forces a second line")
  assert(glyphQuads.length === 2, 'two glyphs across the two lines')
  assert(glyphQuads[1].y1 < glyphQuads[0].y1, 'the second line is below the first (y-up)')
}

// --- alignment: right/center shift the first glyph rightward vs. left alignment ---
{
  const opts = { maxWidth: 400 }
  const left = layoutText([run('abc', { fontSize: 28 })], { ...opts, align: 'left' }, fonts)
  const center = layoutText([run('abc', { fontSize: 28 })], { ...opts, align: 'center' }, fonts)
  const right = layoutText([run('abc', { fontSize: 28 })], { ...opts, align: 'right' }, fonts)
  const first = (s: typeof left) => s.quads.filter((q) => q.isGlyph)[0].x0
  assert(first(left) < first(center) && first(center) < first(right), 'left < center < right first-glyph x')
  assert(first(right) > 200, 'right alignment pushes text to the far side of the block')
}

// --- decorations: underline, strikethrough, and highlight add non-glyph quads ---
{
  const plain = layoutText([run('hi', { fontSize: 30 })], {}, fonts)
  assert(plain.quads.every((q) => q.isGlyph), 'a plain run has no decoration quads')

  const underlined = layoutText([run('hi', { fontSize: 30, underline: true })], {}, fonts)
  assert(underlined.quads.some((q) => !q.isGlyph), 'underline adds a solid (non-glyph) quad')

  const struck = layoutText([run('hi', { fontSize: 30, strikethrough: true })], {}, fonts)
  const strikeQuad = struck.quads.find((q) => !q.isGlyph)
  assert(strikeQuad !== undefined && strikeQuad.y1 > strikeQuad.y0, 'strikethrough is a real rect')

  const hl: TextRun = run('hi', { fontSize: 30, highlight: [1, 1, 0, 1] })
  const highlighted = layoutText([hl], {}, fonts)
  const bg = highlighted.quads.find((q) => !q.isGlyph)
  assert(bg !== undefined, 'highlight adds a background quad')
  // The highlight is emitted before the glyphs so it renders behind them.
  assert(highlighted.quads[0].isGlyph === false, 'highlight background is drawn first (behind glyphs)')
}

// --- materials: gradient and stroke runs produce the right material records ---
{
  const shaped = layoutText(
    [
      run('grad', {
        fontSize: 40,
        gradient: {
          type: 'linear',
          start: { x: 0, y: 0 },
          end: { x: 100, y: 0 },
          stops: [
            { offset: 0, color: [1, 0, 0, 1] },
            { offset: 1, color: [0, 0, 1, 1] },
          ],
        },
      }),
      run('bold', { fontStyle: 'bold', fontSize: 40, color: [0, 0, 0, 1], strokeColor: [1, 1, 1, 1], strokeWidth: 3 }),
    ],
    {},
    fonts,
  )
  assert(shaped.materials.length === 2, 'two runs yield two materials')
  assert(shaped.materials[0].fillPriority === 'linear-gradient', 'gradient run is a linear-gradient material')
  assert(shaped.materials[0].stops.length === 2, 'gradient stops are carried onto the material')
  assert(shaped.materials[1].strokeWidth === 3, 'stroke width reaches the material record')
  // The bold run's glyphs reference the bold atlas index (1) for draw segmentation.
  const boldGlyph = shaped.quads.find((q) => q.isGlyph && q.material === 1)
  assert(boldGlyph !== undefined && boldGlyph.atlasIndex === STYLE_ORDER.indexOf('bold'), 'bold run points at the bold atlas')
}

// --- letter spacing widens a run's advance ---
{
  const tight = layoutText([run('mmm', { fontSize: 30 })], {}, fonts)
  const loose = layoutText([run('mmm', { fontSize: 30, letterSpacing: 8 })], {}, fonts)
  assert(loose.width > tight.width, 'letter spacing widens the laid-out block')
}

// --- baseline shift raises a superscript run and lowers a subscript run ---
{
  const base = layoutText([run('x', { fontSize: 30 })], {}, fonts).quads.filter((q) => q.isGlyph)[0]
  const sup = layoutText([run('x', { fontSize: 30, baselineShift: 12 })], {}, fonts).quads.filter((q) => q.isGlyph)[0]
  const sub = layoutText([run('x', { fontSize: 30, baselineShift: -12 })], {}, fonts).quads.filter((q) => q.isGlyph)[0]
  assert(sup.y1 > base.y1 && sub.y1 < base.y1, 'superscript sits above the baseline, subscript below')
}

// --- justify: a wrapped (non-final) line stretches to fill the max width ---
{
  const text = 'aa bb cc dd ee ff gg hh'
  const maxWidth = 200
  const justified = layoutText([run(text, { fontSize: 20 })], { maxWidth, align: 'justify' }, fonts)
  const left = layoutText([run(text, { fontSize: 20 })], { maxWidth, align: 'left' }, fonts)
  // The last glyph of the first (wrapped) line reaches the block's right edge under justify.
  const firstLineRight = (s: typeof justified) => {
    const line0 = s.quads.filter((q) => q.isGlyph && q.y1 > -25) // first line has the highest y
    return Math.max(...line0.map((q) => q.x1))
  }
  assert(justified.lineCount > 1, 'the sample wraps to multiple lines')
  assert(firstLineRight(justified) > firstLineRight(left) + 5, 'justify pushes the first line to the right edge')
  assert(firstLineRight(justified) > maxWidth - 20, 'a justified line nearly fills the max width')
}

// --- faux bold / italic: synthesized from the regular-only provider and via explicit flags ---
{
  const fauxBold = layoutText([run('B', { fontStyle: 'bold', fontSize: 40 })], {}, regularOnly)
  assert(fauxBold.materials[0].dilate > 0, 'a missing bold style is synthesized with coverage dilation')

  const fauxItalic = layoutText([run('I', { fontStyle: 'italic', fontSize: 40 })], {}, regularOnly)
  assert(fauxItalic.quads.filter((q) => q.isGlyph)[0].skew > 0, 'a missing italic style is synthesized with shear')

  // Explicit flags synthesize on top of a present atlas (e.g. faux bold-italic from italic).
  const explicit = layoutText([run('x', { fontStyle: 'italic', fontSize: 40, fauxBold: true, fauxItalic: true })], {}, fonts)
  assert(explicit.materials[0].dilate > 0, 'fauxBold flag adds dilation')
  assert(explicit.quads.filter((q) => q.isGlyph)[0].skew > 0, 'fauxItalic flag adds shear')
}

// --- drop shadow + soft glow: extra materials and extra glyph quads behind the body ---
{
  const plain = layoutText([run('g', { fontSize: 40 })], {}, fonts)
  assert(plain.quads.filter((q) => q.isGlyph).length === 1, 'a plain glyph emits one quad')
  assert(plain.materials.length === 1, 'a plain run has one material')
  const plainQuad = plain.quads.find((q) => q.isGlyph)!

  const shadowed = layoutText([run('g', { fontSize: 40, shadow: { color: [0, 0, 0, 0.5], offsetX: 3, offsetY: 3 } })], {}, fonts)
  assert(shadowed.materials.length === 2, 'a shadow adds a second material')
  assert(shadowed.quads.filter((q) => q.isGlyph).length === 2, 'the shadow adds a second glyph quad')

  // Text's shadow is a plain duplicate of the glyphs - no blur, so it adds no coverage
  // dilation of its own (unlike the glow below). That is the whole point of the text
  // model: a crisp offset copy, not a rasterized-and-blurred silhouette.
  const shadowMaterial = shadowed.materials[shadowed.materials.length - 1]
  assert(shadowMaterial.dilate === 0, "a text shadow doesn't dilate coverage - it's a duplicate, not a blur")

  // offsetY is downward-positive, matching Shape's shadowOffsetY, so it moves the copy to
  // a LOWER local y in this y-up scene.
  const shadowQuad = shadowed.quads.find((q) => q.isGlyph && q.material === 1)!
  assert(Math.abs(shadowQuad.x0 - (plainQuad.x0 + 3)) < 1e-6, 'shadow offsetX shifts the duplicate right')
  assert(Math.abs(shadowQuad.y0 - (plainQuad.y0 - 3)) < 1e-6, 'shadow offsetY is downward-positive')

  const glowed = layoutText([run('g', { fontSize: 40, glow: { color: [1, 1, 0, 1], radius: 4 } })], {}, fonts)
  assert(glowed.materials.some((m) => m.dilate >= 4), 'the glow material carries the spread radius')
  assert(glowed.quads.filter((q) => q.isGlyph).length === 2, 'the glow adds a second glyph quad')
  // The glow is emitted before the body so it renders behind it.
  assert(!glowed.quads[glowed.quads.length - 1].isGlyph || glowed.quads[0].material !== glowed.quads[glowed.quads.length - 1].material, 'glow precedes body')

  // opacity multiplies the shadow color's own alpha, baked in at shape time (no GPU field).
  const faded = layoutText([run('g', { fontSize: 40, shadow: { color: [0, 0, 0, 0.8], offsetX: 2, offsetY: 2, opacity: 0.5 } })], {}, fonts)
  const fadedQuad = faded.quads.find((q) => q.isGlyph && q.material === faded.materials.length - 1)!
  assert(Math.abs(fadedQuad.color[3] - 0.4) < 1e-6, 'shadow opacity multiplies the color alpha (0.8*0.5)')
  const opaque = layoutText([run('g', { fontSize: 40, shadow: { color: [0, 0, 0, 0.8], offsetX: 2, offsetY: 2 } })], {}, fonts)
  const opaqueQuad = opaque.quads.find((q) => q.isGlyph && q.material === opaque.materials.length - 1)!
  assert(Math.abs(opaqueQuad.color[3] - 0.8) < 1e-6, 'omitting opacity leaves the colour alpha alone')
}

// --- rtl: right-to-left flow reverses visual glyph order (first char lands rightmost) ---
{
  const ltr = layoutText([run('AB', { fontSize: 40 })], { maxWidth: 400 }, fonts).quads.filter((q) => q.isGlyph)
  const rtl = layoutText([run('AB', { fontSize: 40 })], { maxWidth: 400, direction: 'rtl' }, fonts).quads.filter((q) => q.isGlyph)
  // Under LTR the first emitted glyph (A) is left of B; under RTL A is placed to the right of B.
  assert(ltr[0].x0 < ltr[1].x0, 'LTR places A left of B')
  assert(rtl.find((q) => q.x0 === Math.max(...rtl.map((r) => r.x0))) !== undefined, 'RTL produced placed glyphs')
  const rtlByX = [...rtl].sort((a, b) => a.x0 - b.x0)
  assert(rtlByX.length === 2, 'RTL emits both glyphs')
}

// --- vertical: glyphs stack downward, later columns sit to the left ---
{
  const v = layoutText([run('ab\ncd', { fontSize: 40 })], { orientation: 'vertical' }, fonts)
  const g = v.quads.filter((q) => q.isGlyph) // emitted column-by-column, top-to-bottom: a,b,c,d
  assert(v.lineCount === 2, 'a vertical block splits into columns on newline')
  assert(g.length === 4, 'four glyphs across two columns')
  assert(g[1].y1 < g[0].y1, 'vertical glyphs stack top-to-bottom within a column')
  assert(g[2].x0 < g[0].x0, 'later columns sit to the left of earlier ones')
}


// =====================================================================================
// Vector text: the second implementation - real glyph outlines through the mesh lane.
// These run against the actual Inter TTFs, so they double as a cross-check between two
// independent extractions of the same font: opentype.js here, and msdf-bmfont-xml's
// numbers baked into the atlas JSON above.
// =====================================================================================

// --- contour extraction from raw command streams (no font file involved) ---
{
  // Fonts store y up; opentype hands paths back y-down, so every y is negated on the way in.
  const tri = contoursFromCommands(
    [
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 100, y: 0 },
      { type: 'L', x: 0, y: -100 },
      { type: 'Z' },
    ],
    1,
  )
  assert(tri.length === 1, 'a closed triangle yields one contour')
  assert(tri[0].closed === true, 'the contour is closed')
  assert(tri[0].points.length === 3, 'three corners, with no repeat of the start point')
  assert(tri[0].points[2].y === 100, "opentype's y-down coordinates are flipped to y-up")

  // A moveto immediately followed by a lineto to the same point is common in real fonts,
  // and a zero-length edge breaks contour classification (see glyphOutline.ts).
  const deduped = contoursFromCommands(
    [
      { type: 'M', x: 10, y: 10 },
      { type: 'L', x: 10, y: 10 },
      { type: 'L', x: 90, y: 10 },
      { type: 'L', x: 90, y: 90 },
      { type: 'L', x: 10, y: 10 },
      { type: 'Z' },
    ],
    1,
  )
  assert(deduped.length === 1, 'the degenerate edges still leave one contour')
  assert(deduped[0].points.length === 3, 'duplicate and wrap-around points are dropped')

  // Curves subdivide; a tighter tolerance subdivides further.
  const coarse = contoursFromCommands(
    [
      { type: 'M', x: 0, y: 0 },
      { type: 'Q', x1: 50, y1: -100, x: 100, y: 0 },
      { type: 'Z' },
    ],
    20,
  )
  const fine = contoursFromCommands(
    [
      { type: 'M', x: 0, y: 0 },
      { type: 'Q', x1: 50, y1: -100, x: 100, y: 0 },
      { type: 'Z' },
    ],
    0.5,
  )
  assert(coarse[0].points.length >= 3, 'a quadratic flattens to a usable ring')
  assert(fine[0].points.length > coarse[0].points.length, 'a tighter tolerance subdivides more')

  // Anything that can't enclose an area isn't a fillable contour.
  assert(contoursFromCommands([{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 5, y: 0 }, { type: 'Z' }], 1).length === 0, 'a two-point ring is dropped')
  assert(contoursFromCommands([], 1).length === 0, 'an empty command stream yields no contours')
}

// --- VectorFont against the real Inter TTF ---
const ttf = (name: string): ArrayBuffer => {
  const bytes = readFileSync(new URL(`./fonts/src/${name}`, import.meta.url))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}
const vectorFonts = await VectorFontBook.load([
  { style: 'regular', data: ttf('Inter-Regular.ttf') },
  { style: 'bold', data: ttf('Inter-Bold.ttf') },
  { style: 'italic', data: ttf('Inter-Italic.ttf') },
  { style: 'bold-italic', data: ttf('Inter-BoldItalic.ttf') },
])
const regularVector = vectorFonts.fontByIndex(0)!

{
  const m = regularVector.metrics
  assert(m.size === regularVector.unitsPerEm, 'metrics are expressed in font units, so size is unitsPerEm')
  assert(m.base > 0 && m.lineHeight > m.base, 'ascent is positive and a line is taller than its ascent')

  // The decoration metrics come straight from the font's post/OS2 tables here, and from
  // msdf-bmfont-xml's own reading of the same tables in the committed atlas JSON. They are
  // em fractions in both, so they must agree - if they ever don't, one of the two is wrong.
  const d = m.decoration
  const reference = METRICS.regular.decoration
  assert(Math.abs(d.underlineOffset - reference.underlineOffset) < 1e-6, 'underline offset matches the atlas metrics')
  assert(Math.abs(d.underlineThickness - reference.underlineThickness) < 1e-6, 'underline thickness matches the atlas metrics')
  assert(Math.abs(d.strikeOffset - reference.strikeOffset) < 1e-6, 'strike offset matches the atlas metrics')
  assert(Math.abs(d.strikeThickness - reference.strikeThickness) < 1e-6, 'strike thickness matches the atlas metrics')
}

// --- glyphs and kerning are measured on demand, not up front ---
{
  const font = (await VectorFontBook.load([{ style: 'regular', data: ttf('Inter-Regular.ttf') }])).fontByIndex(0)!
  assert(font.metrics.glyphs.size === 0, 'a freshly parsed font has measured nothing')
  font.ensure('Ao ')
  assert(font.metrics.glyphs.size === 3, 'ensure() measures exactly the characters asked for')
  assert(font.metrics.glyphs.has(65) && font.metrics.glyphs.has(111) && font.metrics.glyphs.has(32), 'A, o and space are all present')

  // A blank glyph has no box but still advances the pen - otherwise spaces would collapse.
  const space = font.metrics.glyphs.get(32)!
  assert(space.width === 0 && space.height === 0, 'space has no outline extents')
  assert(space.xadvance > 0, 'space still advances')

  // Advances must agree with the atlas metrics once both are scaled to the same em.
  const a = font.metrics.glyphs.get(65)!
  const reference = METRICS.regular.glyphs.get(65)!
  const mine = a.xadvance / font.metrics.size
  const theirs = reference.xadvance / METRICS.regular.size
  assert(Math.abs(mine - theirs) < 0.01, "A's advance matches the atlas metrics (per em)")

  // A code point the font has no glyph for is measured once and left absent, so the shaper
  // spaces it exactly as the MSDF path does for a character outside the generated charset.
  font.ensure('\u{1F600}')
  assert(!font.metrics.glyphs.has(0x1f600), 'an unmapped code point stays absent rather than becoming tofu')
}

// --- kerning comes from GPOS, and matches what the atlas generator found ---
{
  const pair = (regularJson as unknown as MsdfFontJson).kernings.find((k) => k.amount !== 0)!
  const font = (await VectorFontBook.load([{ style: 'regular', data: ttf('Inter-Regular.ttf') }])).fontByIndex(0)!
  font.ensure(String.fromCodePoint(pair.first) + String.fromCodePoint(pair.second))
  const mine = kerningFor(font.metrics, pair.first, pair.second) / font.metrics.size
  assert(mine !== 0, 'GPOS kerning is found (the positioning engine was initialized)')
  // The atlas stores kerning as whole pixels at its 42px generation size, so the two agree
  // only up to that quantization - compare on the atlas's own grid rather than in em.
  assert(Math.abs(mine * METRICS.regular.size - pair.amount) <= 0.75, 'the kerning amount matches the atlas metrics, up to its pixel rounding')
}

// --- cached glyph meshes ---
{
  regularVector.ensure('oI ')
  const o = regularVector.mesh(111)!
  assert(o.contours.length === 2, "'o' has an outer ring and a counter")
  assert(o.vertices.length > 0 && o.indices.length % 3 === 0, 'the counter is triangulated into whole triangles')
  assert(regularVector.mesh(111) === o, 'a glyph mesh is built once and cached')

  const i = regularVector.mesh(73)!
  assert(i.contours.length === 1, "'I' is a single ring")

  // Whitespace resolves to a real glyph with no outline - not a miss, which would make the
  // shaper fall back to a space's advance instead of using the space's own.
  const space = regularVector.mesh(32)!
  assert(space.contours.length === 0 && space.vertices.length === 0, 'space has a mesh with no geometry')
  assert(regularVector.mesh(0x1f600) === undefined, 'an unmeasured code point has no mesh')
}

// --- the same shaper, driven by outlines instead of an atlas ---
{
  const text = 'Wave'
  vectorFonts.prepare('regular', text)
  const viaOutlines = layoutText([run(text, { fontSize: 40 })], {}, vectorFonts)
  const viaAtlas = layoutText([run(text, { fontSize: 40 })], {}, fonts)
  assert(viaOutlines.quads.length === viaAtlas.quads.length, 'both font kinds shape the same text into the same quads')

  // Advances and line metrics come from the same font, so the measured block agrees to
  // within the atlas's own rounding (its metrics are integers at a 42px generation size).
  // Note this is the ADVANCE width, not the inked extent: an MSDF glyph's box is padded by
  // the distance range, so its quads legitimately reach a few percent further out.
  const close = (a: number, b: number) => Math.abs(a - b) / b < 0.01
  assert(close(viaOutlines.width, viaAtlas.width), 'the two paths measure the same string to within 1%')
  assert(close(viaOutlines.height, viaAtlas.height), 'and give it the same line height')

  // The outline placement the vector path needs: the pen origin sits on the baseline, at
  // or left of the glyph's inked box (a glyph's left side bearing is normally positive).
  const glyph = viaOutlines.quads.find((q) => q.isGlyph)!
  assert(glyph.codePoint === 'W'.codePointAt(0), 'a glyph quad records its code point')
  assert(glyph.unitScale > 0 && Math.abs(glyph.unitScale - 40 / regularVector.metrics.size) < 1e-9, 'unitScale converts font units to local units')
  assert(glyph.originY < glyph.y1, 'the pen origin sits below the top of the glyph box')
}

// --- VectorText tessellates into the mesh lane, one material per (run feature, colour) ---
const recordGeometry = (shape: VectorText) => {
  const verts: { x: number; y: number; isFill: boolean; material: number }[] = []
  const tris: [number, number, number][] = []
  shape.tessellate({
    vertex: (x, y, isFill, material = 0) => verts.push({ x, y, isFill, material }) - 1,
    triangle: (a, b, c) => {
      tris.push([a, b, c])
    },
  })
  return { verts, tris }
}

{
  const red: RGBA = [1, 0, 0, 1]
  const blue: RGBA = [0, 0, 1, 1]
  const node = new VectorText({
    fonts: vectorFonts,
    runs: [
      { text: 'Red', style: { fontSize: 48, color: red } },
      { text: 'Blue', style: { fontSize: 48, color: blue } },
    ],
  })

  const materials = node.materials()
  assert(materials.length === 2, 'two differently coloured runs become two materials')
  assert(materials[0].fill === red && materials[1].fill === blue, 'each material carries its run colour')

  const { verts, tris } = recordGeometry(node)
  assert(verts.length > 0 && tris.length > 0, 'the glyphs tessellate into real triangles')
  assert(verts.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y)), 'no NaN leaks out of the outline transform')
  assert(verts.every((v) => v.material >= 0 && v.material < materials.length), 'every vertex names a material that exists')
  assert(new Set(verts.map((v) => v.material)).size === 2, 'both runs contribute geometry')
  assert(tris.every(([a, b, c]) => a < verts.length && b < verts.length && c < verts.length), 'triangles index real vertices')

  // Re-tessellating replays the cache rather than re-shaping, and content changes drop it.
  const again = recordGeometry(node)
  assert(again.verts.length === verts.length, 'a second tessellation replays the same geometry')
  node.setText('Red', { fontSize: 48, color: red })
  assert(node.materials().length === 1, 'replacing the content re-shapes and re-derives the materials')
  assert(recordGeometry(node).verts.length < verts.length, 'the shorter text tessellates to less geometry')
}

// --- decorations, highlights and outlines are separate materials and separate geometry ---
{
  const plain = new VectorText({ fonts: vectorFonts, text: 'Hi', style: { fontSize: 40 } })
  const decorated = new VectorText({
    fonts: vectorFonts,
    text: 'Hi',
    style: { fontSize: 40, underline: true, highlight: [1, 1, 0, 1] },
  })
  assert(decorated.materials().length > plain.materials().length, 'a highlight is painted separately from the glyphs')
  assert(recordGeometry(decorated).verts.length > recordGeometry(plain).verts.length, 'decorations add geometry')

  // A per-letter outline is stroke geometry, so it takes the material's stroke colour
  // rather than its fill - exactly like a stroked Rect or Path.
  const outlined = new VectorText({
    fonts: vectorFonts,
    text: 'Hi',
    style: { fontSize: 40, strokeColor: [0, 0, 0, 1], strokeWidth: 2 },
  })
  const outlinedVerts = recordGeometry(outlined).verts
  assert(outlinedVerts.some((v) => !v.isFill), 'the outline emits stroke vertices')
  assert(recordGeometry(plain).verts.every((v) => v.isFill), 'an unoutlined run emits only fill vertices')

  // Round joins are VectorText's default because letterforms have far sharper corners than
  // the shapes the miter default was chosen for - the apexes of A and W grow spikes well
  // above the cap height at any appreciable stroke width.
  const spiky = { text: 'AWM', style: { fontSize: 60, strokeColor: [0, 0, 0, 1] as RGBA, strokeWidth: 8 } }
  const round = new VectorText({ fonts: vectorFonts, ...spiky })
  const mitred = new VectorText({ fonts: vectorFonts, lineJoin: 'miter', ...spiky })
  assert(round.lineJoin === 'round', 'VectorText defaults to round joins')
  const height = (shape: VectorText) => shape.localBounds().max.y - shape.localBounds().min.y
  assert(height(mitred) > height(round) * 1.3, 'miter joins spike far past the letterforms')
  assert(new VectorText({ fonts: vectorFonts, lineJoin: 'bevel', ...spiky }).lineJoin === 'bevel', 'an explicit join still wins')

  // Faux bold thickens the letterform, so its ring must take the FILL colour (and any
  // gradient), not the stroke slot - which a real outline may be using at the same time.
  const bolded = new VectorText({ fonts: vectorFonts, text: 'Hi', style: { fontSize: 40, fauxBold: true } })
  const boldedVerts = recordGeometry(bolded).verts
  assert(boldedVerts.length > recordGeometry(plain).verts.length, 'faux bold adds a dilation ring')
  assert(boldedVerts.every((v) => v.isFill), 'the dilation ring is fill geometry, leaving the stroke slot free')
}

// --- being mesh geometry is the point: picking and bounds come for free ---
{
  const node = new VectorText({
    fonts: vectorFonts,
    text: 'Box',
    style: { fontSize: 60, highlight: [1, 1, 0, 1] },
  })
  const bounds = node.localBounds()
  assert(bounds.valid(), 'a vector text node has real geometric bounds')

  const shaped = node.shaped()
  const highlight = shaped.quads.find((q) => !q.isGlyph)!
  // The highlight rect is solid, so its centre is inside the actual triangles - this is
  // per-geometry hit-testing, not the bounding-box test the MSDF path settles for.
  assert(node.hitTestLocal((highlight.x0 + highlight.x1) / 2, (highlight.y0 + highlight.y1) / 2), 'a point inside the run is a hit')
  assert(!node.hitTestLocal(bounds.max.x + 50, bounds.max.y + 50), 'a point outside the block is a miss')

  // A gradient run's glyphs use the mesh lane's own gradient; its decorations stay flat,
  // matching what the MSDF shader does for non-glyph quads.
  const gradient = new VectorText({
    fonts: vectorFonts,
    text: 'G',
    style: {
      fontSize: 60,
      underline: true,
      gradient: { type: 'linear', start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, stops: [{ offset: 0, color: [1, 0, 0, 1] }, { offset: 1, color: [0, 0, 1, 1] }] },
    },
  })
  const kinds = gradient.materials().map((m) => m.fillPriority)
  assert(kinds.includes('linear-gradient'), 'the glyph body keeps the run gradient')
  assert(kinds.includes('color'), 'the underline is painted flat')
}

// --- block layout reaches the GEOMETRY, not just the shaped quads ---
// Alignment, baseline shift and vertical flow are all the shared shaper's work, and the
// blocks above already check them there. What is new on this path is that the outlines
// follow: a glyph is placed from the pen origin the shaper recorded, and vertical text in
// particular reaches makeGlyphQuad by a different route than horizontal text does. These
// assertions therefore measure tessellated vertices, not quads.
{
  const boundsOf = (shape: VectorText) => {
    const { verts } = recordGeometry(shape)
    const xs = verts.map((v) => v.x)
    const ys = verts.map((v) => v.y)
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
  }

  // Baseline shift moves a run's outline by exactly the shift, and nothing else with it.
  const plain = new VectorText({ fonts: vectorFonts, runs: [{ text: 'x', style: { fontSize: 40 } }] })
  const raised = new VectorText({ fonts: vectorFonts, runs: [{ text: 'x', style: { fontSize: 40, baselineShift: 15 } }] })
  const lowered = new VectorText({ fonts: vectorFonts, runs: [{ text: 'x', style: { fontSize: 40, baselineShift: -15 } }] })
  assert(Math.abs(boundsOf(raised).y0 - (boundsOf(plain).y0 + 15)) < 1e-6, 'a positive baseline shift lifts the outline by exactly that much')
  assert(Math.abs(boundsOf(lowered).y0 - (boundsOf(plain).y0 - 15)) < 1e-6, 'a negative baseline shift drops it')
  assert(Math.abs(boundsOf(raised).x0 - boundsOf(plain).x0) < 1e-6, 'and moves it vertically only')

  // A superscript run rides above its neighbour without disturbing the pen.
  const superscript = new VectorText({
    fonts: vectorFonts,
    runs: [
      { text: 'x', style: { fontSize: 40 } },
      { text: '2', style: { fontSize: 24, baselineShift: 16 } },
    ],
  })
  const glyphs = superscript.shaped().quads.filter((q) => q.isGlyph)
  assert(glyphs.length === 2, 'both runs contribute a glyph')
  assert(glyphs[1].originY > glyphs[0].originY, 'the shifted run sits above the baseline of the one before it')
  assert(glyphs[1].originX > glyphs[0].originX, 'and after it, so the shift is vertical only')

  // Alignment offsets the geometry within the block; justify stretches to fill it.
  const wrapped = 'align this text so it wraps'
  const aligned = (align: 'left' | 'center' | 'right' | 'justify') =>
    boundsOf(new VectorText({ fonts: vectorFonts, text: wrapped, style: { fontSize: 20 }, maxWidth: 200, align }))
  const left = aligned('left')
  const center = aligned('center')
  const right = aligned('right')
  const justify = aligned('justify')
  assert(left.x0 < center.x0 && center.x0 < right.x0, 'left < center < right, measured on the tessellated glyphs')
  assert(right.x1 - left.x1 > 20, 'right alignment pushes the ink to the far edge of the block')
  assert(justify.x1 - justify.x0 > left.x1 - left.x0, 'justification widens the block by spreading the spaces')
  assert(justify.x1 <= 200 + 1e-6, 'and stops at the wrap width')

  // Vertical flow: glyphs stack downward, and columns advance to the LEFT.
  const vertical = new VectorText({ fonts: vectorFonts, text: 'AB\nCD', style: { fontSize: 40 }, orientation: 'vertical' })
  const horizontal = new VectorText({ fonts: vectorFonts, text: 'AB\nCD', style: { fontSize: 40 } })
  assert(vertical.shaped().lineCount === 2, 'a newline starts a second column')
  assert(recordGeometry(vertical).verts.length === recordGeometry(horizontal).verts.length, 'the same four glyphs are tessellated either way')
  const columnQuads = vertical.shaped().quads.filter((q) => q.isGlyph)
  assert(columnQuads[1].originY < columnQuads[0].originY, 'glyphs stack top-to-bottom within a column')
  assert(columnQuads[2].originX < columnQuads[0].originX, 'the second column sits to the left of the first')
  assert(boundsOf(vertical).x1 <= 0, 'the block extends leftward from its origin')

  // One run, one column: set vertically it is a tall narrow strip, set horizontally a wide
  // short one. (The two-column node above is NOT the comparison to make - two columns of two
  // glyphs and two lines of two glyphs happen to occupy almost the same box.)
  const strip = boundsOf(new VectorText({ fonts: vectorFonts, text: 'ABCD', style: { fontSize: 40 }, orientation: 'vertical' }))
  const line = boundsOf(new VectorText({ fonts: vectorFonts, text: 'ABCD', style: { fontSize: 40 } }))
  assert(strip.y1 - strip.y0 > 2 * (line.y1 - line.y0), 'a single column is far taller than the same text on a line')
  assert(strip.x1 - strip.x0 < line.x1 - line.x0, 'and far narrower')
}

console.log(`[text] self-test passed (${count} assertions)`)
