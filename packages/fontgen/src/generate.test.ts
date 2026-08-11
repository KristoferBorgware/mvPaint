// Self-test for the package's programmatic half: that a run reports what it did.
//
// The command line can be read off a terminal; a build pipeline cannot. What these check is the
// return value - which faces came out, which files each was drawn from, which files were left
// out and why, and where the bytes went - because that is what a consumer builds a manifest
// from, and a wrong field there is a silent wrong manifest.
//
//   npx vitest run packages/fontgen/src/generate.test.ts

import { expect, it } from 'vitest'
import { copyFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative as relativePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHARSETS } from './charset'
import { generateFontAtlases, generateMsdfAtlases, generatePolygonAtlases } from './generate'
import { loadPacker } from './msdfAtlas'

const HERE = dirname(fileURLToPath(import.meta.url))
const FONTS_DIR = join(HERE, '..', 'fonts')

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}

// Two copies of Inter Regular and one Bold. Every tie-break in the source ordering is a draw
// between the two copies, so the last of them decides: the name. They differ at a letter rather
// than at punctuation, whose order between two collations is not something a test should rest on.
const PRIMARY = 'Inter-400-normal-a.ttf'
const LOSER = 'Inter-400-normal-b.ttf'
const BOLD = 'Inter-700-normal.ttf'

/**
 * A three-file font folder in a temporary directory: two faces, and a third file that loses its
 * slot to one of them.
 *
 * Three rather than the whole of fonts/, because every check here is about the report rather
 * than about the glyphs, and 33 faces of it would be the slowest test in the suite by an order
 * of magnitude.
 *
 * BUILT FROM THE FOUR INTER FACES ONLY - the ones a fresh clone has. The rest of fonts/ is
 * gitignored, a library each developer fills for themselves, so a fixture naming any of it
 * passes on the machine that downloaded it and fails everywhere else.
 *
 * The regular is copied twice under names that sort, which is the whole of what a file losing
 * its slot is: two files claiming one family and style, the second drawing nothing the first
 * does not already draw. A family shipping several weights that all name themselves Regular
 * arrives at readFontFaces in exactly this shape.
 */
async function fontFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mvpaint-fontgen-test-'))
  await copyFile(join(FONTS_DIR, 'Inter-400-normal.ttf'), join(dir, PRIMARY))
  await copyFile(join(FONTS_DIR, 'Inter-400-normal.ttf'), join(dir, LOSER))
  await copyFile(join(FONTS_DIR, 'Inter-700-normal.ttf'), join(dir, BOLD))
  return dir
}

// ASCII throughout: these tests are about the shape of a run, and the charset only decides how
// long they take.
const ASCII = CHARSETS.ascii

it('a polygon run reports its faces, their files and where they were written', async () => {
  const fontsDir = await fontFolder()
  const outDir = await mkdtemp(join(tmpdir(), 'mvpaint-fontgen-out-'))
  try {
    const lines: string[] = []
    const run = await generatePolygonAtlases({ fontsDir, outDir, charset: ASCII, log: (line) => lines.push(line) })

    assert(run.fontsDir === fontsDir, 'the run says which folder it read')
    assert(run.outDir === join(outDir, 'polygons'), 'and that outlines went to the polygons subfolder')
    assert(run.charset === ASCII, 'and which characters it covered')

    const faces = run.atlases.map((atlas) => atlas.face)
    assert(faces.join() === 'inter-bold,inter-regular', 'both faces came out, in name order')

    const inter = run.atlases.find((atlas) => atlas.face === 'inter-regular')!
    assert(inter.family === 'inter' && inter.style === 'regular', 'the face is split into family and style')
    assert(inter.glyphs === ASCII.length, 'Inter draws all of ASCII')
    assert(inter.kernings > 0 && inter.points > 0 && inter.bytes > 0, 'the document is measured')
    assert(inter.atlas.face === 'inter-regular', 'the document itself comes back, not just numbers')
    assert(inter.sources.length === 1 && inter.sources[0].file === PRIMARY, 'named by the file it was drawn from')
    assert(inter.sources[0].provides === ASCII.length, 'which draws the whole charset for it')

    // The path is the field a manifest is built from, so it has to name a file that is there.
    assert(inter.path === join(outDir, 'polygons', 'inter-regular.polygons.json'), 'the path names the file written')
    const written = await readFile(inter.path!, 'utf8')
    assert(written === `${JSON.stringify(inter.atlas)}\n`, 'and what is at that path is the document reported')
    assert(inter.bytes === Buffer.byteLength(written), 'measured as the bytes on disk')

    // The line-based log is the command line's whole output. A consumer that passes none is silent.
    assert(lines.some((line) => line.startsWith('polygons inter-regular ok (')), 'a run that is given a log narrates itself')
  } finally {
    await rm(fontsDir, { recursive: true, force: true })
    await rm(outDir, { recursive: true, force: true })
  }
})

// The report a pipeline would otherwise have to scrape off stdout: which file lost a slot to
// which. It is structured because "this face is not in your atlases" is a thing a build wants
// to act on, not just print.
it('a file that is in no atlas is reported with the file that took its place', async () => {
  const fontsDir = await fontFolder()
  try {
    const run = await generatePolygonAtlases({ fontsDir, charset: ASCII })

    assert(run.skipped.length === 1, 'one of the three files is in no atlas')
    const [skip] = run.skipped
    assert(skip.file === LOSER, 'the one that came second is the one left out')
    assert(skip.path === join(fontsDir, skip.file), 'named by full path as well')
    assert(skip.face === 'inter-regular', 'and by the face it would have joined')
    assert(skip.reason === 'already-drawn', 'because that face is already drawn')
    assert(skip.drawnBy === PRIMARY, 'by the file that took the slot')
    assert(skip.message.includes(PRIMARY), 'and the sentence a run prints says so too')
  } finally {
    await rm(fontsDir, { recursive: true, force: true })
  }
})

// A report outlives the working directory a run was started from - a pipeline may read it after
// a chdir, or hand it to something else entirely - so every path in one is absolute whatever
// the run was given.
it('a relative folder is reported as the absolute one it resolved to', async () => {
  const fontsDir = await fontFolder()
  try {
    const relative = relativePath(process.cwd(), fontsDir)
    const run = await generatePolygonAtlases({ fontsDir: relative, charset: ASCII })

    assert(isAbsolute(run.fontsDir), 'the folder read comes back absolute')
    assert(run.fontsDir === fontsDir, 'and is the one the relative path named')
    assert(run.skipped.every((skip) => isAbsolute(skip.path)), 'so does every skipped file')
    assert(run.atlases.every((atlas) => atlas.sources.every((source) => isAbsolute(source.path))), 'and every source')
  } finally {
    await rm(fontsDir, { recursive: true, force: true })
  }
})

it('a run with nowhere to write hands the atlases back and writes nothing', async () => {
  const fontsDir = await fontFolder()
  try {
    const run = await generatePolygonAtlases({ fontsDir, charset: ASCII })

    assert(run.outDir === undefined, 'the run wrote nowhere')
    assert(run.atlases.every((atlas) => atlas.path === undefined), 'so no atlas claims a path')
    assert(run.atlases.every((atlas) => atlas.atlas.glyphs.length > 0), 'and every document is still built')
    assert((await readdir(fontsDir)).length === 3, 'the fonts folder is untouched')
  } finally {
    await rm(fontsDir, { recursive: true, force: true })
  }
})

it('an MSDF run reports its page and writes both halves of the atlas', async () => {
  const fontsDir = await mkdtemp(join(tmpdir(), 'mvpaint-fontgen-test-'))
  const outDir = await mkdtemp(join(tmpdir(), 'mvpaint-fontgen-out-'))
  try {
    // One face: packing is the slow half of this package, and what is being checked is the
    // report around it.
    await copyFile(join(FONTS_DIR, 'Inter-400-normal.ttf'), join(fontsDir, 'Inter-400-normal.ttf'))
    const run = await generateMsdfAtlases({ fontsDir, outDir, charset: ASCII })

    assert(run.atlases.length === 1, 'the one face came out')
    const [atlas] = run.atlases
    assert(atlas.face === 'inter-regular', 'named as the engine will look it up')
    assert(atlas.glyphs === ASCII.length && atlas.kernings > 0, 'with its glyphs and kerning counted')
    assert(atlas.width > 0 && atlas.height > 0, 'and the page measured')
    assert(atlas.metrics.pages.length === 1 && atlas.metrics.pages[0] === 'inter-regular.png', 'one page, named for the face')
    assert(atlas.metrics.decoration.underlineThickness > 0, 'the decoration metrics are in the document')

    assert(atlas.metricsPath === join(outDir, 'msdf', 'inter-regular.json'), 'the metrics path is reported')
    assert(atlas.pagePath === join(outDir, 'msdf', 'inter-regular.png'), 'and the page path')
    const png = await readFile(atlas.pagePath!)
    assert(png.equals(atlas.page), 'the bytes on disk are the bytes reported')
    assert(png.subarray(1, 4).toString('latin1') === 'PNG', 'and they are a PNG')
  } finally {
    await rm(fontsDir, { recursive: true, force: true })
    await rm(outDir, { recursive: true, force: true })
  }
}, 30_000)

// Both kinds from one call, because two calls with charsets that drifted apart is the one
// failure the vector and MSDF paths cannot survive together.
it('generating both kinds covers the same characters', async () => {
  const fontsDir = await mkdtemp(join(tmpdir(), 'mvpaint-fontgen-test-'))
  const outDir = await mkdtemp(join(tmpdir(), 'mvpaint-fontgen-out-'))
  try {
    await copyFile(join(FONTS_DIR, 'Inter-400-normal.ttf'), join(fontsDir, 'Inter-400-normal.ttf'))
    const { msdf, polygons } = await generateFontAtlases({ fontsDir, outDir, charset: ASCII })

    assert(msdf.charset === polygons.charset, 'one charset was used for both')
    assert(msdf.atlases[0].glyphs === polygons.atlases[0].glyphs, 'so the two atlases hold the same glyphs')
    assert((await readdir(join(outDir, 'msdf'))).length === 2, 'the MSDF pair is written')
    assert((await readdir(join(outDir, 'polygons'))).length === 1, 'and the outline document beside it')
  } finally {
    await rm(fontsDir, { recursive: true, force: true })
    await rm(outDir, { recursive: true, force: true })
  }
}, 30_000)

// The optional peer's two failure modes. A project generating only outlines never installs the
// packer, so the message it gets when it asks for MSDF anyway is part of the package's surface.
it('a missing packer names the package to install, and any other failure is left alone', async () => {
  const missing = Object.assign(new Error("Cannot find package 'msdf-bmfont-xml'"), { code: 'ERR_MODULE_NOT_FOUND' })
  await expect(loadPacker(() => Promise.reject(missing))).rejects.toThrow(/npm install --save-dev msdf-bmfont-xml/)

  const broken = new SyntaxError('Unexpected token in msdf-bmfont-xml')
  await expect(loadPacker(() => Promise.reject(broken))).rejects.toThrow(broken)

  // The real one, which the rest of this file has already been through, still loads.
  assert(typeof (await loadPacker()) === 'function', 'and the packer itself is a function')
})
