// The command line: arguments in, generate.ts called, its report printed.
//
//   mvpaint-fontgen                       both kinds of atlas
//   mvpaint-fontgen polygons              outlines only, which needs no packer
//   mvpaint-fontgen msdf                  distance fields only
//
//   --fonts <dir>      where the font files are        (default ./fonts)
//   --out <dir>        where msdf/ and polygons/ go    (default ./out)
//   --charset <spec>   a name, code points, or @file   (default latin1, see charset.ts)
//
// A single process for both generators rather than two commands chained: npm appends a `--`
// argument to the LAST command of a chain, so the second would get the arguments and the first
// would run on the defaults. The two atlases covering different characters is exactly what must
// not happen.

import { isAbsolute, relative, resolve } from 'node:path'
import { describeCharset, resolveCharset } from './charset'
import { generateFontAtlases, generateMsdfAtlases, generatePolygonAtlases, type AtlasRun, type MsdfRun } from './generate'
import type { AtlasReport } from './generate'

const KINDS = ['fonts', 'msdf', 'polygons'] as const
type Kind = (typeof KINDS)[number]

const USAGE = `mvpaint-fontgen [fonts|msdf|polygons] [--fonts <dir>] [--out <dir>] [--charset <spec>]

  fonts       both kinds of atlas (the default)
  msdf        distance-field pages, which need msdf-bmfont-xml installed
  polygons    flattened outlines

  --fonts <dir>      the folder of .ttf/.otf/.woff2 files to read   (default ./fonts)
  --out <dir>        the folder msdf/ and polygons/ are written to  (default ./out)
  --charset <spec>   ascii | latin1 | latin, or U+0020-007E, or @chars.txt`

/**
 * The value of `--<flag> <value>` or `--<flag>=<value>`, or undefined when the run gave neither.
 * The first occurrence wins, so a flag repeated on one line has one answer.
 */
export function flagFromArgv(argv: readonly string[], flag: string): string | undefined {
  const long = `--${flag}`
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === long) {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${long} needs a value.`)
      return value
    }
    if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1)
  }
  return undefined
}

/** The subcommand, which is the first argument that is not a flag or a flag's value. */
function kindFromArgv(argv: readonly string[]): Kind {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg.startsWith('--')) {
      // `--charset latin` is two arguments; `--charset=latin` is one.
      if (!arg.includes('=')) index++
      continue
    }
    if ((KINDS as readonly string[]).includes(arg)) return arg as Kind
    throw new Error(`'${arg}' is not one of ${KINDS.join(', ')}.\n\n${USAGE}`)
  }
  return 'fonts'
}

/**
 * A folder as a run reports it: relative to the working directory while it is inside it, and
 * absolute once it is not, which is where a relative path stops being readable.
 */
export function displayPath(dir: string): string {
  const rel = relative(process.cwd(), dir)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : dir
}

/** The closing lines: where the atlases went, and what to do with them. */
function summarize(run: AtlasRun<AtlasReport>, kind: string): void {
  const where = run.outDir === undefined ? 'nowhere' : displayPath(run.outDir)
  console.log(`Wrote ${run.atlases.length} ${kind} atlases to ${where}`)
}

/**
 * An application's layer size is the largest page across the styles of ONE family, so this is
 * the worst case rather than what any single family allocates. Four layers of it, at four bytes
 * a texel, is what a family holds in texture memory.
 */
function summarizeTexture(run: MsdfRun): void {
  const widest = Math.max(0, ...run.atlases.map((atlas) => atlas.width))
  const tallest = Math.max(0, ...run.atlases.map((atlas) => atlas.height))
  const mb = ((widest * tallest * 4 * 4) / 1024 / 1024).toFixed(1)
  console.log(`Largest page ${widest}x${tallest} - ${mb} MB of texture for a family at that size.`)
}

/**
 * The command line, run: main() with its failures turned into an exit code and one line on
 * stderr. The message is the whole report - a stack trace of this package's own internals is
 * not what a developer generating fonts needs to read.
 */
export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  try {
    await main(argv)
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return
  }

  const kind = kindFromArgv(argv)
  const spec = flagFromArgv(argv, 'charset')
  const charset = await resolveCharset(spec)
  const fontsDir = resolve(flagFromArgv(argv, 'fonts') || 'fonts')
  const outDir = resolve(flagFromArgv(argv, 'out') || 'out')
  const log = (line: string): void => console.log(line)

  console.log(`Fonts: ${displayPath(fontsDir)}`)
  console.log(`Charset: ${describeCharset(spec, charset)}`)

  const options = { fontsDir, outDir, charset, log }
  if (kind === 'polygons') {
    summarize(await generatePolygonAtlases(options), 'polygon')
  } else if (kind === 'msdf') {
    const run = await generateMsdfAtlases(options)
    summarize(run, 'MSDF')
    summarizeTexture(run)
  } else {
    const { msdf, polygons } = await generateFontAtlases(options)
    summarize(msdf, 'MSDF')
    summarizeTexture(msdf)
    summarize(polygons, 'polygon')
  }

  console.log('Copy the ones your application draws with into its own font folder.')
}
