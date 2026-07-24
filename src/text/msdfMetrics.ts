// MSDF glyph metrics: the raw BMFont/Hiero JSON shape (produced by scripts/genFontAtlas.ts)
// and its normalization into fast lookup structures. All metric values are in atlas pixels at
// the generation em size (`size`); the layout scales them by (renderSize / size). Positions
// follow BMFont's y-down convention (yoffset measured downward from the line top); the shaper
// converts to the scene's y-up space.

/** One glyph entry as stored in the atlas JSON. */
export interface BmChar {
  id: number // Unicode code point
  x: number
  y: number
  width: number
  height: number
  xoffset: number
  yoffset: number
  xadvance: number
  page: number
}

export interface BmKerning {
  first: number
  second: number
  amount: number
}

/** Text-decoration placement, in em fractions (baseline at 0, +y up), from the font tables. */
export interface BmDecoration {
  underlineOffset: number
  underlineThickness: number
  strikeOffset: number
  strikeThickness: number
}

/** The atlas JSON document, as written by the generator. */
export interface MsdfFontJson {
  pages: string[]
  chars: BmChar[]
  info: { face: string; size: number }
  common: { lineHeight: number; base: number; scaleW: number; scaleH: number }
  distanceField: { fieldType: string; distanceRange: number }
  kernings: BmKerning[]
  decoration: BmDecoration
}

/** A glyph normalized for shaping: atlas uv rect (0..1) plus placement in generation-size px. */
export interface Glyph {
  u0: number
  v0: number
  u1: number
  v1: number
  width: number
  height: number
  xoffset: number
  yoffset: number
  xadvance: number
}

export interface FontMetrics {
  /** Generation em size in px; all fields below are in this pixel space. */
  size: number
  lineHeight: number
  /** Distance from a line's top to the baseline. */
  base: number
  atlasWidth: number
  atlasHeight: number
  /** SDF spread in atlas px; the shader converts it to screen px for anti-aliasing. */
  distanceRange: number
  decoration: BmDecoration
  glyphs: Map<number, Glyph>
  kernings: Map<number, number>
}

// Kerning pairs are keyed by a single number so the lookup is a plain Map get.
function kerningKey(first: number, second: number): number {
  return first * 0x110000 + second
}

/** Build lookup structures (glyph map + kerning map, uv rects) from the raw atlas JSON. */
export function normalizeMetrics(json: MsdfFontJson): FontMetrics {
  const sw = json.common.scaleW
  const sh = json.common.scaleH
  const glyphs = new Map<number, Glyph>()
  for (const c of json.chars) {
    glyphs.set(c.id, {
      u0: c.x / sw,
      v0: c.y / sh,
      u1: (c.x + c.width) / sw,
      v1: (c.y + c.height) / sh,
      width: c.width,
      height: c.height,
      xoffset: c.xoffset,
      yoffset: c.yoffset,
      xadvance: c.xadvance,
    })
  }
  const kernings = new Map<number, number>()
  for (const k of json.kernings) {
    kernings.set(kerningKey(k.first, k.second), k.amount)
  }
  return {
    size: json.info.size,
    lineHeight: json.common.lineHeight,
    base: json.common.base,
    atlasWidth: sw,
    atlasHeight: sh,
    distanceRange: json.distanceField.distanceRange,
    decoration: json.decoration,
    glyphs,
    kernings,
  }
}

export function glyphFor(metrics: FontMetrics, codePoint: number): Glyph | undefined {
  return metrics.glyphs.get(codePoint)
}

/** Kerning adjustment between two code points (0 when the pair has no entry). */
export function kerningFor(metrics: FontMetrics, first: number, second: number): number {
  return metrics.kernings.get(kerningKey(first, second)) ?? 0
}
