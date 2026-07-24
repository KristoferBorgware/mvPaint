// Self-test for the text pipeline's pure stages (no GPU, no DOM): glyph-metric normalization
// and the shaper (kerning, letter-spacing, word wrap, '\n' breaks, alignment, per-run
// materials, and glyph/decoration quad emission). It runs against the real generated Inter
// atlases, so it also checks that the committed metrics JSON is well-formed. The GPU pieces
// (FontAtlas texture upload, TextBatcher, the MSDF shader) are exercised on-screen, not here.
// Run with: npx tsx src/text/selfTest.ts

import { normalizeMetrics, type FontMetrics, type MsdfFontJson } from './msdfMetrics'
import { layoutText, type FontProvider, type TextRun } from './layout'
import type { FontStyle } from './FontAtlas'
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

// A GPU-free FontProvider backed by the real normalized metrics.
const fonts: FontProvider = {
  atlas: (style) => ({ metrics: METRICS[style] }),
  indexOf: (style) => STYLE_ORDER.indexOf(style),
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

console.log(`[text] self-test passed (${count} assertions)`)
