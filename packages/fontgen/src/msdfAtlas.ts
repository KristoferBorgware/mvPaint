// One face in, an MSDF atlas out: a PNG page and the glyph metrics that index it.
//
// MSDF (multi-channel signed distance field) glyphs stay crisp at any size and zoom from a
// single atlas, so one atlas per face serves every font size the renderer draws. The document
// is the BMFont/Hiero layout the engine reads - chars, kernings, common, distanceField - plus a
// `decoration` block (underline/strikethrough position and thickness, as em fractions read from
// the font tables) that the runtime uses to place text-decoration lines.
//
// THE PACKER IS AN OPTIONAL PEER. msdf-bmfont-xml and the tree it brings with it are what makes
// a distance field; the vector path needs none of it. So it is imported the first time a face
// is packed rather than when this module loads, and a project that only generates outlines
// never installs it. Asking for MSDF without it names the package to install.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TtfFont } from '@mvpaint/ttf'
import type { BmDecoration, MsdfFontJson } from '@mvpaint/engine/core'
import { charsetText } from './charset'
import type { FontFace } from './fontSources'

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
export const TEXTURE_SIZE = 2048

/** The document the packer hands back, before the decoration block is added to it. */
interface PackerJson extends MsdfFontJson {
  info: { face: string; size: number; charset: string[] }
}

interface GeneratedTexture {
  filename: string
  texture: Buffer
}

/** What one call to the packer produced, plus the state a following call continues from. */
interface GeneratedPass {
  textures: GeneratedTexture[]
  json: PackerJson
  settings: unknown
}

type Packer = (
  data: Buffer,
  options: Record<string, unknown>,
  done: (err: Error | null, textures: GeneratedTexture[], font: { data: string; settings: unknown }) => void,
) => void

/** One face's atlas: the page, and the metrics document that indexes it. */
export interface MsdfAtlas {
  /** The BMFont document with the decoration block added, exactly as it is written out. */
  metrics: MsdfFontJson
  /** The page, as PNG bytes. */
  page: Buffer
  /** The page's size in texels, which is what one layer of the engine's atlas array allocates. */
  width: number
  height: number
}

let packer: Promise<Packer> | undefined

/**
 * The packer, imported on first use and held for the rest of the process.
 *
 * `load` is a parameter so the self-test can walk both failure paths without installing or
 * removing anything. A caller that names its own loader gets its own result: the cache is for
 * the import this module would otherwise repeat once per face.
 */
export function loadPacker(load?: () => Promise<unknown>): Promise<Packer> {
  if (load !== undefined) return importPacker(load)
  packer ??= importPacker(() => import('msdf-bmfont-xml')).catch((err: unknown) => {
    // Cleared, so a later call tries the import again rather than replaying this rejection.
    packer = undefined
    throw err
  })
  return packer
}

/**
 * A package that is not installed and a package that throws while loading arrive here as the
 * same rejected import, so only the first is turned into the install instruction - anything
 * else is a real failure inside a package that IS present, and rewording it would bury it.
 */
async function importPacker(load: () => Promise<unknown>): Promise<Packer> {
  try {
    return ((await load()) as { default: Packer }).default
  } catch (cause: unknown) {
    const code = (cause as { code?: string } | null)?.code
    if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') throw cause
    throw new Error(
      'MSDF atlases need msdf-bmfont-xml, which @mvpaint/fontgen leaves to the project to install:\n' +
        '  npm install --save-dev msdf-bmfont-xml\n' +
        'Polygon atlases do not use it, so generating those needs nothing further.',
      { cause },
    )
  }
}

// Promise wrapper around the callback-style packer. `reuse` is a path to the state an earlier
// call wrote: given one, the packer continues into the page that call left behind.
async function pack(data: ArrayBuffer, filename: string, charset: string, reuse?: string): Promise<GeneratedPass> {
  const generateBMFont = await loadPacker()
  return new Promise((resolve, reject) => {
    generateBMFont(
      Buffer.from(data),
      {
        outputType: 'json',
        fieldType: 'msdf',
        // A path rather than a bare name: the folder the packer reads an earlier page from is
        // the one this names.
        filename,
        charset,
        fontSize: FONT_SIZE,
        distanceRange: DISTANCE_RANGE,
        textureSize: [TEXTURE_SIZE, TEXTURE_SIZE],
        smartSize: true,
        ...(reuse === undefined ? {} : { reuse }),
      },
      (err, textures, font) => {
        if (err) return reject(err)
        resolve({ textures, json: JSON.parse(font.data) as PackerJson, settings: font.settings })
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
async function readDecoration(data: ArrayBuffer): Promise<BmDecoration> {
  const font = await TtfFont.parse(data)
  return font.metrics.decoration
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
 * A pass hands the page to the next one through a file, so the passes run in a temporary folder
 * of their own. What comes back is bytes; writing them anywhere is the caller's.
 */
export async function buildMsdfAtlas(face: FontFace): Promise<MsdfAtlas> {
  const scratch = await mkdtemp(join(tmpdir(), 'mvpaint-fontgen-'))
  const state = join(scratch, 'packer.json')
  const png = join(scratch, `${face.base}.png`)
  let merged: PackerJson | undefined
  let page: Buffer | undefined

  try {
    for (const [index, source] of face.sources.entries()) {
      const pass = await pack(
        source.data,
        join(scratch, face.base),
        charsetText(source.provides),
        index === 0 ? undefined : state,
      )
      // One page per style is what the engine can sample: the layer of the shared atlas array a
      // glyph reads from is its STYLE, so a second page has nowhere to live and its glyphs would
      // silently take the first page's texels. Stopping here is the guard against that.
      if (pass.textures.length !== 1) {
        throw new Error(
          `${face.base}: ${source.provides.length} glyphs did not fit one ${TEXTURE_SIZE}x${TEXTURE_SIZE} page ` +
            `(the packer opened ${pass.textures.length}). Narrow the charset, or raise TEXTURE_SIZE and accept ` +
            "that pages above 2048 fail on machines that only guarantee WebGL2's minimum.",
        )
      }
      page = pass.textures[0].texture

      if (!merged) merged = pass.json
      else {
        merged.chars.push(...pass.json.chars)
        merged.kernings.push(...pass.json.kernings)
        merged.info.charset.push(...pass.json.info.charset)
        // The page every pass has drawn into is the one the last pass sized.
        merged.common.scaleW = pass.json.common.scaleW
        merged.common.scaleH = pass.json.common.scaleH
      }

      // What the next pass reads: the page to draw into, and the packer state that says where
      // on it everything already sits.
      if (index < face.sources.length - 1) {
        await writeFile(png, page)
        await writeFile(state, JSON.stringify(pass.settings))
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }

  // Single page, and named for the face rather than for the path the packer was handed. The
  // face's metrics come from its primary file, the same one the packer sized the page to.
  merged!.pages = [`${face.base}.png`]
  merged!.info.face = face.base
  merged!.decoration = await readDecoration(face.sources[0].data)

  return { metrics: merged!, page: page!, width: merged!.common.scaleW, height: merged!.common.scaleH }
}
