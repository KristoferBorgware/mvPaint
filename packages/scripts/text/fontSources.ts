// What both generators take as input: a FOLDER of font files, enumerated.
//
// Neither tool holds a list of faces any more. Drop `MyFace-Bold.ttf` into fonts/ and the next
// run generates an atlas for it; delete one and its atlas stops being generated. That is the
// difference between a tool that happens to know about Inter and a tool that turns fonts into
// atlases - and Inter is now just what this repository keeps in the folder.
//
// NAMING IS THE CONTRACT. A file is `<Family>-<Style>.ttf`, and the style suffix is one of the
// four the renderer selects between per run (see STYLE_ORDER in the engine): Regular, Bold,
// Italic, BoldItalic. Case and separators are ignored, so `Inter-BoldItalic.ttf`,
// `inter-bold-italic.otf` and `Inter-italicBold.ttf` all name the same style. A file with no
// suffix at all is taken as Regular, which is what a single-weight face usually is.
//
// The output name is `<family>-<style>`, lowercased - `Inter-BoldItalic.ttf` becomes
// `inter-bold-italic`. Both tools derive it from here, so an MSDF atlas and a polygon atlas
// for the same face always agree on what they are called.

import { readdir } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FontStyle } from '@mvpaint/engine/core'

/** The folder both generators read. Everything in it that is a font file is generated. */
export const FONT_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'fonts')

/** Where both generators write. Committed nowhere - copy what you want into your app. */
export const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'out')

const FONT_EXTENSIONS = new Set(['.ttf', '.otf'])

/** One font file to generate from. */
export interface FontSource {
  /** Lowercased family, e.g. `inter`. */
  family: string
  /** The style the renderer will resolve this face as. */
  style: FontStyle
  /** Output basename, `<family>-<style>`, e.g. `inter-bold-italic`. */
  base: string
  /** The file's name within the folder, e.g. `Inter-BoldItalic.ttf`. */
  file: string
  /** Absolute path to it. */
  path: string
}

/**
 * Style suffixes, matched after everything but the letters is stripped. Longest first, so
 * `bolditalic` is not read as `bold` with a stray tail.
 */
const STYLE_SUFFIXES: readonly { key: string; style: FontStyle }[] = [
  { key: 'bolditalic', style: 'bold-italic' },
  { key: 'italicbold', style: 'bold-italic' },
  { key: 'bold', style: 'bold' },
  { key: 'italic', style: 'italic' },
  { key: 'regular', style: 'regular' },
]

/**
 * Split `Inter-BoldItalic` into a family and a style.
 *
 * Returns null rather than guessing when the suffix is not one of the four. A face this cannot
 * place is a face the renderer could not select either, and silently filing it under Regular
 * would put it in the same output file as the real Regular - so the caller reports it instead.
 */
export function parseFontName(stem: string): { family: string; style: FontStyle } | null {
  const dash = stem.indexOf('-')
  // No suffix: a single-weight face, which is a Regular as far as the style ladder is concerned.
  if (dash < 0) return { family: stem.toLowerCase(), style: 'regular' }

  const family = stem.slice(0, dash).toLowerCase()
  const suffix = stem.slice(dash + 1).replace(/[^a-z]/gi, '').toLowerCase()
  const match = STYLE_SUFFIXES.find((candidate) => candidate.key === suffix)
  return match ? { family, style: match.style } : null
}

/**
 * Enumerate the font folder.
 *
 * Non-font files are skipped in silence - the folder also holds the typeface's licence, and
 * will hold whatever else a developer leaves there. A font file whose name does not parse is an
 * error, because the alternative is a face that quietly never gets an atlas.
 */
export async function readFontSources(dir: string = FONT_SRC): Promise<FontSource[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const sources: FontSource[] = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const extension = extname(entry.name).toLowerCase()
    if (!FONT_EXTENSIONS.has(extension)) continue

    const parsed = parseFontName(entry.name.slice(0, -extension.length))
    if (!parsed) {
      throw new Error(
        `${entry.name}: cannot tell which style this is. Name font files <Family>-<Style>.ttf, ` +
          'where <Style> is Regular, Bold, Italic or BoldItalic.',
      )
    }

    sources.push({
      family: parsed.family,
      style: parsed.style,
      base: `${parsed.family}-${parsed.style}`,
      file: entry.name,
      path: join(dir, entry.name),
    })
  }

  // Deterministic output order, so two runs of a generator print their lines the same way.
  sources.sort((a, b) => a.base.localeCompare(b.base))

  const seen = new Map<string, string>()
  for (const source of sources) {
    const previous = seen.get(source.base)
    if (previous) throw new Error(`${source.file} and ${previous} are both the ${source.base} face.`)
    seen.set(source.base, source.file)
  }

  if (sources.length === 0) throw new Error(`No font files in ${dir} - nothing to generate.`)
  return sources
}
