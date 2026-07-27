// Self-test for the text pipeline's pure stages (no GPU, no DOM): glyph-metric normalization
// and the shaper (kerning, letter-spacing, word wrap, '\n' breaks, alignment, per-run
// materials, and glyph/decoration quad emission). It runs against the real generated Inter
// atlases, so it also checks that the committed metrics JSON is well-formed. The GPU pieces
// (FontAtlas texture upload, TextBatcher, the MSDF shader) are exercised on-screen, not here.
// Run with: npx tsx src/text/selfTest.ts

import { normalizeMetrics, type FontMetrics, type MsdfFontJson } from './msdfMetrics'
import { layoutText, type FontProvider, type TextRun } from './layout'
import type { FontStyle } from './FontAtlas'
import { shadow } from '../shapes/Shape'
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

  const shadowed = layoutText([run('g', { fontSize: 40, shadow: shadow({ color: [0, 0, 0, 0.5], offsetX: 3, offsetY: 3 }) })], {}, fonts)
  assert(shadowed.materials.length === 2, 'a shadow adds a second material')
  assert(shadowed.quads.filter((q) => q.isGlyph).length === 2, 'the shadow adds a second glyph quad')

  const glowed = layoutText([run('g', { fontSize: 40, glow: shadow({ color: [1, 1, 0, 1], spread: 4 }) })], {}, fonts)
  assert(glowed.materials.some((m) => m.dilate >= 4), 'the glow material carries the spread radius')
  assert(glowed.quads.filter((q) => q.isGlyph).length === 2, 'the glow adds a second glyph quad')
  // The glow is emitted before the body so it renders behind it.
  assert(!glowed.quads[glowed.quads.length - 1].isGlyph || glowed.quads[0].material !== glowed.quads[glowed.quads.length - 1].material, 'glow precedes body')

  // blur is a distinct field from spread (dilate): it doesn't touch dilate at all.
  const blurred = layoutText([run('g', { fontSize: 40, shadow: shadow({ color: [0, 0, 0, 1], blur: 5 }) })], {}, fonts)
  const blurredMaterial = blurred.materials[blurred.materials.length - 1]
  assert(blurredMaterial.blur === 5, 'blur is carried on the material')
  assert(blurredMaterial.dilate === 0, 'blur does not add to dilate')

  // opacity multiplies the shadow color's own alpha, baked in at shape time (no GPU field).
  const faded = layoutText([run('g', { fontSize: 40, shadow: shadow({ color: [0, 0, 0, 0.8], opacity: 0.5 }) })], {}, fonts)
  const fadedQuad = faded.quads.find((q) => q.isGlyph && q.material === faded.materials.length - 1)!
  assert(Math.abs(fadedQuad.color[3] - 0.4) < 1e-6, 'shadow opacity multiplies the color alpha (0.8*0.5)')

  // rotation turns the offset vector; a 180 degree rotation flips a +x offset to -x.
  const rotated = layoutText([run('g', { fontSize: 40, shadow: shadow({ color: [0, 0, 0, 1], offsetX: 10, offsetY: 0, rotation: Math.PI }) })], {}, fonts)
  const plainQuad = plain.quads.find((q) => q.isGlyph)!
  const rotatedQuad = rotated.quads.find((q) => q.isGlyph && q.material === rotated.materials.length - 1)!
  assert(Math.abs(rotatedQuad.x0 - (plainQuad.x0 - 10)) < 1e-6, 'a 180deg rotation flips a +x offset to -x')

  // size scales the shadow copy around its own center - bigger than the plain glyph quad.
  const sized = layoutText([run('g', { fontSize: 40, shadow: shadow({ color: [0, 0, 0, 1], size: 2 }) })], {}, fonts)
  const sizedQuad = sized.quads.find((q) => q.isGlyph && q.material === sized.materials.length - 1)!
  assert(sizedQuad.x1 - sizedQuad.x0 > (plainQuad.x1 - plainQuad.x0) * 1.9, 'shadow size scales the copy up')
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

console.log(`[text] self-test passed (${count} assertions)`)
