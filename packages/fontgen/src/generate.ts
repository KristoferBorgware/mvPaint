// A folder of font files in, atlases out - the whole of what this package does, as three
// functions.
//
// Each reads the folder, builds an atlas per face, writes what it built when the run names an
// out folder, and returns a report of it. THE REPORT IS THE POINT: a build pipeline wants to
// know which faces it got, which files each was drawn from and which files were left out, and
// scraping that back out of a terminal is a worse way to learn it than being handed it. Nothing
// here prints unless a run passes `log`.

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FontStyle, MsdfFontJson, PolygonFontJson } from '@mvpaint/engine/core'
import { DEFAULT_CHARSET } from './charset'
import { describeSources, readFontFaces, type FontFace, type FontFolder, type SkippedFile } from './fontSources'
import { buildMsdfAtlas } from './msdfAtlas'
import { buildPolygonAtlas, countPoints } from './polygonAtlas'

/** What a run is told. Only the folder to read is required. */
export interface GenerateOptions {
  /**
   * The folder of font files to generate from. Every font file in it is a candidate. Relative
   * to the working directory, or absolute; a run reports the paths it used absolute either way,
   * so a report stays true to a caller that reads it from somewhere else.
   */
  fontsDir: string
  /**
   * Where to write. Each kind of atlas gets its own subfolder - `msdf/` and `polygons/`. Left
   * out, a run writes nothing and the atlases come back in the report.
   */
  outDir?: string
  /** The code points to cover. Defaults to DEFAULT_CHARSET; resolveCharset turns a spec into one. */
  charset?: readonly number[]
  /** Called with each line the run would print. Left out, the run is silent. */
  log?: (line: string) => void
}

/** What a run is told, plus the one thing only outlines have. */
export interface GeneratePolygonOptions extends GenerateOptions {
  /** Curve flatness as a fraction of the em. The runtime cannot change this after the fact. */
  curveToleranceEm?: number
}

/** One file a face was drawn from. */
export interface SourceReport {
  /** The file's name within the fonts folder. */
  file: string
  /** Absolute path to it. */
  path: string
  /** How many code points of the charset this file draws for the face. */
  provides: number
}

/** What every atlas report carries, whichever kind of atlas it is. */
export interface AtlasReport {
  /** `poppins-bold-italic`: the basename of the files written, and the face's name inside them. */
  face: string
  /** Lowercased family, e.g. `jetbrains-mono`. */
  family: string
  /** The style the renderer will resolve this face as. */
  style: FontStyle
  /** The files it was drawn from, the one that supplied the metrics first. */
  sources: SourceReport[]
  glyphs: number
  kernings: number
}

export interface PolygonAtlasReport extends AtlasReport {
  /** The document, exactly as it was written. */
  atlas: PolygonFontJson
  /** Where it was written, absent when the run named no out folder. */
  path?: string
  /** Points across every ring: the size of the geometry. */
  points: number
  /** The document as written, in bytes. */
  bytes: number
}

export interface MsdfAtlasReport extends AtlasReport {
  /** The metrics document, exactly as it was written. */
  metrics: MsdfFontJson
  /** The page, as PNG bytes. */
  page: Buffer
  /** The page's size in texels: one layer of the engine's atlas array allocates this much. */
  width: number
  height: number
  /** Where the two files were written, absent when the run named no out folder. */
  metricsPath?: string
  pagePath?: string
}

/** A whole run: what it was told, what it produced, and what it left out. */
export interface AtlasRun<Atlas extends AtlasReport> {
  /** Absolute path to the folder that was read. */
  fontsDir: string
  /** Absolute path to the subfolder written to, absent when the run wrote nothing. */
  outDir?: string
  /** The code points every atlas was built over. */
  charset: readonly number[]
  atlases: Atlas[]
  /** Font files that are in no atlas, each saying why. */
  skipped: SkippedFile[]
}

export type PolygonRun = AtlasRun<PolygonAtlasReport>
export type MsdfRun = AtlasRun<MsdfAtlasReport>

/** Both kinds of atlas, from one reading of the folder. */
export interface FontRun {
  msdf: MsdfRun
  polygons: PolygonRun
}

const NO_LOG = (): void => {}

const sourceReports = (face: FontFace): SourceReport[] =>
  face.sources.map((source) => ({ file: source.file, path: source.path, provides: source.provides.length }))

/** The subfolder a kind of atlas is written to, created, or undefined when nothing is written. */
async function prepare(outDir: string | undefined, kind: string): Promise<string | undefined> {
  if (outDir === undefined) return undefined
  const out = join(resolve(outDir), kind)
  await mkdir(out, { recursive: true })
  return out
}

/**
 * `polygons poppins-regular ok (...)`, and the files it came from when there was more than one.
 *
 * The kind leads, because a run that generates both would otherwise print each face twice with
 * nothing to say which line is which.
 */
function report(kind: string, face: FontFace, summary: string, log: (line: string) => void): void {
  log(`${kind} ${face.base} ok (${summary})`)
  if (face.sources.length > 1) log(`  from ${describeSources(face)}`)
}

async function polygonRun(folder: FontFolder, charset: readonly number[], options: GeneratePolygonOptions): Promise<PolygonRun> {
  const { curveToleranceEm, log = NO_LOG } = options
  const out = await prepare(options.outDir, 'polygons')
  const atlases: PolygonAtlasReport[] = []

  for (const face of folder.faces) {
    const atlas = await buildPolygonAtlas(face.base, face.sources, { charset, curveToleranceEm })
    const text = `${JSON.stringify(atlas)}\n`
    const path = out === undefined ? undefined : join(out, `${face.base}.polygons.json`)
    if (path !== undefined) await writeFile(path, text)

    const points = countPoints(atlas)
    const bytes = Buffer.byteLength(text)
    atlases.push({
      face: face.base,
      family: face.family,
      style: face.style,
      sources: sourceReports(face),
      atlas,
      ...(path === undefined ? {} : { path }),
      glyphs: atlas.glyphs.length,
      kernings: atlas.kernings.length,
      points,
      bytes,
    })

    const kb = (bytes / 1024).toFixed(0)
    report('polygons', face, `${atlas.glyphs.length} glyphs, ${points} points, ${atlas.kernings.length} kernings, ${kb} kB`, log)
  }

  for (const skip of folder.skipped) log(skip.message)
  return { fontsDir: folder.dir, ...(out === undefined ? {} : { outDir: out }), charset, atlases, skipped: [...folder.skipped] }
}

async function msdfRun(folder: FontFolder, charset: readonly number[], options: GenerateOptions): Promise<MsdfRun> {
  const { log = NO_LOG } = options
  const out = await prepare(options.outDir, 'msdf')
  const atlases: MsdfAtlasReport[] = []

  for (const face of folder.faces) {
    const { metrics, page, width, height } = await buildMsdfAtlas(face)
    const metricsPath = out === undefined ? undefined : join(out, `${face.base}.json`)
    const pagePath = out === undefined ? undefined : join(out, `${face.base}.png`)
    if (metricsPath !== undefined && pagePath !== undefined) {
      await writeFile(metricsPath, `${JSON.stringify(metrics)}\n`)
      await writeFile(pagePath, page)
    }

    atlases.push({
      face: face.base,
      family: face.family,
      style: face.style,
      sources: sourceReports(face),
      metrics,
      page,
      width,
      height,
      ...(metricsPath === undefined ? {} : { metricsPath }),
      ...(pagePath === undefined ? {} : { pagePath }),
      glyphs: metrics.chars.length,
      kernings: metrics.kernings.length,
    })

    report('msdf', face, `${metrics.chars.length} glyphs, ${metrics.kernings.length} kernings, ${width}x${height} page`, log)
  }

  for (const skip of folder.skipped) log(skip.message)
  return { fontsDir: folder.dir, ...(out === undefined ? {} : { outDir: out }), charset, atlases, skipped: [...folder.skipped] }
}

/**
 * Polygon atlases for every face in a folder.
 *
 * ```ts
 * const run = await generatePolygonAtlases({ fontsDir: 'fonts', outDir: 'public/fonts' })
 * for (const atlas of run.atlases) manifest[atlas.face] = atlas.path
 * ```
 */
export async function generatePolygonAtlases(options: GeneratePolygonOptions): Promise<PolygonRun> {
  const charset = options.charset ?? DEFAULT_CHARSET
  return polygonRun(await readFontFaces(resolve(options.fontsDir), charset), charset, options)
}

/**
 * MSDF atlases for every face in a folder. These need msdf-bmfont-xml, which this package
 * leaves to the project to install - see loadPacker in msdfAtlas.ts.
 */
export async function generateMsdfAtlases(options: GenerateOptions): Promise<MsdfRun> {
  const charset = options.charset ?? DEFAULT_CHARSET
  return msdfRun(await readFontFaces(resolve(options.fontsDir), charset), charset, options)
}

/**
 * Both kinds of atlas over one charset, from one reading of the folder.
 *
 * The two covering different characters is the one thing that must not happen - a node
 * switching between the MSDF and the vector path would change which glyphs are missing - so
 * anything that generates both comes through here rather than calling the two in turn with
 * arguments it has to keep in step itself.
 */
export async function generateFontAtlases(options: GeneratePolygonOptions): Promise<FontRun> {
  const charset = options.charset ?? DEFAULT_CHARSET
  const folder = await readFontFaces(resolve(options.fontsDir), charset)
  return {
    msdf: await msdfRun(folder, charset, options),
    polygons: await polygonRun(folder, charset, options),
  }
}
