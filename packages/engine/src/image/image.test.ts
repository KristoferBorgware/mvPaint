// Self-test for the image lane's pure half: the corner texture coordinates an Image samples,
// from its crop, fit, tiling and flipping (image/imageUv.ts), and the SVG size the rasterizer
// resolves and writes back (image/svgSize.ts). No GPU, no DOM - the texture upload and the
// batcher need a device and are covered in the browser instead. Run with:
//   npx vitest run packages/engine/src/image/image.test.ts

import { expect, it } from 'vitest'
import { imageUvRect } from './imageUv'
import { parseLength, resizeSvgDocument, resolveSvgPixelSize, svgIntrinsicSize, svgViewBox } from './svgSize'

/**
 * Every check in this file goes through here, so each one reads as the sentence it is making
 * and vitest reports that sentence when it stops being true.
 */
function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
const rect = (r: { u0: number; v0: number; u1: number; v1: number }) =>
  `${r.u0.toFixed(3)},${r.v0.toFixed(3)} -> ${r.u1.toFixed(3)},${r.v1.toFixed(3)}`

it('the whole image by default', () => {
    const uv = imageUvRect({ textureWidth: 200, textureHeight: 100, quadWidth: 200, quadHeight: 100 })
    assert(rect(uv) === '0.000,0.000 -> 1.000,1.000', 'with nothing set, the quad samples the whole image')

    // A quad of a different shape still samples all of it - 'fill' stretches, by definition.
    const stretched = imageUvRect({ textureWidth: 200, textureHeight: 100, quadWidth: 50, quadHeight: 400 })
    assert(rect(stretched) === '0.000,0.000 -> 1.000,1.000', "'fill' samples everything whatever the quad's shape")
})

it('crop: a rectangle of the source, in pixels', () => {
    const uv = imageUvRect({
      textureWidth: 200,
      textureHeight: 100,
      quadWidth: 100,
      quadHeight: 50,
      crop: { x: 50, y: 25, width: 100, height: 50 },
    })
    assert(rect(uv) === '0.250,0.250 -> 0.750,0.750', 'a crop becomes the matching fraction of the image')

    // The sprite-sheet case: four frames across, take the third.
    const frame = imageUvRect({
      textureWidth: 400,
      textureHeight: 100,
      quadWidth: 100,
      quadHeight: 100,
      crop: { x: 200, y: 0, width: 100, height: 100 },
    })
    assert(rect(frame) === '0.500,0.000 -> 0.750,1.000', 'one frame out of a strip is a quarter of the width')
})

it('fit: \'cover\' trims the axis with too much image, about the centre', () => {
    // A wide image in a square quad: the sides go, the full height stays.
    const wide = imageUvRect({ textureWidth: 200, textureHeight: 100, quadWidth: 100, quadHeight: 100, fit: 'cover' })
    assert(near(wide.v0, 0) && near(wide.v1, 1), 'covering a square with a wide image keeps its full height')
    assert(near(wide.u0, 0.25) && near(wide.u1, 0.75), 'and takes the middle half of its width')
    assert(near(wide.u0 + wide.u1, 1), 'trimmed evenly, so what shows is centred')

    // A tall image in a square quad: the reverse.
    const tall = imageUvRect({ textureWidth: 100, textureHeight: 200, quadWidth: 100, quadHeight: 100, fit: 'cover' })
    assert(near(tall.u0, 0) && near(tall.u1, 1), 'covering a square with a tall image keeps its full width')
    assert(near(tall.v0, 0.25) && near(tall.v1, 0.75), 'and takes the middle half of its height')

    // Matching aspects need no trim at all.
    const same = imageUvRect({ textureWidth: 200, textureHeight: 100, quadWidth: 400, quadHeight: 200, fit: 'cover' })
    assert(rect(same) === '0.000,0.000 -> 1.000,1.000', 'an image already the quad shape is not trimmed')

    // 'cover' composes with a crop: it trims the CROPPED rectangle, not the whole image.
    const cropped = imageUvRect({
      textureWidth: 400,
      textureHeight: 400,
      quadWidth: 100,
      quadHeight: 100,
      crop: { x: 0, y: 0, width: 400, height: 200 },
      fit: 'cover',
    })
    assert(near(cropped.v0, 0) && near(cropped.v1, 0.5), 'the crop still bounds what cover can show')
    assert(near(cropped.u0, 0.25) && near(cropped.u1, 0.75), 'and cover trims within it')
})

it('tiling runs the coordinates past 1, which the wrap mode then resolves', () => {
    const uv = imageUvRect({ textureWidth: 64, textureHeight: 64, quadWidth: 256, quadHeight: 256, tileX: 4, tileY: 4 })
    assert(rect(uv) === '0.000,0.000 -> 4.000,4.000', 'tiling scales the span, leaving the anchored corner put')

    // Tiling a crop repeats just that part - one sprite as a pattern.
    const tiledCrop = imageUvRect({
      textureWidth: 100,
      textureHeight: 100,
      quadWidth: 200,
      quadHeight: 100,
      crop: { x: 50, y: 0, width: 50, height: 100 },
      tileX: 2,
    })
    assert(near(tiledCrop.u0, 0.5) && near(tiledCrop.u1, 1.5), 'a tiled crop repeats from where the crop starts')

    const perAxis = imageUvRect({ textureWidth: 10, textureHeight: 10, quadWidth: 30, quadHeight: 10, tileX: 3 })
    assert(near(perAxis.u1, 3) && near(perAxis.v1, 1), 'the axes tile independently')
})

it('flipping mirrors the result, last', () => {
    const x = imageUvRect({ textureWidth: 10, textureHeight: 10, quadWidth: 10, quadHeight: 10, flipX: true })
    assert(rect(x) === '1.000,0.000 -> 0.000,1.000', 'flipX swaps the horizontal coordinates')

    const y = imageUvRect({ textureWidth: 10, textureHeight: 10, quadWidth: 10, quadHeight: 10, flipY: true })
    assert(rect(y) === '0.000,1.000 -> 1.000,0.000', 'flipY swaps the vertical ones')

    const both = imageUvRect({ textureWidth: 10, textureHeight: 10, quadWidth: 10, quadHeight: 10, flipX: true, flipY: true })
    assert(rect(both) === '1.000,1.000 -> 0.000,0.000', 'and both together turn it around')

    // Applied after everything else, so it mirrors what is actually visible.
    const flippedCrop = imageUvRect({
      textureWidth: 100,
      textureHeight: 100,
      quadWidth: 50,
      quadHeight: 100,
      crop: { x: 0, y: 0, width: 50, height: 100 },
      flipX: true,
    })
    assert(near(flippedCrop.u0, 0.5) && near(flippedCrop.u1, 0), 'flipping a crop mirrors the crop, not the whole image')
})

it('a source with no area cannot produce coordinates, and must not produce NaN', () => {
    for (const [w, h] of [
      [0, 100],
      [100, 0],
      [0, 0],
      [-10, 10],
    ]) {
      const uv = imageUvRect({ textureWidth: w, textureHeight: h, quadWidth: 10, quadHeight: 10 })
      assert(rect(uv) === '0.000,0.000 -> 1.000,1.000', `a ${w}x${h} source falls back to the unit square`)
      assert(
        Number.isFinite(uv.u0) && Number.isFinite(uv.v0) && Number.isFinite(uv.u1) && Number.isFinite(uv.v1),
        `a ${w}x${h} source produces no NaN`,
      )
    }

    // A zero-area QUAD is legitimate (a collapsed node) and must not divide by zero either.
    const collapsed = imageUvRect({ textureWidth: 100, textureHeight: 100, quadWidth: 0, quadHeight: 0, fit: 'cover' })
    assert(Number.isFinite(collapsed.u0) && Number.isFinite(collapsed.u1), 'a zero-area quad produces no NaN under cover')
})

it('SVG lengths: absolute units convert, relative ones have no size of their own', () => {
    assert(parseLength('120') === 120, 'a bare number is already pixels')
    assert(parseLength('120px') === 120, 'so is px')
    assert(parseLength(' 96in ') === 96 * 96, 'inches are 96 pixels each')
    assert(near(parseLength('72pt') ?? 0, 96), '72 points make an inch')
    assert(near(parseLength('25.4mm') ?? 0, 96), 'and so do 25.4 millimetres')
    assert(parseLength('1e2') === 100, 'exponent notation parses')

    assert(parseLength('50%') === null, 'a percentage needs a containing box, so it gives no size')
    assert(parseLength('2em') === null, 'nor does a font-relative unit')
    assert(parseLength('auto') === null && parseLength('') === null && parseLength(null) === null, 'and neither does a non-length')
})

it('the viewBox, when there is one to read', () => {
    const box = svgViewBox('<svg viewBox="0 0 24 24"></svg>')
    assert(box?.width === 24 && box?.height === 24, 'a viewBox is read off the root element')
    assert(svgViewBox('<svg viewBox="-5,-5, 10 20"/>')?.x === -5, 'commas separate as well as spaces')
    assert(svgViewBox('<svg viewBox="0 0 0 10"/>') === null, 'a zero-width viewBox is not usable')
    assert(svgViewBox('<svg viewBox="1 2 3"/>') === null, 'nor is one with the wrong number of values')
    assert(svgViewBox('<svg width="10"/>') === null, 'and an absent one is absent')
})

it('the size a document asks for', () => {
    assert(
      svgIntrinsicSize('<svg width="200" height="100"></svg>')?.width === 200,
      'width and height give the size directly',
    )

    const fromBox = svgIntrinsicSize('<svg viewBox="0 0 24 12"></svg>')
    assert(fromBox?.width === 24 && fromBox?.height === 12, 'with no width/height, the viewBox is the size')

    // One axis plus a viewBox is enough: the aspect ratio supplies the other.
    const half = svgIntrinsicSize('<svg width="48" viewBox="0 0 24 12"></svg>')
    assert(half?.width === 48 && half?.height === 24, 'one axis and a viewBox give the other by aspect ratio')

    // A percentage width is no width at all, so the viewBox still decides.
    const pct = svgIntrinsicSize('<svg width="100%" height="100%" viewBox="0 0 30 10"></svg>')
    assert(pct?.width === 30 && pct?.height === 10, 'percentage sizes fall through to the viewBox')

    assert(svgIntrinsicSize('<svg></svg>') === null, 'a document that says nothing has no intrinsic size')

    // The root element has to be found past whatever precedes it - including a comment that
    // mentions the very thing being searched for.
    const prologue = `<?xml version="1.0"?>\n<!-- <svg width="1" height="1"/> was here -->\n<svg width="8" height="4"/>`
    assert(svgIntrinsicSize(prologue)?.width === 8, 'a prologue and a decoy comment are skipped')

    // An attribute value may contain '>', which must not be mistaken for the end of the tag.
    assert(svgIntrinsicSize('<svg data-note="a>b" width="7" height="3"/>')?.height === 3, "a '>' inside a value is not the tag's end")
})

it('resolving the size to rasterize at', () => {
    const doc = '<svg width="200" height="100" viewBox="0 0 200 100"></svg>'

    const own = resolveSvgPixelSize(doc)
    assert(own.width === 200 && own.height === 100, 'with nothing asked for, the document decides')

    const scaled = resolveSvgPixelSize(doc, { scale: 2 })
    assert(scaled.width === 400 && scaled.height === 200, 'scale multiplies the pixel size')

    const sized = resolveSvgPixelSize(doc, { width: 50, height: 400 })
    assert(sized.width === 50 && sized.height === 400, 'an explicit size is taken as given, aspect ratio or not')

    const oneAxis = resolveSvgPixelSize(doc, { width: 50 })
    assert(oneAxis.height === 25, 'one axis is completed from the aspect ratio')
    const otherAxis = resolveSvgPixelSize(doc, { height: 50 })
    assert(otherAxis.width === 100, 'from either side')

    const both = resolveSvgPixelSize(doc, { width: 50, scale: 3 })
    assert(both.width === 150 && both.height === 75, 'scale applies after the aspect ratio, to both axes')

    assert(resolveSvgPixelSize(doc, { width: 0.2 }).width === 1, 'a size never rounds away to nothing')
    assert(Number.isInteger(resolveSvgPixelSize(doc, { scale: 1.3 }).width), 'the result is whole pixels')

    // What cannot be worked out has to be said, rather than guessed at.
    const throws = (fn: () => unknown, what: string) => {
      let threw = false
      try {
        fn()
      } catch {
        threw = true
      }
      assert(threw, what)
    }
    throws(() => resolveSvgPixelSize('<svg></svg>'), 'a document with no size and no request is an error')
    throws(() => resolveSvgPixelSize('<svg></svg>', { width: 100 }), 'and one axis cannot fill in the other without a ratio')
    throws(() => resolveSvgPixelSize(doc, { scale: 0 }), 'a zero scale is rejected')
    throws(() => resolveSvgPixelSize(doc, { width: -5 }), 'as is a negative size')

    assert(resolveSvgPixelSize('<svg></svg>', { width: 64, height: 64 }).width === 64, 'but a full size needs no document at all')
})

it('writing the size back into the markup', () => {
    const out = resizeSvgDocument('<svg width="10" height="5" viewBox="0 0 10 5"><rect/></svg>', 40, 20)
    assert(/width="40"/.test(out) && /height="20"/.test(out), 'the root carries the new size')
    assert(!/width="10"/.test(out), 'and not the old one')
    assert(/viewBox="0 0 10 5"/.test(out), "an existing viewBox is left alone - it is what makes the drawing scale")
    assert(out.includes('<rect/></svg>'), 'the rest of the document is untouched')

    // Without a viewBox, a larger width would only add blank canvas, so one is derived from
    // the size the document had.
    const noBox = resizeSvgDocument('<svg width="10" height="5"><rect/></svg>', 40, 20)
    assert(/viewBox="0 0 10 5"/.test(noBox), 'a document with no viewBox gets one from its original size')
    assert(/width="40"/.test(noBox) && /height="20"/.test(noBox), 'alongside the new size')

    // Other attributes are not collateral damage.
    const attrs = resizeSvgDocument('<svg xmlns="http://www.w3.org/2000/svg" id="logo" width="8" height="8"/>', 16, 16)
    assert(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(attrs) && /id="logo"/.test(attrs), 'unrelated attributes survive')
    assert(attrs.endsWith('/>'), 'a self-closing root stays self-closing')

    // Single quotes are as valid as double ones, and the old size must go either way.
    const quoted = resizeSvgDocument("<svg viewBox='0 0 4 2' width='4' height='2'/>", 8, 4)
    assert(/width="8"/.test(quoted) && /height="4"/.test(quoted), 'a single-quoted size is replaced too')
    assert(!/width='4'/.test(quoted) && !/height='2'/.test(quoted), 'with the original removed, not duplicated')
    assert(quoted.includes("viewBox='0 0 4 2'"), 'and its viewBox kept verbatim')

    assert(resizeSvgDocument('not svg at all', 10, 10) === 'not svg at all', 'a document with no root element is returned as it was')

    // The round trip: what was written back is what is read out again.
    const round = resizeSvgDocument('<svg viewBox="0 0 3 1"/>', 300, 100)
    const back = svgIntrinsicSize(round)
    assert(back?.width === 300 && back?.height === 100, 'the resized document now reports the size it was given')
})
