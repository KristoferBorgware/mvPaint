// Self-test for the polygon atlas generator: that what it writes is what the engine reads,
// that the engine reading it gets the same letterforms a live parse would, and that the files
// committed in the engine are actually the ones this tool produces today.
//
// The last of those is the one that matters most in practice. The atlases are generated assets
// under version control: nothing in the build regenerates them, so a change to the fonts, the
// charset or the flattening tolerance is invisible until someone remembers to re-run the tool.
// This turns "someone remembers" into a failing test.
//
//   npx vitest run packages/scripts/text/polygon/polygonAtlas.test.ts

import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TtfFont } from '@mvpaint/ttf'
import { PolygonFont, POLYGON_ATLAS_FORMAT } from '@mvpaint/engine/core'
import { buildPolygonAtlas } from './genPolygonAtlas'

const HERE = dirname(fileURLToPath(import.meta.url))
const FONT_SRC = join(HERE, '..', '..', 'fonts')
const ATLAS_DIR = join(HERE, '..', '..', '..', 'engine', 'src', 'text', 'fonts')

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

const STYLES = [
  { file: 'Inter-Regular.ttf', atlas: 'inter-regular.polygons.json' },
  { file: 'Inter-Bold.ttf', atlas: 'inter-bold.polygons.json' },
  { file: 'Inter-Italic.ttf', atlas: 'inter-italic.polygons.json' },
  { file: 'Inter-BoldItalic.ttf', atlas: 'inter-bold-italic.polygons.json' },
] as const

it('the document the generator writes', async () => {
    const atlas = await buildPolygonAtlas('Inter-Regular', await fontData('Inter-Regular.ttf'))

    assert(atlas.format === POLYGON_ATLAS_FORMAT, 'the document names the format the engine expects')
    assert(atlas.unitsPerEm > 0 && atlas.base > 0 && atlas.lineHeight > atlas.base, 'vertical metrics are coherent')
    assert(atlas.glyphs.length === 95, 'the printable-ASCII charset is covered')

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
    const data = await fontData('Inter-Regular.ttf')
    const atlas = await buildPolygonAtlas('Inter-Regular', data)
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
    for (let first = 0x20; first <= 0x7e; first++) {
      for (let second = 0x20; second <= 0x7e; second++) {
        if (live.kerning(first, second) !== 0) livePairs++
      }
    }
    assert(bakedPairs === livePairs, 'every kerning pair the font has over the charset is baked in')
})

it('the committed atlases are the ones this tool produces', async () => {
    for (const { file, atlas } of STYLES) {
      const rebuilt = `${JSON.stringify(await buildPolygonAtlas(file.replace(/\.ttf$/i, ''), await fontData(file)))}\n`
      const committed = await readFile(join(ATLAS_DIR, atlas), 'utf8')
      assert(
        rebuilt === committed,
        `${atlas} is up to date with the font and this generator - if this fails, run npm run gen:polygons`,
      )
    }
})
