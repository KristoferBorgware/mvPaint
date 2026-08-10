// Self-test for the text pipeline's pure stages (no GPU, no DOM), covering BOTH
// implementations:
//
//   - the shared shaper - glyph-metric normalization, kerning, letter-spacing, word wrap,
//     '\n' breaks, alignment, per-run materials, glyph/decoration quad emission - run
//     against the real generated Inter atlases, so it also checks that the committed
//     metrics JSON is well-formed;
//   - the vector path - the committed polygon atlases, their glyph meshes, and VectorText's
//     tessellation into the mesh lane.
//
// Having both here is what makes the cross-checks possible: the same font reaches the two
// paths through completely different tools (msdf-bmfont-xml for the distance fields,
// opentype.js for the outlines, both offline), so where they disagree beyond the atlas's own
// rounding, one of them is wrong.
//
// The GPU pieces (FontAtlas texture upload, TextBatcher, the MSDF shader, and the mesh lane
// the vector path draws through) are exercised on-screen, not here.
// Run with: npx vitest run packages/engine/src/text/text.test.ts

import { expect, it } from 'vitest'
import type { Vector2Like } from '../math/Vector2'
import { kerningFor, normalizeMetrics, type FontMetrics, type MsdfFontJson } from './msdfMetrics'
import { layoutText, type FontProvider, type TextRun } from './layout'
import { arcPath, circlePath, TextPathGeometry } from './textPath'
import { quadCorner } from './textQuad'
import type { FontStyle } from './msdfProvider'
// Imported from msdfProvider directly, not FontAtlas: FontAtlas.ts pulls in the WebGPU half,
// which would break this file running under plain node.
import { atlasLayerSize, msdfFontProvider, type StyleJson } from './msdfProvider'
import { PolygonFontBook, type PolygonFontJson } from './PolygonFont'
import { MSDFText } from '../shapes/MSDFText'
import { bumpFontEpoch } from '../shapes/contentEpoch'
import { VectorText } from '../shapes/VectorText'
import { UniformMSDFText } from '../shapes/UniformMSDFText'
import { UniformVectorText } from '../shapes/UniformVectorText'
import { registerFontFamily } from '../resources/FontRegistry'
import { toDecorations, toFontStyle } from '../shapes/singleRun'
import type { RGBA } from '../render/meshFormat'
// NEITHER kind of atlas is the engine's - it ships no typeface - so both come from the example
// app's asset folder by path, a test fixture reaching across the workspace the same way
// packages/ttf's suite does. Test-only: nothing in src/ imports them, and the published package
// carries no font data. They sit under the app's public/ because that is how the app serves
// them; a JSON import reads the file just the same.
import regularJson from '../../../example-app/public/fonts/msdf/inter-regular.json'
import boldJson from '../../../example-app/public/fonts/msdf/inter-bold.json'
import italicJson from '../../../example-app/public/fonts/msdf/inter-italic.json'
import boldItalicJson from '../../../example-app/public/fonts/msdf/inter-bold-italic.json'
import regularPolygons from '../../../example-app/public/fonts/polygons/inter-regular.polygons.json'
import boldPolygons from '../../../example-app/public/fonts/polygons/inter-bold.polygons.json'
import italicPolygons from '../../../example-app/public/fonts/polygons/inter-italic.polygons.json'
import boldItalicPolygons from '../../../example-app/public/fonts/polygons/inter-bold-italic.polygons.json'

/**
 * Every check in this file goes through here, so each one reads as the sentence it is making
 * and vitest reports that sentence when it stops being true.
 */
function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}

const STYLE_ORDER: FontStyle[] = ['regular', 'bold', 'italic', 'bold-italic']
const STYLE_JSONS: Record<FontStyle, MsdfFontJson> = {
  regular: regularJson as unknown as MsdfFontJson,
  bold: boldJson as unknown as MsdfFontJson,
  italic: italicJson as unknown as MsdfFontJson,
  'bold-italic': boldItalicJson as unknown as MsdfFontJson,
}
// The set under test, in STYLE_ORDER - what an application passes as `fonts`, and what every
// layer-size assertion below is measured against. The layer size follows whichever set it is
// given, so the test computes it with atlasLayerSize, exactly as an MSDFFontBook does.
const STYLES: StyleJson[] = STYLE_ORDER.map((style) => ({ style, json: STYLE_JSONS[style] }))
const ATLAS_LAYER_SIZE = atlasLayerSize(STYLES)

const METRICS: Record<FontStyle, FontMetrics> = {
  regular: normalizeMetrics(STYLE_JSONS.regular, ATLAS_LAYER_SIZE),
  bold: normalizeMetrics(STYLE_JSONS.bold, ATLAS_LAYER_SIZE),
  italic: normalizeMetrics(STYLE_JSONS.italic, ATLAS_LAYER_SIZE),
  'bold-italic': normalizeMetrics(STYLE_JSONS['bold-italic'], ATLAS_LAYER_SIZE),
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

// MSDFFontBook/device involved (see FontAtlas.ts) - built off the SAME JSON as `fonts` above, so
// the two must resolve identically. ---
it('msdfFontProvider: the GPU-free FontProvider a scene can measure text with, with no', () => {
    const provider = msdfFontProvider(STYLES)

    const bold = provider.resolve('bold')
    assert(bold.atlasIndex === STYLE_ORDER.indexOf('bold'), "resolving 'bold' returns bold's atlas index")
    assert(!bold.fauxBold && !bold.fauxItalic, 'an exact style match needs no synthesis (all four were supplied)')
    assert(bold.metrics.glyphs.size === METRICS.bold.glyphs.size, "msdfFontProvider's metrics match MSDFFontBook's own normalization")

    // A partial set is the common case for an application that ships one face: the ladder
    // synthesizes every other style off the one that is there.
    const regularOnlyProvider = msdfFontProvider([{ style: 'regular', json: STYLE_JSONS.regular }])
    const synthesized = regularOnlyProvider.resolve('bold-italic')
    assert(synthesized.atlasIndex === 0, 'a set of only regular resolves every style onto layer 0')
    assert(synthesized.fauxBold && synthesized.fauxItalic, 'and flags both faux bold and faux italic')

    // The empty set is what a renderer created without `fonts` holds. Measuring against it is a
    // loud error, not a silent zero-size layout.
    let threw = false
    try {
      msdfFontProvider([]).resolve('regular')
    } catch {
      threw = true
    }
    assert(threw, 'an empty set resolves nothing at all and throws rather than measuring against zero')

    const shaped = layoutText([run('Measured before any device exists', { fontSize: 20 })], { maxWidth: 140 }, provider)
    assert(shaped.lineCount > 1 && shaped.height > 0, 'the shaper runs against it exactly like any other FontProvider')
})

it('metrics: uv rects normalized into [0,1], sane advances, kerning present', () => {
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
})

//
// Two MSDFText nodes can be different typefaces. A node names a family, the library resolves it,
// and the two mechanisms that has to get right are: an unknown name falls back rather than
// failing (so a node built before its atlas lands still draws), and changing ONE node's family
// re-shapes that node and no other - which is the whole reason it goes through
// invalidateShaping() rather than the font epoch.
it('an MSDFText node draws in its own family, and changing it re-shapes only that node', () => {
    // Two families with genuinely different advances, so "which family" is measurable.
    const families: Record<string, MsdfFontJson> = { serif: STYLE_JSONS.regular, slab: STYLE_JSONS.bold }
    const library = {
      resolveFamily: (name: string | undefined) => msdfFontProvider([{ style: 'regular', json: families[name ?? ''] ?? families.serif }]),
    }

    const a = new MSDFText({ text: 'Hamburgefonstiv', style: { fontSize: 40 } })
    const b = new MSDFText({ text: 'Hamburgefonstiv', style: { fontSize: 40 }, fontFamily: 'slab' })
    assert(a.fontFamily === undefined && b.fontFamily === 'slab', 'a node carries its own family')

    const shapeIt = (t: MSDFText) => t.shaped(library.resolveFamily(t.fontFamily))
    const aWide = shapeIt(a).width
    assert(shapeIt(b).width !== aWide, 'two nodes in different families measure differently')

    // An unknown family is not an error: it resolves to the default and draws.
    const missing = new MSDFText({ text: 'Hamburgefonstiv', style: { fontSize: 40 }, fontFamily: 'never-loaded' })
    assert(shapeIt(missing).width === aWide, 'an unloaded family falls back to the default rather than failing')

    // The precise-invalidation claim: switching one node's family drops ITS cache and leaves
    // every other node's alone. If this went through the font epoch, `untouched` would be a
    // different object afterwards.
    const untouchedBefore = shapeIt(a)
    b.fontFamily = undefined
    assert(shapeIt(b).width === aWide, 'the node that changed re-shapes into its new family')
    assert(shapeIt(a) === untouchedBefore, 'and every other node keeps the layout it already had')
})

//
// Loading an atlas at runtime (handle.setMSDFFonts) changes the metrics under every MSDFText at once,
// and MSDFText.shaped() memoizes its layout while ignoring the provider it was handed. Without the
// font epoch the lane would repack from those stale caches: the right glyphs at the old
// advances and the old wrap points, which is the kind of wrong that looks almost right.
it('replacing the fonts re-shapes text that had already been laid out', () => {
    const wide = msdfFontProvider([{ style: 'regular', json: STYLE_JSONS.regular }])
    // Bold is a genuinely different set of advances, so a stale layout is measurably stale.
    const narrow = msdfFontProvider([{ style: 'regular', json: STYLE_JSONS.bold }])

    const node = new MSDFText({ text: 'Hamburgefonstiv', style: { fontSize: 40 } })
    const before = node.shaped(wide)
    assert(node.shaped(wide) === before, 'the layout is memoized - shaping twice returns the same object')

    // What MSDFFontBook.setMSDFFonts does, minus the GPU half.
    bumpFontEpoch()

    const after = node.shaped(narrow)
    assert(after !== before, 'a new atlas set drops the cache rather than handing back the old layout')
    assert(after.width !== before.width, 'and the text is re-measured against the new metrics')

    assert(node.shaped(narrow) === after, 'then memoizes again until something else changes')
})

//
// An application supplies its own atlases (createSceneRenderer's `fonts`), and it need not
// supply four. What makes a partial set work is that a style's STYLE_ORDER index IS its texture
// array layer: a set is placed by style, not packed tight, so the gaps are what the ladder then
// falls through. Both font books do exactly this, and neither can be exercised without a
// device - the arithmetic they share is here.
it('a partial atlas set: styles land on their own layers, and the ladder covers the gaps', () => {
    // Bold alone - the awkward case, because the ladder's last resort used to be 'regular' and
    // there is no regular here to fall back onto.
    const boldOnly = msdfFontProvider([{ style: 'bold', json: STYLE_JSONS.bold }])

    const asBold = boldOnly.resolve('bold')
    assert(asBold.atlasIndex === 1, "bold sits on layer 1, its STYLE_ORDER index - not layer 0 because it happens to be first")
    assert(!asBold.fauxBold && !asBold.fauxItalic, 'and needs nothing synthesized')

    const asRegular = boldOnly.resolve('regular')
    assert(asRegular.atlasIndex === 1, 'regular resolves to the one face there is')
    assert(!asRegular.fauxBold, 'nothing is emboldened - regular was asked for')
    const asItalic = boldOnly.resolve('bold-italic')
    assert(asItalic.atlasIndex === 1 && asItalic.fauxItalic && !asItalic.fauxBold, 'bold-italic is that face sheared')

    // Two styles, non-adjacent, so a set placed by position rather than by style would put
    // bold-italic on layer 1 and every bold run would draw italic glyphs.
    const pair = msdfFontProvider([
      { style: 'regular', json: STYLE_JSONS.regular },
      { style: 'bold-italic', json: STYLE_JSONS['bold-italic'] },
    ])
    assert(pair.resolve('regular').atlasIndex === 0, 'regular on layer 0')
    assert(pair.resolve('bold-italic').atlasIndex === 3, 'bold-italic on layer 3, not layer 1')
    const fauxBold = pair.resolve('bold')
    assert(fauxBold.atlasIndex === 0 && fauxBold.fauxBold, 'bold falls back to regular, emboldened')

    // The layer size follows the set it was given and nothing else: one style's atlas is its own
    // size, and metrics normalized against it must say so or every uv is scaled wrong.
    const single = msdfFontProvider([{ style: 'italic', json: STYLE_JSONS.italic }])
    const metrics = single.resolve('italic').metrics
    assert(
      metrics.atlasWidth === STYLE_JSONS.italic.common.scaleW &&
        metrics.atlasHeight === STYLE_JSONS.italic.common.scaleH,
      'a one-style set sizes its layer to that style, not to the largest of the four',
    )
})

//
// Array layers must be identically sized, so each style's own (smaller) packed image is copied
// into the top-left of a layer sized for the largest, and uvs are measured against the LAYER.
// Getting that wrong would sample the neighbouring style's glyphs, which is exactly the sort of
// thing that looks almost right on screen.
it('the shared atlas layer: all four styles in one texture, so all four draw in one call', () => {
    const sizes = STYLE_ORDER.map((s) => STYLE_JSONS[s].common)
    assert(
      ATLAS_LAYER_SIZE.width === Math.max(...sizes.map((c) => c.scaleW)) &&
        ATLAS_LAYER_SIZE.height === Math.max(...sizes.map((c) => c.scaleH)),
      'the layer is sized for the largest style, so every image fits',
    )
    assert(
      sizes.some((c) => c.scaleW !== ATLAS_LAYER_SIZE.width || c.scaleH !== ATLAS_LAYER_SIZE.height),
      'and the styles really do differ in size - otherwise this test proves nothing',
    )

    for (const style of STYLE_ORDER) {
      const json = STYLE_JSONS[style]
      const metrics = METRICS[style]
      assert(
        metrics.atlasWidth === ATLAS_LAYER_SIZE.width && metrics.atlasHeight === ATLAS_LAYER_SIZE.height,
        `${style}: metrics report the layer size, which is what the shader divides distanceRange by`,
      )
      // Every uv stays inside the region actually copied into the layer - never out in the
      // transparent remainder, and never past 1.
      const maxU = json.common.scaleW / ATLAS_LAYER_SIZE.width
      const maxV = json.common.scaleH / ATLAS_LAYER_SIZE.height
      const strays = [...metrics.glyphs.values()].filter(
        (g) => !(g.u0 >= 0 && g.v0 >= 0 && g.u1 <= maxU && g.v1 <= maxV),
      )
      assert(strays.length === 0, `${style}: every glyph's uv rect lies within the copied image, not the padding`)
    }

    // A glyph's uv rect must cover the same TEXELS it did before the styles were pooled - the
    // pixel rect from the JSON. Normalizing against a bigger layer changes the numbers and must
    // not change which texels they address.
    const boldA = METRICS.bold.glyphs.get(65)!
    const rawA = (STYLE_JSONS.bold.chars as { id: number; x: number; y: number; width: number }[]).find((c) => c.id === 65)!
    assert(
      Math.abs(boldA.u0 * ATLAS_LAYER_SIZE.width - rawA.x) < 1e-6 &&
        Math.abs(boldA.u1 * ATLAS_LAYER_SIZE.width - (rawA.x + rawA.width)) < 1e-6,
      "bold 'A' still addresses exactly the pixel column range the generator packed it into",
    )
})

it('shaping: one glyph quad per visible char, one material per run, left-to-right order', () => {
    const shaped = layoutText([run('AV', { fontSize: 40 })], {}, fonts)
    const glyphQuads = shaped.quads.filter((q) => q.isGlyph)
    assert(glyphQuads.length === 2, "'AV' emits two glyph quads")
    assert(shaped.materials.length === 1, 'a single run yields a single material')
    assert(shaped.materials[0].fillPriority === 'color', 'a plain run is a solid-color material')
    assert(glyphQuads[0].x0 < glyphQuads[1].x0, 'glyphs are placed left to right')
    assert(shaped.quads.every((q) => finite(q.x0) && finite(q.y0) && finite(q.x1) && finite(q.y1)), 'no NaN coords')
    assert(glyphQuads.every((q) => q.u1 > q.u0 && q.v1 > q.v0), 'glyph quads carry a real uv rect')
})

it('kerning: a negative pair (Inter kerns \'"4\' tighter) pulls the second glyph leftward', () => {
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
})

it('word wrap: a narrow maxWidth splits into multiple lines; wider fits on one', () => {
    const text = 'wrap wrap wrap wrap wrap'
    const narrow = layoutText([run(text, { fontSize: 24 })], { maxWidth: 90 }, fonts)
    const wide = layoutText([run(text, { fontSize: 24 })], { maxWidth: 100000 }, fonts)
    assert(narrow.lineCount > 1, 'a narrow max width wraps to multiple lines')
    assert(wide.lineCount === 1, 'a very wide max width stays on one line')
    assert(narrow.height > wide.height, 'more lines means a taller block')
})

it('hard breaks: \'\\n\' forces a new line, and later lines sit lower (smaller y)', () => {
    const shaped = layoutText([run('a\nb', { fontSize: 30 })], {}, fonts)
    const glyphQuads = shaped.quads.filter((q) => q.isGlyph)
    assert(shaped.lineCount === 2, "'\\n' forces a second line")
    assert(glyphQuads.length === 2, 'two glyphs across the two lines')
    assert(glyphQuads[1].y1 > glyphQuads[0].y1, 'the second line is below the first (y-down)')
})

it('alignment: right/center shift the first glyph rightward vs. left alignment', () => {
    const opts = { maxWidth: 400 }
    const left = layoutText([run('abc', { fontSize: 28 })], { ...opts, align: 'left' }, fonts)
    const center = layoutText([run('abc', { fontSize: 28 })], { ...opts, align: 'center' }, fonts)
    const right = layoutText([run('abc', { fontSize: 28 })], { ...opts, align: 'right' }, fonts)
    const first = (s: typeof left) => s.quads.filter((q) => q.isGlyph)[0].x0
    assert(first(left) < first(center) && first(center) < first(right), 'left < center < right first-glyph x')
    assert(first(right) > 200, 'right alignment pushes text to the far side of the block')
})

it('decorations: underline, strikethrough, and highlight add non-glyph quads', () => {
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
})

it('materials: gradient and stroke runs produce the right material records', () => {
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
})

it('letter spacing widens a run\'s advance', () => {
    const tight = layoutText([run('mmm', { fontSize: 30 })], {}, fonts)
    const loose = layoutText([run('mmm', { fontSize: 30, letterSpacing: 8 })], {}, fonts)
    assert(loose.width > tight.width, 'letter spacing widens the laid-out block')
})

it('baseline shift raises a superscript run and lowers a subscript run', () => {
    const base = layoutText([run('x', { fontSize: 30 })], {}, fonts).quads.filter((q) => q.isGlyph)[0]
    const sup = layoutText([run('x', { fontSize: 30, baselineShift: 12 })], {}, fonts).quads.filter((q) => q.isGlyph)[0]
    const sub = layoutText([run('x', { fontSize: 30, baselineShift: -12 })], {}, fonts).quads.filter((q) => q.isGlyph)[0]
    assert(sup.y1 < base.y1 && sub.y1 > base.y1, 'superscript sits above the baseline (smaller y), subscript below')
})

it('justify: a wrapped (non-final) line stretches to fill the max width', () => {
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
})

it('faux bold / italic: synthesized from the regular-only provider and via explicit flags', () => {
    const fauxBold = layoutText([run('B', { fontStyle: 'bold', fontSize: 40 })], {}, regularOnly)
    assert(fauxBold.materials[0].dilate > 0, 'a missing bold style is synthesized with coverage dilation')

    const fauxItalic = layoutText([run('I', { fontStyle: 'italic', fontSize: 40 })], {}, regularOnly)
    // The shear slides x per unit of y about the baseline; an ascender is at SMALLER y, so a
    // rightward lean is a NEGATIVE slope. See FAUX_ITALIC_SKEW.
    assert(fauxItalic.quads.filter((q) => q.isGlyph)[0].skew < 0, 'a missing italic style is synthesized with shear')

    // Explicit flags synthesize on top of a present atlas (e.g. faux bold-italic from italic).
    const explicit = layoutText([run('x', { fontStyle: 'italic', fontSize: 40, fauxBold: true, fauxItalic: true })], {}, fonts)
    assert(explicit.materials[0].dilate > 0, 'fauxBold flag adds dilation')
    assert(explicit.quads.filter((q) => q.isGlyph)[0].skew < 0, 'fauxItalic flag adds shear')
})

it('drop shadow + soft glow: extra materials and extra glyph quads behind the body', () => {
    const plain = layoutText([run('g', { fontSize: 40 })], {}, fonts)
    assert(plain.quads.filter((q) => q.isGlyph).length === 1, 'a plain glyph emits one quad')
    assert(plain.materials.length === 1, 'a plain run has one material')
    const plainQuad = plain.quads.find((q) => q.isGlyph)!

    const shadowed = layoutText([run('g', { fontSize: 40, shadow: { color: [0, 0, 0, 0.5], offsetX: 3, offsetY: 3 } })], {}, fonts)
    assert(shadowed.materials.length === 2, 'a shadow adds a second material')
    assert(shadowed.quads.filter((q) => q.isGlyph).length === 2, 'the shadow adds a second glyph quad')

    // MSDFText's shadow is a plain duplicate of the glyphs - no blur, so it adds no coverage
    // dilation of its own (unlike the glow below). That is the whole point of the text
    // model: a crisp offset copy, not a rasterized-and-blurred silhouette.
    const shadowMaterial = shadowed.materials[shadowed.materials.length - 1]
    assert(shadowMaterial.dilate === 0, "a text shadow doesn't dilate coverage - it's a duplicate, not a blur")

    // offsetY is downward-positive, matching Shape's shadowOffsetY, which is the direction +y
    // already points here.
    const shadowQuad = shadowed.quads.find((q) => q.isGlyph && q.material === 1)!
    assert(Math.abs(shadowQuad.x0 - (plainQuad.x0 + 3)) < 1e-6, 'shadow offsetX shifts the duplicate right')
    assert(Math.abs(shadowQuad.y0 - (plainQuad.y0 + 3)) < 1e-6, 'shadow offsetY is downward-positive')

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
})

it('rtl: right-to-left flow reverses visual glyph order (first char lands rightmost)', () => {
    const ltr = layoutText([run('AB', { fontSize: 40 })], { maxWidth: 400 }, fonts).quads.filter((q) => q.isGlyph)
    const rtl = layoutText([run('AB', { fontSize: 40 })], { maxWidth: 400, direction: 'rtl' }, fonts).quads.filter((q) => q.isGlyph)
    // Under LTR the first emitted glyph (A) is left of B; under RTL A is placed to the right of B.
    assert(ltr[0].x0 < ltr[1].x0, 'LTR places A left of B')
    assert(rtl.find((q) => q.x0 === Math.max(...rtl.map((r) => r.x0))) !== undefined, 'RTL produced placed glyphs')
    const rtlByX = [...rtl].sort((a, b) => a.x0 - b.x0)
    assert(rtlByX.length === 2, 'RTL emits both glyphs')
})

it('vertical: glyphs stack downward, later columns sit to the left', () => {
    const v = layoutText([run('ab\ncd', { fontSize: 40 })], { orientation: 'vertical' }, fonts)
    const g = v.quads.filter((q) => q.isGlyph) // emitted column-by-column, top-to-bottom: a,b,c,d
    assert(v.lineCount === 2, 'a vertical block splits into columns on newline')
    assert(g.length === 4, 'four glyphs across two columns')
    assert(g[1].y1 > g[0].y1, 'vertical glyphs stack top-to-bottom within a column')
    assert(g[2].x0 < g[0].x0, 'later columns sit to the left of earlier ones')
})

const vectorFonts = new PolygonFontBook([
  { style: 'regular', json: regularPolygons as unknown as PolygonFontJson },
  { style: 'bold', json: boldPolygons as unknown as PolygonFontJson },
  { style: 'italic', json: italicPolygons as unknown as PolygonFontJson },
  { style: 'bold-italic', json: boldItalicPolygons as unknown as PolygonFontJson },
])
const regularVector = vectorFonts.fontByIndex(0)!

// A font reaches the engine by being registered under a name - there is no way to hand a book to
// a node. So the suite registers the outlines it just built and every VectorText below names it,
// which is also the only exercise registerFontFamily() gets.
const VECTOR_FAMILY = 'test-outlines'
registerFontFamily(VECTOR_FAMILY, { vector: vectorFonts })

it('the atlas is in font units, and its vertical metrics are coherent', () => {
    const m = regularVector.metrics
    assert(m.size === regularVector.unitsPerEm, 'metrics are expressed in font units, so size is unitsPerEm')
    assert(m.base > 0 && m.lineHeight > m.base, 'ascent is positive and a line is taller than its ascent')

    // The decoration metrics reach the two paths through completely different tools - the MSDF
    // atlas via msdf-bmfont-xml, the polygon atlas via opentype.js - and are em fractions in
    // both, so they must agree. If they ever don't, a decoration is drawn in two places.
    const d = m.decoration
    const reference = METRICS.regular.decoration
    assert(Math.abs(d.underlineOffset - reference.underlineOffset) < 1e-6, 'underline offset matches the atlas metrics')
    assert(Math.abs(d.underlineThickness - reference.underlineThickness) < 1e-6, 'underline thickness matches the atlas metrics')
    assert(Math.abs(d.strikeOffset - reference.strikeOffset) < 1e-6, 'strike offset matches the atlas metrics')
    assert(Math.abs(d.strikeThickness - reference.strikeThickness) < 1e-6, 'strike thickness matches the atlas metrics')
})

it('an atlas arrives measured: every glyph in the charset, no parsing, no on-demand step', () => {
    // Whatever charset the atlas was generated over arrives complete, rather than a glyph at a
    // time as something asks for it. The count is the generator's business (see
    // packages/scripts/textgen/charset.ts); what this pins is that reading the file is the whole
    // of the work, and that the set reaches past ASCII into the accented letters.
    const glyphs = regularVector.metrics.glyphs
    assert(glyphs.size > 95, 'the file arrives measured, and covers more than printable ASCII')
    assert(glyphs.has(65) && glyphs.has(111) && glyphs.has(32), 'A, o and space among them')
    for (const char of ['å', 'ä', 'ö', 'ß']) {
      assert(glyphs.has(char.codePointAt(0)!), `'${char}' among them too, with no parsing step`)
    }

    // A blank glyph has no box but still advances the pen - otherwise spaces would collapse.
    const space = glyphs.get(32)!
    assert(space.width === 0 && space.height === 0, 'space has no outline extents')
    assert(space.xadvance > 0, 'space still advances')

    // Advances must agree with the MSDF metrics once both are scaled to the same em.
    const a = glyphs.get(65)!
    const reference = METRICS.regular.glyphs.get(65)!
    const mine = a.xadvance / regularVector.metrics.size
    const theirs = reference.xadvance / METRICS.regular.size
    assert(Math.abs(mine - theirs) < 0.01, "A's advance matches the atlas metrics (per em)")

    // Outside the charset there is simply nothing, which is what makes the shaper space it -
    // exactly as the MSDF path treats a character outside its own generated charset.
    assert(!glyphs.has(0x1f600), 'a code point outside the charset stays absent rather than becoming tofu')
    assert(regularVector.mesh(0x1f600) === undefined, 'and has no mesh')

    // ensure() exists so an atlas book and a parsing one are interchangeable; here it is a no-op
    // rather than a measurement step, and must not disturb what is already measured.
    const measured = regularVector.metrics.glyphs.size
    regularVector.ensure('anything at all, including \u{1F600}')
    assert(regularVector.metrics.glyphs.size === measured, 'ensure() on an atlas-backed font changes nothing')
})

it('kerning came out of the font\'s GPOS table and matches what the MSDF generator found', () => {
    const pair = (regularJson as unknown as MsdfFontJson).kernings.find((k) => k.amount !== 0)!
    const mine = kerningFor(regularVector.metrics, pair.first, pair.second) / regularVector.metrics.size
    assert(mine !== 0, 'the pair the MSDF generator kerns is kerned here too')
    // The MSDF atlas stores kerning as whole pixels at its 42px generation size, so the two
    // agree only up to that quantization - compare on the atlas's own grid rather than in em.
    assert(Math.abs(mine * METRICS.regular.size - pair.amount) <= 0.75, 'the kerning amount matches the atlas metrics, up to its pixel rounding')
})

it('glyph meshes: rings on demand, triangulated once, cached', () => {
    const o = regularVector.mesh(111)!
    assert(o.contours.length === 2, "'o' has an outer ring and a counter")
    assert(o.vertices.length > 0 && o.indices.length % 3 === 0, 'the counter is triangulated into whole triangles')
    assert(regularVector.mesh(111) === o, 'a glyph mesh is built once and cached')
    assert(o.contours.every((c) => c.closed && c.points.length >= 3), 'every ring is closed and enclosable')

    const i = regularVector.mesh(73)!
    assert(i.contours.length === 1, "'I' is a single ring")

    // Whitespace resolves to a real glyph with no outline - not a miss, which would make the
    // shaper fall back to a space's advance instead of using the space's own.
    const space = regularVector.mesh(32)!
    assert(space.contours.length === 0 && space.vertices.length === 0, 'space has a mesh with no geometry')
})

it('the same shaper, driven by outlines instead of an atlas', () => {
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
    assert(glyph.originY > glyph.y0, 'the pen origin sits below the top of the glyph box')
})

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

it('VectorText tessellates into the mesh lane, one material per (run feature, colour)', () => {
    const red: RGBA = [1, 0, 0, 1]
    const blue: RGBA = [0, 0, 1, 1]
    const node = new VectorText({
      fontFamily: VECTOR_FAMILY,
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
})

it('decorations, highlights and outlines are separate materials and separate geometry', () => {
    const plain = new VectorText({ fontFamily: VECTOR_FAMILY, text: 'Hi', style: { fontSize: 40 } })
    const decorated = new VectorText({
      fontFamily: VECTOR_FAMILY,
      text: 'Hi',
      style: { fontSize: 40, underline: true, highlight: [1, 1, 0, 1] },
    })
    assert(decorated.materials().length > plain.materials().length, 'a highlight is painted separately from the glyphs')
    assert(recordGeometry(decorated).verts.length > recordGeometry(plain).verts.length, 'decorations add geometry')

    // A per-letter outline is stroke geometry, so it takes the material's stroke colour
    // rather than its fill - exactly like a stroked Rect or Path.
    const outlined = new VectorText({
      fontFamily: VECTOR_FAMILY,
      text: 'Hi',
      style: { fontSize: 40, strokeColor: [0, 0, 0, 1], strokeWidth: 2 },
    })
    const outlinedVerts = recordGeometry(outlined).verts
    assert(outlinedVerts.some((v) => !v.isFill), 'the outline emits stroke vertices')
    assert(recordGeometry(plain).verts.every((v) => v.isFill), 'an unoutlined run emits only fill vertices')

    // Round joins are VectorText's default because letterforms have far sharper corners than
    // the shapes the miter default was chosen for - a stroked apex grows a spike well past the
    // glyph at any appreciable stroke width.
    //
    // Which letter shows it is a property of the typeface, not of the join: whether the peak of
    // an A or the corners of a Z come to a point depends on how that cut builds its outlines, and
    // a face whose apexes are flattened spikes somewhere else instead. So this asks a set of
    // sharp-cornered capitals for one that does, rather than naming a letter the font in the
    // folder happens to draw sharply today.
    const spiky = (text: string) => ({ text, style: { fontSize: 60, strokeColor: [0, 0, 0, 1] as RGBA, strokeWidth: 16 } })
    const height = (shape: VectorText) => shape.localBounds().max.y - shape.localBounds().min.y
    const spikes = (text: string) =>
      height(new VectorText({ fontFamily: VECTOR_FAMILY, lineJoin: 'miter', ...spiky(text) })) >
      height(new VectorText({ fontFamily: VECTOR_FAMILY, ...spiky(text) })) * 1.15

    assert(new VectorText({ fontFamily: VECTOR_FAMILY, ...spiky('AWM') }).lineJoin === 'round', 'VectorText defaults to round joins')
    assert(['A', 'W', 'M', 'V', 'X', 'Z', 'K'].some(spikes), 'miter joins spike far past the letterforms')
    assert(new VectorText({ fontFamily: VECTOR_FAMILY, lineJoin: 'bevel', ...spiky('A') }).lineJoin === 'bevel', 'an explicit join still wins')

    // Faux bold thickens the letterform, so its ring must take the FILL colour (and any
    // gradient), not the stroke slot - which a real outline may be using at the same time.
    const bolded = new VectorText({ fontFamily: VECTOR_FAMILY, text: 'Hi', style: { fontSize: 40, fauxBold: true } })
    const boldedVerts = recordGeometry(bolded).verts
    assert(boldedVerts.length > recordGeometry(plain).verts.length, 'faux bold adds a dilation ring')
    assert(boldedVerts.every((v) => v.isFill), 'the dilation ring is fill geometry, leaving the stroke slot free')
})

it('being mesh geometry is the point: picking and bounds come for free', () => {
    const node = new VectorText({
      fontFamily: VECTOR_FAMILY,
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
      fontFamily: VECTOR_FAMILY,
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
})

// Alignment, baseline shift and vertical flow are all the shared shaper's work, and the
// blocks above already check them there. What is new on this path is that the outlines
// follow: a glyph is placed from the pen origin the shaper recorded, and vertical text in
// particular reaches makeGlyphQuad by a different route than horizontal text does. These
// assertions therefore measure tessellated vertices, not quads.
it('block layout reaches the GEOMETRY, not just the shaped quads', () => {
    const boundsOf = (shape: VectorText) => {
      const { verts } = recordGeometry(shape)
      const xs = verts.map((v) => v.x)
      const ys = verts.map((v) => v.y)
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
    }

    // Baseline shift moves a run's outline by exactly the shift, and nothing else with it.
    const plain = new VectorText({ fontFamily: VECTOR_FAMILY, runs: [{ text: 'x', style: { fontSize: 40 } }] })
    const raised = new VectorText({ fontFamily: VECTOR_FAMILY, runs: [{ text: 'x', style: { fontSize: 40, baselineShift: 15 } }] })
    const lowered = new VectorText({ fontFamily: VECTOR_FAMILY, runs: [{ text: 'x', style: { fontSize: 40, baselineShift: -15 } }] })
    assert(Math.abs(boundsOf(raised).y0 - (boundsOf(plain).y0 - 15)) < 1e-6, 'a positive baseline shift lifts the outline by exactly that much')
    assert(Math.abs(boundsOf(lowered).y0 - (boundsOf(plain).y0 + 15)) < 1e-6, 'a negative baseline shift drops it')
    assert(Math.abs(boundsOf(raised).x0 - boundsOf(plain).x0) < 1e-6, 'and moves it vertically only')

    // A superscript run rides above its neighbour without disturbing the pen.
    const superscript = new VectorText({
      fontFamily: VECTOR_FAMILY,
      runs: [
        { text: 'x', style: { fontSize: 40 } },
        { text: '2', style: { fontSize: 24, baselineShift: 16 } },
      ],
    })
    const glyphs = superscript.shaped().quads.filter((q) => q.isGlyph)
    assert(glyphs.length === 2, 'both runs contribute a glyph')
    assert(glyphs[1].originY < glyphs[0].originY, 'the shifted run sits above (at a smaller y than) the baseline of the one before it')
    assert(glyphs[1].originX > glyphs[0].originX, 'and after it, so the shift is vertical only')

    // Alignment offsets the geometry within the block; justify stretches to fill it.
    const wrapped = 'align this text so it wraps'
    const aligned = (align: 'left' | 'center' | 'right' | 'justify') =>
      boundsOf(new VectorText({ fontFamily: VECTOR_FAMILY, text: wrapped, style: { fontSize: 20 }, maxWidth: 200, align }))
    const left = aligned('left')
    const center = aligned('center')
    const right = aligned('right')
    const justify = aligned('justify')
    assert(left.x0 < center.x0 && center.x0 < right.x0, 'left < center < right, measured on the tessellated glyphs')
    assert(right.x1 - left.x1 > 20, 'right alignment pushes the ink to the far edge of the block')
    assert(justify.x1 - justify.x0 > left.x1 - left.x0, 'justification widens the block by spreading the spaces')
    assert(justify.x1 <= 200 + 1e-6, 'and stops at the wrap width')

    // Vertical flow: glyphs stack downward, and columns advance to the LEFT.
    const vertical = new VectorText({ fontFamily: VECTOR_FAMILY, text: 'AB\nCD', style: { fontSize: 40 }, orientation: 'vertical' })
    const horizontal = new VectorText({ fontFamily: VECTOR_FAMILY, text: 'AB\nCD', style: { fontSize: 40 } })
    assert(vertical.shaped().lineCount === 2, 'a newline starts a second column')
    assert(recordGeometry(vertical).verts.length === recordGeometry(horizontal).verts.length, 'the same four glyphs are tessellated either way')
    const columnQuads = vertical.shaped().quads.filter((q) => q.isGlyph)
    assert(columnQuads[1].originY > columnQuads[0].originY, 'glyphs stack top-to-bottom within a column')
    assert(columnQuads[2].originX < columnQuads[0].originX, 'the second column sits to the left of the first')
    assert(boundsOf(vertical).x1 <= 0, 'the block extends leftward from its origin')

    // One run, one column: set vertically it is a tall narrow strip, set horizontally a wide
    // short one. (The two-column node above is NOT the comparison to make - two columns of two
    // glyphs and two lines of two glyphs happen to occupy almost the same box.)
    const strip = boundsOf(new VectorText({ fontFamily: VECTOR_FAMILY, text: 'ABCD', style: { fontSize: 40 }, orientation: 'vertical' }))
    const line = boundsOf(new VectorText({ fontFamily: VECTOR_FAMILY, text: 'ABCD', style: { fontSize: 40 } }))
    assert(strip.y1 - strip.y0 > 2 * (line.y1 - line.y0), 'a single column is far taller than the same text on a line')
    assert(strip.x1 - strip.x0 < line.x1 - line.x0, 'and far narrower')
})

//
// The precise handle on a bent glyph is the midpoint of its baseline: that is the point the
// bend maps onto the curve, and the rotation happens about it, so it must land exactly on
// the curve however the glyph is turned.
type BentQuad = ReturnType<typeof layoutText>['quads'][number]
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
const baselineMidpoint = (q: BentQuad) => quadCorner(q, (q.x0 + q.x1) / 2, q.originY)
/** Distance from the origin, which the circle examples below put their centre at. */
const radiusOf = (p: Vector2Like) => Math.hypot(p.x, p.y)

it('the curve itself: distance in, position and direction out', () => {
    const line = TextPathGeometry.fromPoints([
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 40 },
    ])
    assert(line.length === 70, 'length is the sum of the segments')
    assert(!line.closed, 'a path is open unless it says otherwise')

    const start = line.sampleAt(0)
    assert(start !== null && start.x === 0 && start.y === 0, 'distance 0 is the first point')
    const corner = line.sampleAt(30)
    assert(corner !== null && corner.x === 30 && corner.y === 0, 'distance lands exactly on a joint')
    const mid = line.sampleAt(15)
    assert(mid !== null && mid.x === 15 && near(mid.angle, 0), 'the first leg runs along +x')
    const up = line.sampleAt(50)
    assert(up !== null && up.x === 30 && up.y === 20 && near(up.angle, Math.PI / 2), 'the second leg turns to +y')

    assert(line.sampleAt(-1) === null && line.sampleAt(71) === null, 'an open path has nothing past its ends')
    assert(line.sampleAt(70) !== null, 'but its far end is on it')

    // Repeated points carry no direction, so they are dropped rather than yielding NaN angles.
    const dupes = TextPathGeometry.fromPoints([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ])
    assert(dupes.length === 10, 'a repeated point adds no length')
    assert(Number.isFinite(dupes.sampleAt(5)!.angle), 'and leaves the direction defined')

    let threw = false
    try {
      TextPathGeometry.fromPoints([{ x: 1, y: 1 }])
    } catch {
      threw = true
    }
    assert(threw, 'a single point is not a path')
})

it('direction is smooth along a flattened curve, but not through a real corner', () => {
    // A flattened circle turns in steps of one segment. Sampled closely, the direction must
    // change gradually rather than jumping a whole segment's worth at each joint - otherwise
    // consecutive glyphs stair-step round the circle instead of turning evenly.
    const circle = circlePath(115)
    const step = circle.length / 400
    let biggestJump = 0
    let previous = circle.sampleAt(0)!.angle
    for (let d = step; d <= circle.length; d += step) {
      const angle = circle.sampleAt(d)!.angle
      let delta = angle - previous
      while (delta > Math.PI) delta -= Math.PI * 2
      while (delta < -Math.PI) delta += Math.PI * 2
      biggestJump = Math.max(biggestJump, Math.abs(delta))
      previous = angle
    }
    // Turning evenly, 1/400th of a circle is 0.0157 rad; a segment-at-a-time would be ~0.13.
    assert(biggestJump < 0.03, `the direction turns evenly round a flattened circle (largest step ${biggestJump.toFixed(4)} rad)`)

    // A right angle is a corner of the path, not an artefact of flattening, so it is NOT
    // smoothed away: each leg keeps its own direction all the way to the corner.
    const bend = TextPathGeometry.fromPoints([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
    ])
    assert(near(bend.sampleAt(39)!.angle, 0), 'the first leg runs straight up to the corner')
    assert(near(bend.sampleAt(41)!.angle, Math.PI / 2), 'and the second starts turned, with no lean-in between')
})

it('closed curves wrap instead of ending', () => {
    const square = TextPathGeometry.fromPoints(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      true,
    )
    assert(square.length === 40, 'closing the path adds the segment back to the start')
    const wrapped = square.sampleAt(45)!
    const same = square.sampleAt(5)!
    assert(wrapped.x === same.x && wrapped.y === same.y, 'past the end comes round to the beginning')
    const negative = square.sampleAt(-5)!
    const equivalent = square.sampleAt(35)!
    assert(negative.x === equivalent.x && negative.y === equivalent.y, 'and before the start comes round from the end')
})

it('reversing runs the same shape the other way', () => {
    const line = TextPathGeometry.fromPoints([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ])
    const back = line.reversed()
    assert(back.length === line.length, 'reversing keeps the length')
    assert(back.sampleAt(0)!.x === 10, 'distance 0 is what was the far end')
    assert(near(Math.abs(back.sampleAt(5)!.angle), Math.PI), 'and the direction is opposite')
})

it('arcs and circles', () => {
    const quarter = arcPath(100, 0, Math.PI / 2)
    assert(Math.abs(quarter.length - (Math.PI / 2) * 100) < 0.5, "a quarter arc's length is r * sweep")
    assert(!quarter.closed, 'an arc is open')
    const at0 = quarter.sampleAt(0)!
    assert(near(at0.x, 100) && near(at0.y, 0, 1e-9), 'it starts at its start angle')

    // Flattening is driven by the tolerance, so a bigger circle gets more segments, not coarser
    // corners: the sampled points stay on the true circle either way.
    for (const radius of [20, 400]) {
      const circle = circlePath(radius)
      for (let d = 0; d < circle.length; d += circle.length / 37) {
        assert(Math.abs(radiusOf(circle.sampleAt(d)!) - radius) < 0.3, `r=${radius}: every sample is on the circle`)
      }
    }

    const circle = circlePath(200)
    assert(circle.closed, 'a circle is closed')
    assert(Math.abs(circle.length - 2 * Math.PI * 200) < 1, "its length is the circle's circumference")

    // The default arrangement is the one that reads across the top with the letters standing
    // up off the outside: distance 0 at the top, running towards +x, normal pointing outward.
    const top = circle.sampleAt(0)!
    assert(near(top.x, 0, 1e-9) && near(top.y, -200), 'distance 0 is the top of the circle')
    assert(Math.abs(top.angle) < 0.05, 'where the curve runs left to right')
    const normalY = Math.cos(top.angle)
    assert(normalY > 0, "so a glyph's up direction points away from the centre")

    const other = circlePath(200, { clockwise: false })
    assert(Math.cos(other.sampleAt(0)!.angle) < 0, 'run the other way, the same point hangs text inside')
})

it('glyphs land on the curve', () => {
    const radius = 220
    const shaped = layoutText([run('CURVED TEXT', { fontSize: 32 })], { textPath: { path: circlePath(radius), align: 'center' } }, fonts)
    const glyphs = shaped.quads.filter((q) => q.isGlyph)
    assert(glyphs.length === 10, 'every non-space glyph survives a circle long enough to hold them')

    for (const q of glyphs) {
      assert(Math.abs(radiusOf(baselineMidpoint(q)) - radius) < 0.3, 'each glyph sits with its baseline on the circle')
    }

    // Centred on a closed curve, the text straddles distance 0 - the top - so it spans both
    // sides of the y axis and stays in the upper half.
    const xs = glyphs.map((q) => baselineMidpoint(q).x)
    assert(Math.min(...xs) < 0 && Math.max(...xs) > 0, 'centring puts half the text either side of the top')
    assert(glyphs.every((q) => baselineMidpoint(q).y < 0), 'and all of it in the top half of the circle')

    // Each glyph is turned to its own place on the curve; the first and last differ most.
    const rotations = glyphs.map((q) => q.rotation)
    assert(new Set(rotations.map((r) => r.toFixed(4))).size === rotations.length, 'every glyph has its own rotation')
    assert(rotations[0] < rotations[rotations.length - 1], 'turning steadily clockwise from first to last')
    assert(Math.abs(rotations[0] - rotations[rotations.length - 1]) > 0.5, 'over a substantial arc')
})

it('a straight path reproduces straight layout', () => {
    const text = 'straight'
    const flat = layoutText([run(text, { fontSize: 30 })], {}, fonts)
    const onLine = layoutText(
      [run(text, { fontSize: 30 })],
      { textPath: { path: TextPathGeometry.fromPoints([{ x: 0, y: 0 }, { x: 1000, y: 0 }]) } },
      fonts,
    )
    const a = flat.quads.filter((q) => q.isGlyph)
    const b = onLine.quads.filter((q) => q.isGlyph)
    assert(a.length === b.length, 'a straight path changes nothing about which glyphs there are')
    assert(b.every((q) => q.rotation === 0), 'and turns none of them')
    // The baseline is laid ON the path, so the block shifts up by exactly its ascent.
    const lift = b[0].y0 - a[0].y0
    for (let i = 0; i < a.length; i++) {
      assert(near(b[i].x0, a[i].x0), 'x positions are untouched')
      assert(near(b[i].y0 - a[i].y0, lift), 'and y is shifted by one constant, not distorted')
    }
})

it('text that outruns an open curve is cut off, not piled up', () => {
    const long = run('a much longer line of text than will fit', { fontSize: 40 })
    const short = arcPath(60, 0, Math.PI / 2) // ~94 units of curve
    const clipped = layoutText([long], { textPath: { path: short } }, fonts).quads.filter((q) => q.isGlyph)
    const whole = layoutText([long], {}, fonts).quads.filter((q) => q.isGlyph)
    assert(clipped.length > 0, 'what fits is kept')
    assert(clipped.length < whole.length, 'and what runs off the end is dropped')
    for (const q of clipped) {
      assert(Math.abs(radiusOf(baselineMidpoint(q)) - 60) < 0.4, 'everything kept is on the curve')
    }

    // A closed curve has no end to run off: the same text wraps round and keeps every glyph.
    const wrapped = layoutText([long], { textPath: { path: circlePath(60) } }, fonts).quads.filter((q) => q.isGlyph)
    assert(wrapped.length === whole.length, 'a closed curve keeps them all, wrapping round')
})

it('startOffset, align and side', () => {
    const path = circlePath(200)
    const glyphsOf = (o: Parameters<typeof layoutText>[1]) => layoutText([run('ABCDEF', { fontSize: 30 })], o, fonts).quads.filter((q) => q.isGlyph)

    const start = glyphsOf({ textPath: { path } })
    const centred = glyphsOf({ textPath: { path, align: 'center' } })
    const end = glyphsOf({ textPath: { path, align: 'end' } })
    // 'start' begins at the offset and runs on from it, 'end' finishes there, 'center'
    // straddles it. Measured against the top of the circle, which the curve leaves towards +x.
    assert(start.every((q) => baselineMidpoint(q).x > 0), "'start' lays the whole run after the offset")
    assert(end.every((q) => baselineMidpoint(q).x < 0), "'end' lays it all before the offset instead")
    assert(baselineMidpoint(centred[0]).x < 0 && baselineMidpoint(centred[centred.length - 1]).x > 0, "'center' straddles it")
    assert(baselineMidpoint(start[0]).x < baselineMidpoint(centred[0]).x + 1e-9 === false, "'start' begins further along than 'center' does")

    // startOffset moves the text along the curve; a quarter of the way round is the left side
    // of the circle when the curve runs clockwise from the top.
    const moved = glyphsOf({ textPath: { path, startOffset: path.length / 4, align: 'center' } })
    assert(baselineMidpoint(moved[0]).x > 100, 'a quarter turn clockwise from the top is the right-hand side')

    // The far side of the curve: text is turned over, so its up direction points inward.
    const outside = glyphsOf({ textPath: { path, align: 'center' } })
    const inside = glyphsOf({ textPath: { path, align: 'center', side: 'right' } })
    assert(Math.cos(outside[0].rotation) * Math.cos(inside[0].rotation) < 0.99, "'right' turns the text over")
    assert(inside.every((q) => baselineMidpoint(q).y < 0), 'both sides still sit at the top of the circle')
    // y0 is the quad's top edge, so it is the ascender end in a y-down space.
    const ascenderOut = (q: BentQuad) => radiusOf(quadCorner(q, (q.x0 + q.x1) / 2, q.y0))
    assert(ascenderOut(outside[0]) > 200, 'set on the left of the curve, a glyph reaches outward')
    assert(ascenderOut(inside[0]) < 200, 'set on the right, it reaches inward')
})

it('offset lifts the text off the curve', () => {
    const path = circlePath(150)
    const on = layoutText([run('lift', { fontSize: 24 })], { textPath: { path, align: 'center' } }, fonts).quads.filter((q) => q.isGlyph)
    const off = layoutText([run('lift', { fontSize: 24 })], { textPath: { path, align: 'center', offset: 25 } }, fonts).quads.filter((q) => q.isGlyph)
    assert(Math.abs(radiusOf(baselineMidpoint(on[0])) - 150) < 0.3, 'with no offset the baseline is on the curve')
    assert(Math.abs(radiusOf(baselineMidpoint(off[0])) - 175) < 0.3, 'a positive offset pushes it out along the normal')
})

it('rules and highlights bend too, by being cut into pieces', () => {
    const path = circlePath(180)
    const straight = layoutText([run('underlined', { fontSize: 28, underline: true })], {}, fonts)
    const curved = layoutText([run('underlined', { fontSize: 28, underline: true })], { textPath: { path, align: 'center' } }, fonts)

    const straightRules = straight.quads.filter((q) => !q.isGlyph)
    const curvedRules = curved.quads.filter((q) => !q.isGlyph)
    assert(straightRules.length === 1, 'on a straight baseline an underline is one long rectangle')
    assert(curvedRules.length > 8, 'on a curve it becomes a row of short ones that can follow it')
    assert(new Set(curvedRules.map((q) => q.rotation.toFixed(5))).size > 1, 'each turned to its own part of the curve')

    // The rule stays where a rule belongs: just below the baseline, so inside the circle.
    for (const q of curvedRules) {
      const r = radiusOf(quadCorner(q, (q.x0 + q.x1) / 2, (q.y0 + q.y1) / 2))
      assert(r < 180 && r > 160, 'and sitting just inside the curve, under the glyphs')
    }
})

it('more than one line becomes concentric rings', () => {
    const path = circlePath(240)
    const shaped = layoutText([run('first\nsecond', { fontSize: 26 })], { textPath: { path, align: 'center' } }, fonts)
    const glyphs = shaped.quads.filter((q) => q.isGlyph)
    const radii = glyphs.map((q) => radiusOf(baselineMidpoint(q)))
    const outer = radii.filter((r) => r > 225)
    const inner = radii.filter((r) => r <= 225)
    assert(outer.length === 5 && inner.length === 6, 'the first line lands on the curve and the second sits inside it')
    assert(outer.every((r) => Math.abs(r - 240) < 0.4), 'the first line is on the curve itself')
    // A ring of its own, one line-height in - not collapsed onto the first, and not fanned out.
    // The spread is the flattening tolerance: the normal is the chord's, not the true radius'.
    assert(Math.max(...inner) - Math.min(...inner) < 0.5, 'and the second keeps a constant radius of its own')
    assert(240 - Math.max(...inner) > 20 && 240 - Math.min(...inner) < 45, 'one line-height inside the first, keeping the leading')
})

it('a curve is ignored for vertical text, which has no single baseline to lay on one', () => {
    const path = circlePath(200)
    const plain = layoutText([run('AB', { fontSize: 30 })], { orientation: 'vertical' }, fonts)
    const withPath = layoutText([run('AB', { fontSize: 30 })], { orientation: 'vertical', textPath: { path } }, fonts)
    assert(withPath.quads.length === plain.quads.length, 'vertical text is unchanged by a curve')
    assert(withPath.quads.every((q) => q.rotation === 0), 'and none of it is turned')
})

// --- padding: blank space inside the block ----------------------------------------------------
//
// It has to do BOTH halves - move the text and grow the block - or it is not padding: a version
// that only moved the glyphs would leave the measured size wrong, and everything that reads a
// block's size (bounds, hit-testing, a highlight drawn behind it) would be short by twice it.

it('padding insets the text and grows the block by twice it', () => {
    const plain = layoutText([run('Hi there', { fontSize: 30 })], {}, fonts)
    const padded = layoutText([run('Hi there', { fontSize: 30 })], { padding: 12 }, fonts)

    assert(near(padded.width, plain.width + 24), 'the block is twice the padding wider')
    assert(near(padded.height, plain.height + 24), 'and twice the padding taller')

    const plainGlyphs = plain.quads.filter((q) => q.isGlyph)
    const paddedGlyphs = padded.quads.filter((q) => q.isGlyph)
    assert(paddedGlyphs.length === plainGlyphs.length, 'the same glyphs are laid out')
    for (let i = 0; i < plainGlyphs.length; i++) {
      assert(near(paddedGlyphs[i].x0 - plainGlyphs[i].x0, 12), 'each one moved right by the padding')
      assert(near(paddedGlyphs[i].y0 - plainGlyphs[i].y0, 12), 'and down by it')
    }
    assert(near(padded.referenceBaseline - plain.referenceBaseline, 12), 'the first baseline moved with them')
})

it('padding does not change where the text wraps, only where the block ends', () => {
    // maxWidth is the width the TEXT wraps at, so a padded block that wraps is wider than it by
    // twice the padding and breaks in exactly the same places.
    const text = 'wrap this sentence onto several lines'
    const plain = layoutText([run(text, { fontSize: 20 })], { maxWidth: 160 }, fonts)
    const padded = layoutText([run(text, { fontSize: 20 })], { maxWidth: 160, padding: 10 }, fonts)
    assert(padded.lineCount === plain.lineCount, 'the same number of lines')
    assert(near(padded.width, plain.width + 20), 'and a block twenty wider than the unpadded one')
})

it('padding centres the text within the padding, not on it', () => {
    // Alignment measures against the width the text has to fill, which padding is not part of -
    // otherwise a centred line would be pushed off-centre by exactly the padding.
    const centred = layoutText([run('Hi', { fontSize: 20 })], { maxWidth: 200, align: 'center' }, fonts)
    const padded = layoutText([run('Hi', { fontSize: 20 })], { maxWidth: 200, align: 'center', padding: 15 }, fonts)
    const first = (s: typeof centred) => s.quads.filter((q) => q.isGlyph)[0]
    assert(near(first(padded).x0 - first(centred).x0, 15), 'a centred line moves by the padding and no more')
})

it('padding insets a vertical block on its own axes', () => {
    // Columns run to negative x from the origin, so the inset is negative there and positive on
    // the other axis - the same "inside the block" either way.
    const plain = layoutText([run('AB', { fontSize: 30 })], { orientation: 'vertical' }, fonts)
    const padded = layoutText([run('AB', { fontSize: 30 })], { orientation: 'vertical', padding: 8 }, fonts)
    assert(near(padded.width, plain.width + 16), 'twice the padding wider')
    assert(near(padded.height, plain.height + 16), 'and twice the padding deeper')

    const plainGlyphs = plain.quads.filter((q) => q.isGlyph)
    const paddedGlyphs = padded.quads.filter((q) => q.isGlyph)
    for (let i = 0; i < plainGlyphs.length; i++) {
      assert(near(paddedGlyphs[i].x0 - plainGlyphs[i].x0, -8), 'each glyph moved in from the right edge')
      assert(near(paddedGlyphs[i].y0 - plainGlyphs[i].y0, 8), 'and down from the top')
    }
})

// --- uniform text: one style for the whole string ---------------------------------------------
//
// The facade's whole claim is that an attribute written on the node reaches the glyphs. Every
// check below is one attribute, written and then read out of the run the node actually shapes -
// because the failure being guarded against is not an exception, it is an assignment that
// silently does nothing, which is exactly what `Shape.fill` did on a text node.

const styleOf = (node: { runs: readonly TextRun[] }) => node.runs[0].style ?? {}

it('a uniform text node is one run, sized and painted from the node itself', () => {
    const label = new UniformMSDFText({ text: 'Hello' })
    assert(label.runs.length === 1, 'exactly one run')
    assert(label.runs[0].text === 'Hello', 'carrying the string')
    assert(styleOf(label).fontSize === 12, "at the uniform default size, not the engine's 32")
    assert(JSON.stringify(styleOf(label).color) === '[0,0,0,1]', 'and opaque black, which nothing else in this engine defaults to')

    // Saying nothing about fill is what gets the black; saying `null` means what it says.
    const unpainted = new UniformMSDFText({ text: 'Hello', fill: null })
    assert(JSON.stringify(styleOf(unpainted).color) === '[0,0,0,0]', 'an explicit null is not the same as leaving it out')

    // The two ways of saying "several styles" are what this class exists not to have.
    expect(() => new UniformMSDFText({ runs: [{ text: 'a' }] } as never)).toThrow('one style for the whole string')
    expect(() => new UniformMSDFText({ text: 'a', style: { fontSize: 9 } } as never)).toThrow('one style for the whole string')
})

it('fill, stroke and strokeWidth paint the glyphs', () => {
    const label = new UniformMSDFText({ text: 'Hello' })

    label.fill = 'red'
    assert(JSON.stringify(styleOf(label).color) === '[1,0,0,1]', 'fill reaches the run, which is what a plain MSDFText ignores')

    label.fill = null
    assert(JSON.stringify(styleOf(label).color) === '[0,0,0,0]', 'and null paints nothing rather than falling back to black')

    // A width with no colour is not a stroke - the same rule Shape.hasStroke() states.
    label.strokeWidth = 3
    assert(styleOf(label).strokeWidth === 0, 'a width alone draws no outline')
    label.stroke = 'navy'
    assert(styleOf(label).strokeWidth === 3, 'a colour with it does')
    assert(JSON.stringify(styleOf(label).strokeColor) === '[0,0,0.5019607843137255,1]', 'in that colour')
})

it("fontStyle takes CSS's vocabulary and this engine's, and rejects the rest", () => {
    assert(toFontStyle('normal') === 'regular', "'normal' is the plain face")
    assert(toFontStyle('') === 'regular', 'and so is nothing at all')
    assert(toFontStyle('bold') === 'bold', 'one word picks one face')
    assert(toFontStyle('italic bold') === 'bold-italic', 'two words in either order pick the same one')
    assert(toFontStyle('bold italic') === 'bold-italic', 'either order')
    assert(toFontStyle('bold-italic') === 'bold-italic', "including this engine's own spelling of it")
    assert(toFontStyle('OBLIQUE') === 'italic', 'case and CSS synonyms are accepted')
    // A typo that silently drew regular is the kind of thing nobody finds.
    expect(() => toFontStyle('semibold')).toThrow('nothing to draw with')

    const label = new UniformMSDFText({ text: 'Hello', fontStyle: 'bold' })
    assert(styleOf(label).fontStyle === 'bold', 'the node resolves it into the run')
    assert(label.fontStyle === 'bold', 'and reads back what was written, not what it resolved to')
    expect(() => { label.fontStyle = 'ultra' }).toThrow()
    assert(label.fontStyle === 'bold', 'a rejected assignment leaves the node as it was')
})

it('textDecoration turns CSS rules into the two the shaper draws', () => {
    assert(JSON.stringify(toDecorations('')) === '{"underline":false,"strikethrough":false}', 'nothing by default')
    assert(toDecorations('underline').underline, 'one rule')
    assert(toDecorations('line-through').strikethrough, 'the other, spelled as CSS spells it')
    assert(toDecorations('strikethrough').strikethrough, 'or as this engine does')
    const both = toDecorations('underline line-through')
    assert(both.underline && both.strikethrough, 'and both together')
    expect(() => toDecorations('overline')).toThrow('not a rule this draws')

    const label = new UniformMSDFText({ text: 'Hello', textDecoration: 'underline' })
    assert(styleOf(label).underline === true, 'the node puts it in the run')
})

it('writing any attribute re-shapes the node', () => {
    const label = new UniformMSDFText({ text: 'Hello' })
    const before = label.shaped(fonts).width

    label.fontSize = 48
    const bigger = label.shaped(fonts).width
    assert(bigger > before * 3, 'a larger size is a wider block, measured through the shaper')

    label.text = 'Hello there, at some length'
    assert(label.shaped(fonts).width > bigger, 'and a longer string is wider still')

    // Inherited from Text, but an accessor on this class so it invalidates like the rest.
    const unpadded = label.shaped(fonts).height
    label.padding = 20
    assert(near(label.shaped(fonts).height, unpadded + 40), 'padding grows the block without being asked to re-shape')
})

it('a uniform text node measures itself, and other strings in its own style', () => {
    const label = new UniformMSDFText({ text: 'Hello', fontSize: 24 })
    assert(near(label.getTextWidth(fonts), label.shaped(fonts).width), 'getTextWidth is the shaped width')
    assert(near(label.getTextHeight(fonts), label.shaped(fonts).height), 'and getTextHeight the shaped height')

    const longer = label.measureSize('Hello there', fonts)
    assert(longer.width > label.getTextWidth(fonts), 'another string measures wider')
    assert(label.text === 'Hello', 'and measuring it did not disturb the node')

    // padding is part of the block, so it is part of what a measurement reports.
    const bare = label.measureSize('Hello', fonts).width
    label.padding = 10
    assert(near(label.measureSize('Hello', fonts).width, bare + 20), 'a measurement includes the padding')
})

it('the outline class is the same node with real geometry behind it', () => {
    const label = new UniformVectorText({ fontFamily: VECTOR_FAMILY, text: 'Hi', fontSize: 40, fill: 'crimson' })
    assert(label.runs.length === 1 && styleOf(label).fontSize === 40, 'one run, styled from the attributes')

    // Its fonts are on the node, so it needs nothing passed in to measure.
    assert(label.getTextWidth() > 0, 'it measures itself')
    assert(label.measureSize('Hi there').width > label.getTextWidth(), 'and other strings too')

    // Its glyphs are mesh geometry, so a colour change has to reach the materials the lane paints.
    const crimson = label.materials().some((m) => m.fill !== null && m.fill[0] > 0.7 && m.fill[1] < 0.2)
    assert(crimson, 'the fill attribute is what the mesh lane paints the glyphs with')
    label.fill = 'navy'
    assert(label.materials().some((m) => m.fill !== null && m.fill[2] > 0.4 && m.fill[0] < 0.1), 'and changing it repaints them')
})

// --- naming a font ----------------------------------------------------------------------------
//
// A font reaches the engine by being registered under a name; there is no way to hand a book to a
// node. What is pinned here is the consequence nobody wants to discover at runtime: a name that
// resolves to nothing draws nothing, rather than quietly borrowing whichever face loaded first.

it('both text kinds name the same family', () => {
    const outline = new VectorText({ text: 'Hi', fontFamily: VECTOR_FAMILY, style: { fontSize: 40 } })
    assert(outline.fonts === vectorFonts, 'the name resolves to the registered book')
    assert(outline.shaped().quads.length > 0, 'and the node shapes glyphs from it')

    // The MSDF class carries the same attribute off the same base - one vocabulary for both.
    const atlas = new MSDFText({ text: 'Hi', fontFamily: VECTOR_FAMILY })
    assert(atlas.fontFamily === outline.fontFamily, 'fontFamily is Text\'s, not one subclass\'s')
})

it('a family nothing is registered under draws nothing, and says so once', () => {
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (message: string) => warnings.push(message)
    try {
      const missing = new VectorText({ text: 'Hi', fontFamily: 'no-such-family', style: { fontSize: 40 } })
      assert(missing.fonts === undefined, 'nothing resolves')
      assert(missing.shaped().quads.length === 0, 'so there is nothing to draw')
      assert(missing.materials().length === 0, 'and no material for the mesh lane to paint with')

      // Every access re-resolves, because registering later has to take effect - but the warning
      // is per name. A per-access warning would fill the console within a second of drawing.
      missing.shaped()
      missing.shaped()
      assert(warnings.length === 1, 'warned once, not once per shaping')
      assert(warnings[0].includes('no-such-family'), 'and the message names the family')
    } finally {
      console.warn = realWarn
    }
})

it('registering a family afterwards reaches the nodes already naming it', () => {
    const late = new VectorText({ text: 'Hi', fontFamily: 'arrives-late', style: { fontSize: 40 } })
    assert(late.shaped().quads.length === 0, 'nothing to draw before it arrives')

    registerFontFamily('arrives-late', { vector: vectorFonts })
    // Not cached while unresolved, so the next access picks the book up - which is what lets a
    // font fetched after the scene was built still draw.
    assert(late.shaped().quads.length > 0, 'and glyphs once it has')
})
