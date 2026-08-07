// The characters an atlas covers, and how a run chooses them.
//
// Both generators take their set from here rather than each declaring its own: a scene that
// switches a node between the MSDF and the vector path draws the same characters either way,
// and a character missing from one is missing from both. It is also what decides how a face is
// assembled - a face spread over several files hands each code point to the first of its files
// that has a glyph for it (see readFontFaces in fontSources.ts).
//
// WHAT A MISSING GLYPH DOES. A code point no font in the face has is left out of the atlas, and
// the shaper spaces it rather than drawing a tofu box. So widening the set is additive: it can
// only add letters, never change how the ones already there are drawn.
//
// WIDENING IT COSTS TEXTURE. The MSDF packer shrinks each page to the glyphs it was given, so
// the page grows with the set: printable ASCII packs to around 300x300 and `latin` to around
// 650x655. A page must stay under TEXTURE_SIZE in genMsdfAtlas.ts, and the engine samples one
// page per style - the array layer of the shared atlas texture IS the style, so there is no
// second page to address. The vector path has no such ceiling; its atlas is JSON.

import { readFile } from 'node:fs/promises'

const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)

/** Printable ASCII, U+0020..U+007E. */
const ASCII = range(0x20, 0x7e)

/**
 * Latin-1 Supplement from the no-break space up: the accented letters Western European
 * languages are written with - å ä ö, æ ø, é ü ñ ç ß - plus the degree, section and guillemet
 * punctuation that arrives with them.
 */
const LATIN1_SUPPLEMENT = range(0xa0, 0xff)

/** Latin Extended-A: the Central and Eastern European letters - š ž ł ő ć ę and the rest. */
const LATIN_EXTENDED_A = range(0x100, 0x17f)

/** Dashes, curly quotes, ellipsis, dagger, bullet and per-mille. */
const GENERAL_PUNCTUATION = [...range(0x2010, 0x2027), ...range(0x2030, 0x203a)]

/** Currency signs, of which the euro is the one Latin text actually reaches for. */
const CURRENCY = range(0x20a0, 0x20bf)

/** Trademark and the true minus, both of which text substitutes badly without. */
const SYMBOLS = [0x2122, 0x2212]

/** The sets a run can ask for by name. */
export const CHARSETS = {
  /** Printable ASCII and nothing else. */
  ascii: ASCII,
  /** ASCII and Latin-1 Supplement. Every face in fonts/ draws all of it. */
  latin1: [...ASCII, ...LATIN1_SUPPLEMENT],
  /**
   * Latin-1 plus Latin Extended-A, punctuation, currency and symbols. Coverage here is a
   * property of the typeface: a display face cut for headlines may carry little of Extended-A,
   * and what it lacks is spaced rather than drawn.
   */
  latin: [...ASCII, ...LATIN1_SUPPLEMENT, ...LATIN_EXTENDED_A, ...GENERAL_PUNCTUATION, ...CURRENCY, ...SYMBOLS],
} satisfies Record<string, readonly number[]>

export type CharsetName = keyof typeof CHARSETS

/**
 * What a run generates when it is told nothing.
 *
 * `latin1` rather than `ascii` because å, ä and ö are letters, not extras, and every face in
 * fonts/ draws the whole of it. It is also what the atlases committed under
 * packages/example-app/public/fonts/ were generated with, which the polygon self-test checks by
 * rebuilding them - so changing this constant means regenerating and re-copying them.
 */
export const DEFAULT_CHARSET_NAME: CharsetName = 'latin1'

/** The set both generators use unless a run says otherwise. */
export const DEFAULT_CHARSET: readonly number[] = normalize(CHARSETS[DEFAULT_CHARSET_NAME])

/** Ascending and without duplicates, so a set is the same however its spec was written. */
function normalize(codePoints: Iterable<number>): number[] {
  return [...new Set(codePoints)].sort((a, b) => a - b)
}

/**
 * Turn a `--charset` value into code points. Three forms:
 *
 *   latin1                  a name from CHARSETS
 *   U+0020-007E,U+00C0-00FF explicit code points and ranges
 *   @chars.txt              every character in a UTF-8 file, which is the form to reach for
 *                           when the answer is "these ones" rather than a block
 *
 * Undefined gives DEFAULT_CHARSET. An unreadable spec is an error rather than a silent fallback
 * to the default, because a typo would otherwise generate the wrong atlas and say nothing.
 */
export async function resolveCharset(spec?: string): Promise<readonly number[]> {
  if (spec === undefined || spec === '') return DEFAULT_CHARSET

  if (spec.startsWith('@')) {
    const path = spec.slice(1)
    const text = await readFile(path, 'utf8')
    // Line breaks and tabs are how the file is laid out, not characters to draw.
    const codePoints = [...text].map((char) => char.codePointAt(0)!).filter((cp) => cp !== 0x0a && cp !== 0x0d && cp !== 0x09)
    if (codePoints.length === 0) throw new Error(`${path} holds no characters to generate.`)
    return normalize(codePoints)
  }

  if (spec in CHARSETS) return normalize(CHARSETS[spec as CharsetName])

  const codePoints: number[] = []
  for (const item of spec.split(',')) {
    const match = /^\s*U\+([0-9a-f]{1,6})(?:\s*-\s*(?:U\+)?([0-9a-f]{1,6}))?\s*$/i.exec(item)
    if (!match) {
      throw new Error(
        `'${item.trim()}' is not a charset. Give a name (${Object.keys(CHARSETS).join(', ')}), ` +
          'code points as U+0041 or U+0020-007E, or @path to a file of the characters themselves.',
      )
    }
    const lo = parseInt(match[1], 16)
    const hi = match[2] === undefined ? lo : parseInt(match[2], 16)
    if (hi < lo) throw new Error(`${item.trim()} runs backwards.`)
    codePoints.push(...range(lo, hi))
  }
  return normalize(codePoints)
}

/** The `--charset <spec>` / `--charset=<spec>` a run was started with, if any. */
export function charsetFromArgv(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--charset') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--charset needs a value.')
      return value
    }
    if (arg.startsWith('--charset=')) return arg.slice('--charset='.length)
  }
  return undefined
}

/** The set as the string msdf-bmfont-xml's `charset` and TtfFont.ensure() take. */
export function charsetText(charset: readonly number[]): string {
  return String.fromCodePoint(...charset)
}

/** `latin1 (191 code points)`, for the line a run prints before it starts. */
export function describeCharset(spec: string | undefined, charset: readonly number[]): string {
  return `${spec ?? DEFAULT_CHARSET_NAME} (${charset.length} code points)`
}
