// What both generators take as input: a FOLDER of font files, enumerated and grouped into faces.
//
// Neither generator holds a list of typefaces. Drop a file into the folder and the next run
// generates an atlas for it; take one out and it stops.
//
// THE FILE SAYS WHICH FACE IT IS. A font names its own family in the `name` table and marks
// bold and italic in `head.macStyle`, and that is what these tools read.
// `Poppins-700-italic-latin.woff2` and `Poppins-BoldItalic.ttf` both resolve to Poppins in the
// bold-italic style, because both files say so inside. A filename is used only to report which
// file something came from.
//
// The output basename is `<family>-<style>`: the family lowercased with everything that is not
// a letter or digit collapsed to a dash, and one of the four styles the renderer selects
// between per run (see STYLE_ORDER in the engine). A face is `poppins-bold-italic` whatever its
// file is called, and an MSDF atlas and a polygon atlas for it always agree on the name.
//
// A font whose family name carries a weight word announces itself that way. A static instance
// cut from a variable font at Light gives its family as `Quicksand Light`, so its atlas is
// `quicksand-light-regular` - the file's own account of what it is.
//
// WOFF2 IS UNPACKED HERE. A .woff2 is a brotli-compressed sfnt whose glyf and loca tables are
// stored re-encoded; wawoff2 turns it back into the TTF/OTF bytes opentype.js and msdfgen read.
// Both generators are handed those bytes, so nothing downstream knows which container a face
// arrived in.
//
// SEVERAL FILES CAN BE ONE FACE. Subset files - a `latin` slice beside a `latin-ext` one -
// carry the same family and style and different parts of the character set, so they collect
// into one face and one atlas. Sources are ordered by how much of the charset each covers, then
// by how many glyphs the file holds, then by name; the first file that has a code point draws
// it, and the first file also supplies the face's metrics. A file that adds nothing an earlier
// one already provides is left out and reported.

import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import opentype, { type Font } from 'opentype.js'
import { decompress } from 'wawoff2'
import type { FontStyle } from '@mvpaint/engine/core'
import { DEFAULT_CHARSET } from './charset'

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.woff2'])

/** `head.macStyle`: bit 0 bold, bit 1 italic. */
const MAC_STYLE_BOLD = 0x01
const MAC_STYLE_ITALIC = 0x02
/** `OS/2.fsSelection`: bit 0 italic, bit 5 bold - the same claim, in the other table. */
const FS_SELECTION_ITALIC = 0x01
const FS_SELECTION_BOLD = 0x20

/** The weight a style is drawn at, which decides which file fills a slot several want. */
const STYLE_WEIGHT: Record<FontStyle, number> = { regular: 400, italic: 400, bold: 700, 'bold-italic': 700 }
/** What a font that gives no weight class is taken to be. */
const DEFAULT_WEIGHT = 400

/** One file, and the part of the charset it draws for its face. */
export interface FaceSource {
  /** The file's name within the folder, e.g. `Poppins-400-normal-latin.woff2`. */
  file: string
  /** Absolute path to it. */
  path: string
  /** Its sfnt bytes. A .woff2 arrives here decompressed. */
  data: ArrayBuffer
  /** Font units per em. Every file of one face agrees on this. */
  unitsPerEm: number
  /** The code points this file draws, in charset order. */
  provides: readonly number[]
}

/** One face: a family in a style, and the files it is drawn from. */
export interface FontFace {
  /** Lowercased family, e.g. `jetbrains-mono`. */
  family: string
  /** The style the renderer will resolve this face as. */
  style: FontStyle
  /** Output basename, `<family>-<style>`, e.g. `poppins-bold-italic`. */
  base: string
  /** Primary first: it supplies the metrics, and the rest fill in what it lacks. */
  sources: readonly FaceSource[]
}

/**
 * Why a font file is in no atlas.
 *
 * `no-charset-coverage`: it draws none of the characters asked for.
 * `already-drawn`: another file of the same face draws everything it covers - the case a
 * family of several weights competing for four style slots produces, where `drawnBy` names the
 * file that took the slot.
 */
export type SkipReason = 'no-charset-coverage' | 'already-drawn'

/** A file that is not part of any atlas. */
export interface SkippedFile {
  /** The file's name within the folder. */
  file: string
  /** Absolute path to it. */
  path: string
  /** The face it would have joined, `<family>-<style>`. */
  face: string
  reason: SkipReason
  /** For `already-drawn`, the file of that face which draws everything this one covers. */
  drawnBy?: string
  /** The sentence a run prints about it. */
  message: string
}

/** The folder, read. */
export interface FontFolder {
  /** Absolute path to the folder these faces were read from. */
  dir: string
  faces: readonly FontFace[]
  skipped: readonly SkippedFile[]
}

/**
 * A font file's bytes as sfnt. A .woff2 is unpacked; anything else is sfnt already.
 *
 * The name is what decides, so this can be asked about bytes that are not on disk - which is
 * how the self-test puts a woff2 through the same door a folder file goes through.
 */
export async function toSfnt(file: string, bytes: Uint8Array): Promise<ArrayBuffer> {
  const sfnt = extname(file).toLowerCase() === '.woff2' ? Buffer.from(await decompress(bytes)) : bytes
  return sfnt.buffer.slice(sfnt.byteOffset, sfnt.byteOffset + sfnt.byteLength) as ArrayBuffer
}

/**
 * A family name as an output basename: lowercased, with each run of anything that is not a
 * letter or digit turned into one dash. `JetBrains Mono` -> `jetbrains-mono`,
 * `Merriweather Light 18pt` -> `merriweather-light-18pt`.
 */
function slugify(family: string): string {
  return family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The family and style a font declares.
 *
 * The family is the typographic family name where the font has one and the family name
 * otherwise - the pair exists so that a face outside the regular/bold/italic/bold-italic set
 * can name the family it belongs to, and the typographic one is the answer when they differ.
 *
 * The style is `head.macStyle`'s two bits, with `OS/2.fsSelection`'s matching pair as a second
 * reading. Weight class stays out of it: a font at semibold usually says so in its family name
 * rather than in the bold bit, and reading 600 as bold would file `Poppins SemiBold` under a
 * style its own tables do not claim.
 */
function identify(font: Font, file: string): { family: string; style: FontStyle } {
  const declared = font.getEnglishName('preferredFamily') ?? font.getEnglishName('fontFamily')
  const family = declared ? slugify(declared) : ''
  if (!family) {
    throw new Error(`${file}: the font declares no family name, so there is nothing to call its atlas.`)
  }

  const macStyle = font.tables.head.macStyle
  const fsSelection = font.tables.os2?.fsSelection ?? 0
  const bold = (macStyle & MAC_STYLE_BOLD) !== 0 || (fsSelection & FS_SELECTION_BOLD) !== 0
  const italic = (macStyle & MAC_STYLE_ITALIC) !== 0 || (fsSelection & FS_SELECTION_ITALIC) !== 0

  return { family, style: bold ? (italic ? 'bold-italic' : 'bold') : italic ? 'italic' : 'regular' }
}

/** A file as read from the folder, before its face is assembled. */
interface Candidate {
  file: string
  path: string
  data: ArrayBuffer
  unitsPerEm: number
  family: string
  style: FontStyle
  base: string
  /** The code points of the charset this file has a glyph for. */
  has: readonly number[]
  /** Glyphs in the file: the tie-break between two files that cover the charset equally. */
  glyphs: number
  /** `OS/2.usWeightClass`, which ranks files competing for one style's slot. */
  weight: number
}

/**
 * Enumerate the font folder and group what is in it into faces.
 *
 * Non-font files are skipped in silence - the folder also holds the typefaces' licences, and
 * whatever else a developer leaves there. A font file that cannot be identified is an error,
 * because the alternative is a face that never gets an atlas and never says why.
 */
export async function readFontFaces(dir: string, charset: readonly number[] = DEFAULT_CHARSET): Promise<FontFolder> {
  const entries = await readdir(dir, { withFileTypes: true })
  const candidates: Candidate[] = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!FONT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue

    const path = join(dir, entry.name)
    const data = await toSfnt(entry.name, await readFile(path))
    const font = opentype.parse(data)
    const { family, style } = identify(font, entry.name)

    candidates.push({
      file: entry.name,
      path,
      data,
      unitsPerEm: font.unitsPerEm,
      family,
      style,
      base: `${family}-${style}`,
      has: charset.filter((codePoint) => font.charToGlyphIndex(String.fromCodePoint(codePoint)) > 0),
      glyphs: font.numGlyphs,
      weight: font.tables.os2?.usWeightClass ?? DEFAULT_WEIGHT,
    })
  }

  if (candidates.length === 0) throw new Error(`No font files in ${dir} - nothing to generate.`)

  const grouped = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const group = grouped.get(candidate.base)
    if (group) group.push(candidate)
    else grouped.set(candidate.base, [candidate])
  }

  const faces: FontFace[] = []
  const skipped: SkippedFile[] = []

  // Faces in name order, so two runs of a generator print their lines the same way.
  for (const [base, group] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    // Most of the charset first, so a whole typeface leads a subset of it and the widest subset
    // leads the rest. Then the weight nearest the one the style is drawn at: a family whose
    // files all name the same typographic family arrives as several weights competing for four
    // slots, and 400 is the regular of that set even though 300 and 500 claim the style too.
    // Then the fuller file, then the name, so the order never depends on the folder's.
    const target = STYLE_WEIGHT[group[0].style]
    group.sort(
      (a, b) =>
        b.has.length - a.has.length ||
        Math.abs(a.weight - target) - Math.abs(b.weight - target) ||
        b.glyphs - a.glyphs ||
        a.file.localeCompare(b.file),
    )

    const primary = group[0]
    const claimed = new Set<number>()
    const sources: FaceSource[] = []

    for (const candidate of group) {
      const provides = candidate.has.filter((codePoint) => !claimed.has(codePoint))
      if (provides.length === 0) {
        const drawnBy = sources[0]?.file
        skipped.push({
          file: candidate.file,
          path: candidate.path,
          face: base,
          reason: drawnBy === undefined ? 'no-charset-coverage' : 'already-drawn',
          ...(drawnBy === undefined ? {} : { drawnBy }),
          message:
            drawnBy === undefined
              ? `Skipped ${candidate.file}: it has none of the charset.`
              : `Skipped ${candidate.file}: ${base} already draws everything it covers, from ${drawnBy}.`,
        })
        continue
      }

      // Whole font units are the atlas's unit system, and a second file measured in another
      // one would place its glyphs against the wrong em.
      if (candidate.unitsPerEm !== primary.unitsPerEm) {
        throw new Error(
          `${candidate.file} and ${primary.file} are both ${base}, but one is ${candidate.unitsPerEm} ` +
            `units per em and the other ${primary.unitsPerEm}. One face is drawn in one unit system.`,
        )
      }

      for (const codePoint of provides) claimed.add(codePoint)
      sources.push({
        file: candidate.file,
        path: candidate.path,
        data: candidate.data,
        unitsPerEm: candidate.unitsPerEm,
        provides,
      })
    }

    // A face none of whose files draws a character of the charset has no atlas to generate.
    // Every one of its files is already in `skipped`, each saying so.
    if (sources.length === 0) continue

    faces.push({ family: primary.family, style: primary.style, base, sources })
  }

  if (faces.length === 0) throw new Error(`Nothing in ${dir} draws any of the charset - no atlas to generate.`)
  return { dir, faces, skipped }
}

/** `Poppins-400-normal-latin.woff2 (95) + Poppins-400-normal-latin-ext.woff2 (30)`. */
export function describeSources(face: FontFace): string {
  return face.sources.map((source) => `${source.file} (${source.provides.length})`).join(' + ')
}
