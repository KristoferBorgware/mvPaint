// Offline generator: font file -> MSDF atlas PNG + glyph-metrics JSON, one pair per style.
// MSDF (multi-channel signed distance field) glyphs stay crisp at any size and zoom from a
// single atlas, so one atlas per style serves every font size the renderer draws. Run with:
//   npm run gen:msdf         (or: npx tsx text/msdf/genMsdfAtlas.ts)
//
// Input is the fonts/ FOLDER, enumerated (see ../fontSources.ts) - this tool knows about no
// particular typeface, Inter included. Output goes to out/msdf/, which is generated and
// gitignored; copying what you want into your application is a deliberate step, because an
// atlas is the APPLICATION's asset. It hands it to createSceneRenderer through the `fonts`
// option.
//
// The engine has no copy of its own and no fallback: an application that supplies no fonts
// draws no text. The only Inter in this repository is the example app's, under
// packages/example-app/public/fonts/, copied in from here by hand like any other application's
// would be. Regenerating does not touch it; updating it is a deliberate copy.
//
// Each JSON is the BMFont/Hiero layout (chars, kernings, common, distanceField) plus a
// `decoration` block (underline/strikethrough position + thickness, as em fractions read
// from the font tables) that the runtime uses to place text-decoration lines.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import generateBMFont from 'msdf-bmfont-xml'
import { TtfFont } from '@mvpaint/ttf'
import { OUT_DIR, readFontSources } from '../fontSources'

const OUT = join(OUT_DIR, 'msdf')

// Printable ASCII (0x20..0x7E). Extending this set means regenerating the atlases and, if the
// glyphs no longer fit, raising TEXTURE_SIZE.
const CHARSET = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)).join('')

const FONT_SIZE = 42 // SDF generation size in px; runtime scales freely from it.
const DISTANCE_RANGE = 4 // SDF spread in px; the shader uses it for the screen-px conversion.
const TEXTURE_SIZE = 512 // one page must hold the whole charset (asserted below).

type BmDecoration = import('@mvpaint/engine/core').BmDecoration

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
  const sources = await readFontSources()
  await mkdir(OUT, { recursive: true })

  for (const { base, path: fontPath } of sources) {
    process.stdout.write(`Generating ${base} ... `)

    const { textures, json } = await generate(fontPath, base)
    if (textures.length !== 1) {
      throw new Error(`${base}: charset spilled onto ${textures.length} pages; raise TEXTURE_SIZE`)
    }

    // Single page: normalize the JSON to name exactly one page and embed decoration metrics.
    json.pages = [`${base}.png`]
    const augmented = { ...json, decoration: await readDecoration(fontPath) }

    await writeFile(join(OUT, `${base}.png`), textures[0].texture)
    await writeFile(join(OUT, `${base}.json`), `${JSON.stringify(augmented)}\n`)
    process.stdout.write(`ok (${json.chars.length} glyphs, ${json.kernings.length} kernings)\n`)
  }

  console.log(`Wrote ${sources.length} MSDF atlases to packages/scripts/out/msdf/`)
  console.log('Copy the ones your application draws with into its own font folder.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
