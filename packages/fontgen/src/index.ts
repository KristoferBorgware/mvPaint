// @mvpaint/fontgen: font files in, glyph atlases out, for @mvpaint/engine's two text paths.
//
// The same three functions the command line runs, so a build pipeline can call them directly
// and read what happened off the return value rather than out of a terminal. See generate.ts
// for the reports, README.md for the shape of a run.

export {
  generateFontAtlases,
  generateMsdfAtlases,
  generatePolygonAtlases,
  type AtlasReport,
  type AtlasRun,
  type FontRun,
  type GenerateOptions,
  type GeneratePolygonOptions,
  type MsdfAtlasReport,
  type MsdfRun,
  type PolygonAtlasReport,
  type PolygonRun,
  type SourceReport,
} from './generate'

// One face at a time, for a caller that has the bytes rather than a folder - the runtime
// counterpart's own self-test builds an atlas this way and compares it against a live parse.
export { buildMsdfAtlas, TEXTURE_SIZE, type MsdfAtlas } from './msdfAtlas'
export { buildPolygonAtlas, countPoints, type PolygonAtlasOptions, type PolygonSource } from './polygonAtlas'

// The folder, enumerated and grouped into faces, which is what a generator does first.
export {
  describeSources,
  readFontFaces,
  toSfnt,
  type FaceSource,
  type FontFace,
  type FontFolder,
  type SkipReason,
  type SkippedFile,
} from './fontSources'

// The characters an atlas covers.
export {
  CHARSETS,
  DEFAULT_CHARSET,
  DEFAULT_CHARSET_NAME,
  charsetText,
  describeCharset,
  resolveCharset,
  type CharsetName,
} from './charset'
