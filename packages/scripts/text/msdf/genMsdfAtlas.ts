// Offline generator: font file -> MSDF atlas PNG + glyph-metrics JSON, one pair per style.
// MSDF (multi-channel signed distance field) glyphs stay crisp at any size and zoom from a
// single atlas, so one atlas per style serves every font size the renderer draws. Run with:
//   npm run gen:msdf         (or: npx tsx text/msdf/genMsdfAtlas.ts)
// The generated PNG/JSON are committed so the production build (which only runs `vite build`)
// and GitHub Pages serve them directly; this script is a manual dev-time regeneration step.
//
// Each JSON is the BMFont/Hiero layout (chars, kernings, common, distanceField) plus a
// `decoration` block (underline/strikethrough position + thickness, as em fractions read
// from the font tables) that the runtime uses to place text-decoration lines.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import generateBMFont from 'msdf-bmfont-xml'
import { TtfFont } from '@mvpaint/ttf'

const HERE = dirname(fileURLToPath(import.meta.url))
const FONT_SRC = join(HERE, '..', '..', 'fonts')
const OUT_DIR = join(HERE, '..', '..', '..', 'engine', 'src', 'text', 'fonts')

// One MSDF atlas per style. The four styles the renderer selects between per text run.
const STYLES = [
  { style: 'regular', file: 'Inter-Regular.ttf' },
  { style: 'bold', file: 'Inter-Bold.ttf' },
  { style: 'italic', file: 'Inter-Italic.ttf' },
  { style: 'bold-italic', file: 'Inter-BoldItalic.ttf' },
] as const

const FAMILY = 'inter'

// Printable ASCII (0x20..0x7E). Extending this set means regenerating the atlases and, if the
// glyphs no longer fit, raising TEXTURE_SIZE.
const CHARSET = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)).join('')

const FONT_SIZE = 42 // SDF generation size in px; runtime scales freely from it.
const DISTANCE_RANGE = 4 // SDF spread in px; the shader uses it for the screen-px conversion.
const TEXTURE_SIZE = 512 // one page must hold the whole charset (asserted below).

type BmDecoration = import('@mvpaint/engine/src/text/msdfMetrics').BmDecoration

interface BmChar {
  id: number
  x: number
  y: number
  width: number
  height: number
  xoffset: number
  yoffset: number
  xadvance: number
  page: number
}
interface BmFontJson {
  pages: string[]
  chars: BmChar[]
  info: { face: string; size: number }
  common: { lineHeight: number; base: number; scaleW: number; scaleH: number }
  kernings: { first: number; second: number; amount: number }[]
  distanceField: { fieldType: string; distanceRange: number }
}

interface GeneratedTexture {
  filename: string
  texture: Buffer
}

// Promise wrapper around the callback-style generator.
function generate(fontPath: string, name: string): Promise<{ textures: GeneratedTexture[]; json: BmFontJson }> {
  return new Promise((resolve, reject) => {
    generateBMFont(
      fontPath,
      {
        outputType: 'json',
        fieldType: 'msdf',
        filename: name,
        charset: CHARSET,
        fontSize: FONT_SIZE,
        distanceRange: DISTANCE_RANGE,
        textureSize: [TEXTURE_SIZE, TEXTURE_SIZE],
        smartSize: true,
      },
      (err: Error | null, textures: GeneratedTexture[], font: { data: string }) => {
        if (err) return reject(err)
        resolve({ textures, json: JSON.parse(font.data) as BmFontJson })
      },
    )
  })
}

/**
 * Underline / strikethrough placement and thickness, in em fractions (baseline at 0, +y up).
 *
 * Read through @mvpaint/ttf rather than through a second reading of the same tables here: the
 * polygon atlas next door writes the same four numbers, and the vector and MSDF paths drawing
 * a decoration in different places would be a hard bug to see and an easy one to introduce.
 * One reader, one answer.
 */
async function readDecoration(fontPath: string): Promise<BmDecoration> {
  const bytes = await readFile(fontPath)
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const font = await TtfFont.parse(data)
  return font.metrics.decoration
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })

  for (const { style, file } of STYLES) {
    const fontPath = join(FONT_SRC, file)
    const base = `${FAMILY}-${style}`
    process.stdout.write(`Generating ${base} ... `)

    const { textures, json } = await generate(fontPath, base)
    if (textures.length !== 1) {
      throw new Error(`${base}: charset spilled onto ${textures.length} pages; raise TEXTURE_SIZE`)
    }

    // Single page: normalize the JSON to name exactly one page and embed decoration metrics.
    json.pages = [`${base}.png`]
    const augmented = { ...json, decoration: await readDecoration(fontPath) }

    await writeFile(join(OUT_DIR, `${base}.png`), textures[0].texture)
    await writeFile(join(OUT_DIR, `${base}.json`), `${JSON.stringify(augmented)}\n`)
    process.stdout.write(`ok (${json.chars.length} glyphs, ${json.kernings.length} kernings)\n`)
  }

  console.log(`Wrote ${STYLES.length} MSDF atlases to packages/engine/src/text/fonts/`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
