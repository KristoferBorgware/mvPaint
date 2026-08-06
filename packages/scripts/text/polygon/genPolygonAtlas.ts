// Offline generator: font files in, polygon atlas JSON out, one per face.
//
// The vector text path draws real letterform geometry rather than sampling a distance field.
// Flattening the 'A' of Inter Regular is a fixed computation with a fixed result, so this does
// it once, here, and writes the result out as data the engine reads - no font parser and no
// curve flattening in the browser.
//
//   npm run gen:polygons        (or: npx tsx text/polygon/genPolygonAtlas.ts)
//
// Input is the fonts/ FOLDER, enumerated (see ../fontSources.ts) - this tool knows about no
// particular typeface, and takes .ttf, .otf and .woff2 alike. Output goes to out/polygons/,
// which is generated and gitignored: copying what you want into your application is a
// deliberate step, because an outline atlas is the APPLICATION's asset. It hands it to
// VectorText through the VectorFonts interface, and the engine ships none of them.
//
// WHAT IS IN A FILE. Per glyph: the flattened outline as closed rings of whole font units, the
// box and advance the shaper needs, and nothing else. Per file: the em size, the vertical
// metrics, the underline/strikethrough placement read from the font tables, and the non-zero
// kerning pairs over the charset. The engine's PolygonFont reads exactly this and triangulates
// each glyph the first time it is drawn.
//
// WHY IT IS NOT AN IMAGE. The MSDF tool next door packs glyph bitmaps into a texture; this one
// has no texture to pack, because the point of the vector path is that there is no sampling
// step at all. "Atlas" here means the same thing in the sense that matters: one file per face
// holding every glyph the application can draw, generated ahead of time.
//
// The extraction itself is @mvpaint/ttf's - the same code the runtime opt-in package uses - so
// a glyph baked into an atlas and the same glyph parsed live are identical geometry, and the
// self-test next to this file proves it rather than assuming it.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TtfFont, DEFAULT_CURVE_TOLERANCE_EM } from '@mvpaint/ttf'
import type { PolygonFontJson, PolygonGlyphJson } from '@mvpaint/engine/core'
import { POLYGON_ATLAS_FORMAT } from '@mvpaint/engine/core'
import { CHARSET, charsetText } from '../charset'
import { OUT_DIR, describeSources, readFontFaces, reportSkipped } from '../fontSources'

const OUT = join(OUT_DIR, 'polygons')

/** One file a face is drawn from. A face spread over subset files has several. */
export interface PolygonSource {
  /** The face's sfnt bytes. A .woff2 arrives here decompressed. */
  data: ArrayBuffer
  /**
   * The code points this file draws. Left out, it draws everything it has a glyph for that no
   * earlier source in the list already drew.
   */
  provides?: readonly number[]
}

export interface PolygonAtlasOptions {
  /** Code points to include. Anything no source has a glyph for is skipped. */
  charset?: readonly number[]
  /** Curve flatness as a fraction of the em; the runtime cannot change this after the fact. */
  curveToleranceEm?: number
}

/**
 * Build one face's atlas document from its files' bytes.
 *
 * The first source is the primary: it supplies the em size, the vertical metrics and the
 * decoration placement, and draws every code point it has. The rest fill in what it lacks, in
 * order. Kerning is asked of whichever source drew the pair, since a pair only exists inside
 * one file.
 *
 * Exported so the self-test can build one in memory and compare it against the live parser,
 * with nothing written to disk.
 */
export async function buildPolygonAtlas(
  face: string,
  sources: readonly PolygonSource[],
  options: PolygonAtlasOptions = {},
): Promise<PolygonFontJson> {
  if (sources.length === 0) throw new Error(`${face}: no font data to build an atlas from.`)
  const charset = options.charset ?? CHARSET
  const curveToleranceEm = options.curveToleranceEm ?? DEFAULT_CURVE_TOLERANCE_EM

  const fonts = await Promise.all(sources.map((source) => TtfFont.parse(source.data, { curveToleranceEm })))
  const primary = fonts[0]
  for (const font of fonts) {
    if (font.unitsPerEm !== primary.unitsPerEm) {
      throw new Error(`${face}: its files disagree on units per em (${font.unitsPerEm} and ${primary.unitsPerEm}).`)
    }
  }

  // Which file draws each code point: the one that named it, or the first that has a glyph.
  const drawnBy = new Map<number, TtfFont>()
  for (const [index, source] of sources.entries()) {
    const font = fonts[index]
    const offered = source.provides ?? charset
    for (const codePoint of offered) {
      // A code point no file has a glyph for is left out entirely, exactly as it is left out of
      // the MSDF charset - the shaper then spaces it rather than drawing a tofu box.
      if (!drawnBy.has(codePoint) && font.hasGlyph(codePoint)) drawnBy.set(codePoint, font)
    }
  }

  // Measuring up front is what an atlas IS: the runtime does no measuring at all, so every code
  // point an application may draw is resolved here. Each font measures only what it draws.
  for (const font of fonts) {
    const mine = charset.filter((codePoint) => drawnBy.get(codePoint) === font)
    if (mine.length > 0) font.ensure(charsetText(mine))
  }

  const glyphs: PolygonGlyphJson[] = []
  for (const codePoint of charset) {
    const font = drawnBy.get(codePoint)
    if (!font) continue
    const metrics = font.metrics.glyphs.get(codePoint)
    if (!metrics) continue

    const glyph: PolygonGlyphJson = { codePoint, advance: round(metrics.xadvance) }
    // A blank glyph (space) has no box and no rings, and the absent fields say so; it still
    // advances the pen, which is the whole reason it has an entry.
    if (metrics.width > 0 && metrics.height > 0) {
      glyph.x = round(metrics.xoffset)
      glyph.y = round(metrics.yoffset)
      glyph.width = round(metrics.width)
      glyph.height = round(metrics.height)
    }
    const contours = font.contours(codePoint)
    if (contours && contours.length > 0) {
      // Flattened to [x, y, x, y, ...] whole font units. At 2048 units per em the rounding is
      // 1/2048 em - far below the curve tolerance the outline was flattened at - and it makes
      // the file a fraction of the size the same numbers would be as floats.
      glyph.rings = contours.map((contour) => contour.points.flatMap((point) => [round(point.x), round(point.y)]))
    }
    glyphs.push(glyph)
  }

  // Every ordered pair over the charset, keeping the ones that actually kern. The runtime
  // cannot ask the font a question later, so the question is asked exhaustively now: 95
  // characters is 9,025 pairs, which takes a few milliseconds and yields a few hundred. A pair
  // whose two glyphs come from different files has no entry to find - kerning is a fact one
  // file holds about two glyphs it draws itself.
  const kernings: [number, number, number][] = []
  for (const first of charset) {
    const font = drawnBy.get(first)
    if (!font) continue
    for (const second of charset) {
      if (drawnBy.get(second) !== font) continue
      const amount = font.kerning(first, second)
      if (amount !== 0) kernings.push([first, second, round(amount)])
    }
  }

  return {
    format: POLYGON_ATLAS_FORMAT,
    face,
    unitsPerEm: primary.unitsPerEm,
    base: primary.metrics.base,
    lineHeight: primary.metrics.lineHeight,
    curveToleranceEm,
    decoration: primary.metrics.decoration,
    glyphs,
    kernings,
  }
}

/** Whole font units. -0 is normalized away so the JSON never carries a "-0". */
function round(value: number): number {
  const rounded = Math.round(value)
  return rounded === 0 ? 0 : rounded
}

async function main(): Promise<void> {
  const { faces, skipped } = await readFontFaces()
  await mkdir(OUT, { recursive: true })

  for (const face of faces) {
    process.stdout.write(`Generating ${face.base}.polygons.json ... `)

    const atlas = await buildPolygonAtlas(face.base, face.sources)
    const text = `${JSON.stringify(atlas)}\n`
    await writeFile(join(OUT, `${face.base}.polygons.json`), text)

    const points = atlas.glyphs.reduce(
      (total, glyph) => total + (glyph.rings?.reduce((n, ring) => n + ring.length / 2, 0) ?? 0),
      0,
    )
    const kb = (text.length / 1024).toFixed(0)
    process.stdout.write(`ok (${atlas.glyphs.length} glyphs, ${points} points, ${atlas.kernings.length} kernings, ${kb} kB)\n`)
    if (face.sources.length > 1) process.stdout.write(`  from ${describeSources(face)}\n`)
  }

  reportSkipped(skipped)
  console.log(`Wrote ${faces.length} polygon atlases to packages/scripts/out/polygons/`)
  console.log('Copy the ones your application draws with into its own font folder.')
}

// Only when run as a tool: the self-test imports buildPolygonAtlas from here.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
