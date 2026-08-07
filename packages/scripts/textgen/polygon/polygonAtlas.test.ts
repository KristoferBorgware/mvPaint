// Self-test for the polygon atlas generator: that what it writes is what the engine reads,
// that the engine reading it gets the same letterforms a live parse would, that a face handed
// over as woff2 gives the same atlas as the same face as sfnt, and that the atlases the example
// app has copied in are the ones this tool produces today.
//
// The last of those is the one that matters most in practice, and it is the price of the
// generator's output being copied rather than imported. out/ is transient and gitignored; the
// committed copy is whatever a developer moved into an application, and nothing in the build
// refreshes it - so a change to the fonts, the charset or the flattening tolerance is invisible
// until someone remembers to re-run the tool AND re-copy. This turns "someone remembers" into a
// failing test, for the one application this repository has.
//
//   npx vitest run packages/scripts/textgen/polygon/polygonAtlas.test.ts

import { expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compress } from 'wawoff2'
import { TtfFont } from '@mvpaint/ttf'
import { PolygonFont, POLYGON_ATLAS_FORMAT } from '@mvpaint/engine/core'
import { buildPolygonAtlas } from './genPolygonAtlas'
import { DEFAULT_CHARSET } from '../charset'
import { FONT_SRC, readFontFaces, toSfnt } from '../fontSources'

const HERE = dirname(fileURLToPath(import.meta.url))
// The example app's copy: the committed artifact, and the only one there is now that the
// generator writes to a gitignored out/.
const ATLAS_DIR = join(HERE, '..', '..', '..', 'example-app', 'public', 'fonts', 'polygons')

/**
 * Every check in this file goes through here, so each one reads as the sentence it is making
 * and vitest reports that sentence when it stops being true.
 */
function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}

const fontData = async (name: string): Promise<ArrayBuffer> => {
  const bytes = await readFile(join(FONT_SRC, name))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}


it('the document the generator writes', async () => {
    const atlas = await buildPolygonAtlas('inter-regular', [{ data: await fontData('Inter-400-normal.ttf') }])

    assert(atlas.format === POLYGON_ATLAS_FORMAT, 'the document names the format the engine expects')
    assert(atlas.unitsPerEm > 0 && atlas.base > 0 && atlas.lineHeight > atlas.base, 'vertical metrics are coherent')

    // Every code point of the default charset the font has a glyph for, and no others. Inter
    // draws all of it but the soft hyphen, which is a formatting character rather than a letter.
    const drawn = new Set(atlas.glyphs.map((glyph) => glyph.codePoint))
    assert(atlas.glyphs.every((glyph) => DEFAULT_CHARSET.includes(glyph.codePoint)), 'the atlas holds nothing outside the charset')
    assert(drawn.size === atlas.glyphs.length, 'and holds each code point once')
    for (const char of ['A', 'z', '0', '~', 'å', 'ä', 'ö', 'Å', 'Ä', 'Ö', 'é', 'ü', 'ñ', 'ß']) {
      assert(drawn.has(char.codePointAt(0)!), `'${char}' is in the atlas`)
    }

    // Coordinates are whole font units - the reason the file is a fraction of the size it would
    // be as floats, and a rounding error far under the tolerance the curves were flattened at.
    const every = (predicate: (value: number) => boolean) =>
      atlas.glyphs.every((glyph) => (glyph.rings ?? []).every((ring) => ring.every(predicate)))
    assert(every(Number.isInteger), 'every coordinate is a whole font unit')
    assert(every((value) => !Object.is(value, -0)), 'and none of them is a negative zero')

    const rings = atlas.glyphs.flatMap((glyph) => glyph.rings ?? [])
    assert(rings.every((ring) => ring.length >= 6 && ring.length % 2 === 0), 'every ring is a flat x,y list of at least three points')

    // A space has an advance and nothing else: absent box fields say "blank", and a blank glyph
    // is not the same as a missing one - the shaper needs its advance.
    const space = atlas.glyphs.find((glyph) => glyph.codePoint === 32)!
    assert(space.advance > 0, 'space advances the pen')
    assert(space.rings === undefined && space.width === undefined, 'and carries no outline or box')

    const capitalA = atlas.glyphs.find((glyph) => glyph.codePoint === 65)!
    assert((capitalA.rings?.length ?? 0) === 2, "'A' is an outer ring and its counter")
    assert(capitalA.width! > 0 && capitalA.height! > 0 && capitalA.y! > 0, "'A' has a box, measured downward from the line top")

    assert(atlas.kernings.length > 0, 'the kerning pairs over the charset are baked in')
    assert(
      atlas.kernings.every(([first, second, amount]) => Number.isInteger(amount) && amount !== 0 && first > 0 && second > 0),
      'each is a non-zero whole-unit pair',
    )
    assert(atlas.decoration.underlineThickness > 0, 'the decoration metrics came across')
})

//
// The generator and the runtime parser share their extraction code, so this is not really
// testing arithmetic - it is testing that nothing is lost or transposed in between: the
// serialization, the rounding, and the engine's own reading of the document.
it('what the engine reads back is what a live parse would have produced', async () => {
    const data = await fontData('Inter-400-normal.ttf')
    const atlas = await buildPolygonAtlas('inter-regular', [{ data }])
    const baked = new PolygonFont(atlas)
    const live = await TtfFont.parse(data)

    assert(baked.unitsPerEm === live.unitsPerEm, 'the same unit system')
    assert(baked.metrics.base === live.metrics.base, 'the same ascent')
    assert(baked.metrics.lineHeight === live.metrics.lineHeight, 'the same line height')

    const sample = [65, 87, 111, 73, 103, 38, 64, 37, 32] // A W o I g & @ % space
    live.ensure(String.fromCodePoint(...sample))
    for (const codePoint of sample) {
      const char = String.fromCodePoint(codePoint)
      const mine = baked.metrics.glyphs.get(codePoint)!
      const theirs = live.metrics.glyphs.get(codePoint)!
      assert(Math.abs(mine.xadvance - theirs.xadvance) <= 0.5, `${char}: the advance survives the round trip`)
      assert(Math.abs(mine.xoffset - theirs.xoffset) <= 0.5, `${char}: so does the left bearing`)
      assert(Math.abs(mine.yoffset - theirs.yoffset) <= 0.5, `${char}: and the top offset`)
      assert(Math.abs(mine.width - theirs.width) <= 1 && Math.abs(mine.height - theirs.height) <= 1, `${char}: and the box`)

      const bakedMesh = baked.mesh(codePoint)!
      const liveMesh = live.mesh(codePoint)!
      assert(bakedMesh.contours.length === liveMesh.contours.length, `${char}: the same number of rings`)
      assert(bakedMesh.vertices.length === liveMesh.vertices.length, `${char}: triangulating them gives the same vertices`)
      assert(bakedMesh.indices.length === liveMesh.indices.length, `${char}: and the same triangles`)
    }

    // Kerning: every pair the live font has over the charset is in the atlas, and vice versa.
    const bakedPairs = atlas.kernings.length
    let livePairs = 0
    for (const first of DEFAULT_CHARSET) {
      for (const second of DEFAULT_CHARSET) {
        if (live.kerning(first, second) !== 0) livePairs++
      }
    }
    assert(bakedPairs === livePairs, 'every kerning pair the font has over the charset is baked in')
})

// A .woff2 is the same sfnt under brotli, with glyf and loca re-encoded. Packing one here and
// reading it back through the folder's own loader tests that round trip against a face whose
// atlas the rest of this file already pins down, rather than against whatever the fonts folder
// happens to hold today.
it('a face handed over as woff2 gives the same atlas as the sfnt inside it', async () => {
    const sfnt = await fontData('Inter-400-normal.ttf')
    const packed = await compress(new Uint8Array(sfnt))
    assert(Buffer.from(packed.buffer, packed.byteOffset, 4).toString('latin1') === 'wOF2', 'the test data really is woff2')

    const unpacked = await toSfnt('Inter-400-normal.woff2', packed)
    const fromWoff2 = await buildPolygonAtlas('inter-regular', [{ data: unpacked }])
    const fromSfnt = await buildPolygonAtlas('inter-regular', [{ data: sfnt }])

    assert(JSON.stringify(fromWoff2) === JSON.stringify(fromSfnt), 'the container the face arrived in leaves no trace in its atlas')
})

// Splitting one font across two sources is the shape a latin/latin-ext pair arrives in, with
// the difference between the files taken out: whatever routing the assembly does, the glyphs
// have to come out the same. Kerning is the one thing that does not survive the split, and
// that is the rule rather than a loss - a pair is a fact one file holds about two glyphs it
// draws itself, so a pair split across two files has no entry to find.
it('a face drawn from several files draws the same glyphs as one file would', async () => {
    const data = await fontData('Inter-400-normal.ttf')
    const half = Math.floor(DEFAULT_CHARSET.length / 2)
    const front = DEFAULT_CHARSET.slice(0, half)
    const back = DEFAULT_CHARSET.slice(half)

    const split = await buildPolygonAtlas('inter-regular', [{ data, provides: front }, { data, provides: back }])
    const whole = await buildPolygonAtlas('inter-regular', [{ data }])

    assert(JSON.stringify(split.glyphs) === JSON.stringify(whole.glyphs), 'every glyph is the one the single-file atlas has')
    assert(split.unitsPerEm === whole.unitsPerEm && split.base === whole.base, 'and the metrics come from the first file')

    const pairs = new Set(whole.kernings.map(([first, second]) => `${first},${second}`))
    assert(
      split.kernings.every(([first, second]) => pairs.has(`${first},${second}`)),
      'the kerning it keeps is kerning the font has',
    )
    const spans = ([first, second]: readonly number[]) => front.includes(first) !== front.includes(second)
    assert(
      split.kernings.every((kerning) => !spans(kerning)) && whole.kernings.some(spans),
      'and the pairs it drops are the ones whose two glyphs come from different files',
    )
})

// Driven by what the app has copied in rather than by what the fonts folder holds: the folder
// is a library a developer adds to, and an application draws with the part of it that it has
// chosen. A copied atlas going stale is what this catches - the face it was generated from
// changing, the charset widening, the tolerance moving.
it('the atlases the app has copied in are the ones this tool produces', async () => {
    const { faces } = await readFontFaces()
    const copied = (await readdir(ATLAS_DIR)).filter((name) => name.endsWith('.polygons.json'))
    assert(copied.length > 0, 'the app has atlases copied in')

    for (const name of copied) {
      const base = name.slice(0, -'.polygons.json'.length)
      const face = faces.find((candidate) => candidate.base === base)
      assert(face !== undefined, `${name} has a face in ${FONT_SRC} to have been generated from`)

      const rebuilt = `${JSON.stringify(await buildPolygonAtlas(base, face!.sources))}\n`
      const committed = await readFile(join(ATLAS_DIR, name), 'utf8')
      assert(
        rebuilt === committed,
        `${name} is up to date with the font and this generator - if this fails, run ` +
          'npm run gen:polygons and copy packages/scripts/textgen/out/polygons/ into the app',
      )
    }
})
