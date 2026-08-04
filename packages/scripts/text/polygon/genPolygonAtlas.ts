// Offline generator: font file -> polygon atlas JSON, one per style.
//
// The vector text path draws real letterform geometry rather than sampling a distance field,
// and until now it got that geometry by parsing a TTF in the browser: 1.6 MB of font files
// plus a quarter-megabyte parser, spent every session to recompute an answer that never
// changes. Flattening the 'A' of Inter Regular is a fixed computation with a fixed result, so
// this does it once, here, and writes the result out as data the engine can simply read.
//
//   npm run gen:polygons        (or: npx tsx text/polygon/genPolygonAtlas.ts)
//
// Input is the fonts/ FOLDER, enumerated (see ../fontSources.ts) - this tool knows about no
// particular typeface. Output goes to out/polygons/, which is generated and gitignored: copying
// what you want into your application is a deliberate step, because an outline atlas is the
// APPLICATION's asset. It hands it to VectorText through the VectorFonts interface, and the
// engine ships none of them.
//
// WHAT IS IN A FILE. Per glyph: the flattened outline as closed rings of whole font units, the
// box and advance the shaper needs, and nothing else. Per file: the em size, the vertical
// metrics, the underline/strikethrough placement read from the font tables, and the non-zero
// kerning pairs over the charset. The engine's PolygonFont reads exactly this and triangulates
// each glyph the first time it is drawn.
//
// WHY IT IS NOT AN IMAGE. The MSDF tool next door packs glyph bitmaps into a texture; this one
// has no texture to pack, because the point of the vector path is that there is no sampling
// step at all. "Atlas" here means the same thing in the sense that matters: one file per style
// holding every glyph the application can draw, generated ahead of time.
//
// The extraction itself is @mvpaint/ttf's - the same code the runtime opt-in package uses - so
// a glyph baked into an atlas and the same glyph parsed live are identical geometry, and the
// self-test next to this file proves it rather than assuming it.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TtfFont, DEFAULT_CURVE_TOLERANCE_EM } from '@mvpaint/ttf'
import type { PolygonFontJson, PolygonGlyphJson } from '@mvpaint/engine/core'
import { POLYGON_ATLAS_FORMAT } from '@mvpaint/engine/core'
import { OUT_DIR, readFontSources } from '../fontSources'

const OUT = join(OUT_DIR, 'polygons')

/**
 * Printable ASCII (0x20..0x7E), which is the MSDF atlas's charset too - the two paths draw the
 * same characters, and a scene that switches between them should not change what is missing.
 * Extending this set means regenerating both.
 */
const CHARSET = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => 0x20 + i)

export interface PolygonAtlasOptions {
  /** Code points to include. Anything the font has no glyph for is skipped. */
  charset?: readonly number[]
  /** Curve flatness as a fraction of the em; the runtime cannot change this after the fact. */
  curveToleranceEm?: number
}

/**
 * Build one style's atlas document from a font file's bytes.
 *
 * Exported so the self-test can build one in memory and compare it against the live parser,
 * with nothing written to disk.
 */
export async function buildPolygonAtlas(
  face: string,
  data: ArrayBuffer,
  options: PolygonAtlasOptions = {},
): Promise<PolygonFontJson> {
  const charset = options.charset ?? CHARSET
  const curveToleranceEm = options.curveToleranceEm ?? DEFAULT_CURVE_TOLERANCE_EM
  const font = await TtfFont.parse(data, { curveToleranceEm })

  // Measuring the whole charset up front is what an atlas IS: the runtime does no measuring at
  // all, so every code point an application may draw has to be resolved here.
  font.ensure(String.fromCodePoint(...charset))

  const glyphs: PolygonGlyphJson[] = []
  for (const codePoint of charset) {
    const metrics = font.metrics.glyphs.get(codePoint)
    // A code point this font has no glyph for is left out entirely, exactly as it is left out
    // of the MSDF charset - the shaper then spaces it rather than drawing a tofu box.
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
  // characters is 9,025 pairs, which takes a few milliseconds and yields a few hundred.
  const kernings: [number, number, number][] = []
  for (const first of charset) {
    if (!font.hasGlyph(first)) continue
    for (const second of charset) {
      if (!font.hasGlyph(second)) continue
      const amount = font.kerning(first, second)
      if (amount !== 0) kernings.push([first, second, round(amount)])
    }
  }

  return {
    format: POLYGON_ATLAS_FORMAT,
    face,
    unitsPerEm: font.unitsPerEm,
    base: font.metrics.base,
    lineHeight: font.metrics.lineHeight,
    curveToleranceEm,
    decoration: font.metrics.decoration,
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
  const sources = await readFontSources()
  await mkdir(OUT, { recursive: true })

  for (const { base, file, path } of sources) {
    process.stdout.write(`Generating ${base}.polygons.json ... `)

    const bytes = await readFile(path)
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const atlas = await buildPolygonAtlas(file.replace(/\.(ttf|otf)$/i, ''), data)

    const text = `${JSON.stringify(atlas)}\n`
    await writeFile(join(OUT, `${base}.polygons.json`), text)

    const points = atlas.glyphs.reduce(
      (total, glyph) => total + (glyph.rings?.reduce((n, ring) => n + ring.length / 2, 0) ?? 0),
      0,
    )
    const kb = (text.length / 1024).toFixed(0)
    process.stdout.write(`ok (${atlas.glyphs.length} glyphs, ${points} points, ${atlas.kernings.length} kernings, ${kb} kB)\n`)
  }

  console.log(`Wrote ${sources.length} polygon atlases to packages/scripts/out/polygons/`)
  console.log('Copy the ones your application draws with into its own font folder.')
}

// Only when run as a tool: the self-test imports buildPolygonAtlas from here.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
