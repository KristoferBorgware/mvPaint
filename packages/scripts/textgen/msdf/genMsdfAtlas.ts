// Offline generator: font files in, MSDF atlas PNG + glyph-metrics JSON out, one pair per face.
// MSDF (multi-channel signed distance field) glyphs stay crisp at any size and zoom from a
// single atlas, so one atlas per face serves every font size the renderer draws. Run with:
//   npm run gen:msdf                        the default charset (see ../charset.ts)
//   npm run gen:msdf -- --charset latin     a named set, code points, or @a file of characters
//
// Input is the fonts/ FOLDER, enumerated (see ../fontSources.ts) - this tool knows about no
// particular typeface, and takes .ttf, .otf and .woff2 alike. Output goes to out/msdf/, which is
// generated and gitignored; copying what you want into your application is a deliberate step,
// because an atlas is the APPLICATION's asset. It hands it to createSceneRenderer through the
// `fonts` option.
//
// The engine has no copy of its own and no fallback: an application that supplies no fonts
// draws no text. The only Inter in this repository is the example app's, under
// packages/example-app/public/fonts/, copied in from here by hand like any other application's
// would be. Regenerating does not touch it; updating it is a deliberate copy.
//
// Each JSON is the BMFont/Hiero layout (chars, kernings, common, distanceField) plus a
// `decoration` block (underline/strikethrough position + thickness, as em fractions read
// from the font tables) that the runtime uses to place text-decoration lines.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import generateBMFont from 'msdf-bmfont-xml'
import { TtfFont } from '@mvpaint/ttf'
import { charsetFromArgv, charsetText, describeCharset, resolveCharset } from '../charset'
import { OUT_DIR, describeSources, readFontFaces, reportSkipped, type FontFace } from '../fontSources'

const OUT = join(OUT_DIR, 'msdf')

const FONT_SIZE = 42 // SDF generation size in px; runtime scales freely from it.
const DISTANCE_RANGE = 4 // SDF spread in px; the shader uses it for the screen-px conversion.

/**
 * The largest page the packer may open, and so the ceiling on a charset.
 *
 * A CAP, not a size: `smartSize` shrinks each page to the glyphs it was actually given, so
 * printable ASCII packs to around 300x300 whether this says 512 or 2048. Raising it buys
 * headroom and nothing else pays for it.
 *
 * 2048 because that is WebGL2's guaranteed MAX_TEXTURE_SIZE - a larger page would work on most
 * machines and fail on the ones that only promise the minimum. At roughly 1,200 texels a glyph
 * it holds some 3,400 of them, which is Latin, Greek, Cyrillic and Vietnamese together.
 */
const TEXTURE_SIZE = 2048

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
  info: { face: string; size: number; charset: string[] }
  common: { lineHeight: number; base: number; scaleW: number; scaleH: number }
  kernings: { first: number; second: number; amount: number }[]
  distanceField: { fieldType: string; distanceRange: number }
}

interface GeneratedTexture {
  filename: string
  texture: Buffer
}

/** What one call to the packer produced, plus the state a following call continues from. */
interface GeneratedPass {
  textures: GeneratedTexture[]
  json: BmFontJson
  settings: unknown
}

// Promise wrapper around the callback-style generator. `reuse` is a path to the state an
// earlier call wrote: given one, the packer continues into the page that call left behind.
function generate(data: ArrayBuffer, base: string, charset: string, reuse?: string): Promise<GeneratedPass> {
  return new Promise((resolve, reject) => {
    generateBMFont(
      Buffer.from(data),
      {
        outputType: 'json',
        fieldType: 'msdf',
        // A path rather than a bare name: the folder the packer reads an earlier page from is
        // the one this names.
        filename: join(OUT, base),
        charset,
        fontSize: FONT_SIZE,
        distanceRange: DISTANCE_RANGE,
        textureSize: [TEXTURE_SIZE, TEXTURE_SIZE],
        smartSize: true,
        ...(reuse === undefined ? {} : { reuse }),
      },
      (err: Error | null, textures: GeneratedTexture[], font: { data: string; settings: unknown }) => {
        if (err) return reject(err)
        resolve({ textures, json: JSON.parse(font.data) as BmFontJson, settings: font.settings })
      },
    )
  })
}

/**
 * One face's atlas, packed from every file that draws part of the charset.
 *
 * The packer takes one font file per call, so a face spread over subset files is packed in
 * several passes. Each pass after the first is handed the packer state and the page the last
 * one wrote, and adds its glyphs to both; the page grows to fit, and what is already on it
 * keeps the position it was packed at. The metrics come from the first file - the one that
 * covers most of the face - and the page size from the last, which is the one with everything
 * on it.
 *
 * The PNG is written per pass because that is how the next pass receives it.
 */
async function generateFace(face: FontFace): Promise<BmFontJson> {
  const state = join(tmpdir(), `mvpaint-msdf-${face.base}.json`)
  const png = join(OUT, `${face.base}.png`)
  let merged: BmFontJson | undefined

  try {
    for (const [index, source] of face.sources.entries()) {
      const pass = await generate(source.data, face.base, charsetText(source.provides), index === 0 ? undefined : state)
      // One page per style is what the engine can sample: the layer of the shared atlas array a
      // glyph reads from is its STYLE, so a second page has nowhere to live and its glyphs would
      // silently take the first page's texels. Stopping here is the guard against that.
      if (pass.textures.length !== 1) {
        throw new Error(
          `${face.base}: ${source.provides.length} glyphs did not fit one ${TEXTURE_SIZE}x${TEXTURE_SIZE} page ` +
            `(the packer opened ${pass.textures.length}). Narrow the charset, or raise TEXTURE_SIZE and accept ` +
            'that pages above 2048 fail on machines that only guarantee WebGL2\'s minimum.',
        )
      }
      await writeFile(png, pass.textures[0].texture)

      if (!merged) merged = pass.json
      else {
        merged.chars.push(...pass.json.chars)
        merged.kernings.push(...pass.json.kernings)
        merged.info.charset.push(...pass.json.info.charset)
        // The page every pass has drawn into is the one the last pass sized.
        merged.common.scaleW = pass.json.common.scaleW
        merged.common.scaleH = pass.json.common.scaleH
      }

      if (index < face.sources.length - 1) await writeFile(state, JSON.stringify(pass.settings))
    }
  } finally {
    await rm(state, { force: true })
  }

  // Single page, and named for the face rather than for the path the packer was handed.
  merged!.pages = [`${face.base}.png`]
  merged!.info.face = face.base
  return merged!
}

/**
 * Underline / strikethrough placement and thickness, in em fractions (baseline at 0, +y up).
 *
 * Read through @mvpaint/ttf rather than through a second reading of the same tables here: the
 * polygon atlas next door writes the same four numbers, and the vector and MSDF paths drawing
 * a decoration in different places would be a hard bug to see and an easy one to introduce.
 * One reader, one answer.
 */
async function readDecoration(data: ArrayBuffer): Promise<BmDecoration> {
  const font = await TtfFont.parse(data)
  return font.metrics.decoration
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const spec = charsetFromArgv(argv)
  const charset = await resolveCharset(spec)
  const { faces, skipped } = await readFontFaces(charset)
  await mkdir(OUT, { recursive: true })

  console.log(`Charset: ${describeCharset(spec, charset)}`)

  let widest = 0
  let tallest = 0
  for (const face of faces) {
    process.stdout.write(`Generating ${face.base} ... `)

    const json = await generateFace(face)
    // The face's metrics come from its primary file, the same one the packer sized the page to.
    const augmented = { ...json, decoration: await readDecoration(face.sources[0].data) }

    await writeFile(join(OUT, `${face.base}.json`), `${JSON.stringify(augmented)}\n`)
    const { scaleW, scaleH } = json.common
    widest = Math.max(widest, scaleW)
    tallest = Math.max(tallest, scaleH)
    process.stdout.write(`ok (${json.chars.length} glyphs, ${json.kernings.length} kernings, ${scaleW}x${scaleH} page)\n`)
    if (face.sources.length > 1) process.stdout.write(`  from ${describeSources(face)}\n`)
  }

  reportSkipped(skipped)
  console.log(`Wrote ${faces.length} MSDF atlases to packages/scripts/textgen/out/msdf/`)
  // An application's layer size is the largest page across the styles of ONE family, so this is
  // the worst case rather than what any single family allocates. Four layers of it, at four
  // bytes a texel, is what a family costs in texture memory.
  console.log(
    `Largest page ${widest}x${tallest} of ${TEXTURE_SIZE}x${TEXTURE_SIZE} - ` +
      `${((widest * tallest * 4 * 4) / 1024 / 1024).toFixed(1)} MB of texture for a family at that size.`,
  )
  console.log('Copy the ones your application draws with into its own font folder.')
}

// Only when run as a tool: genFonts.ts imports main() to run both generators over one charset.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
