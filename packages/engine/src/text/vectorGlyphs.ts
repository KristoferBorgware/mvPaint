// What VectorText needs from a set of fonts, and the one piece of geometry work that turns an
// outline into something the mesh lane can draw.
//
// The engine used to have exactly one answer here: parse a TTF with opentype.js at runtime and
// walk its contours. That answer was a quarter of a megabyte of parser in the bundle of every
// application, whether or not it drew a single vector glyph - to do work that never changes
// between runs. Flattening the letter 'A' of Inter Regular produces the same few hundred points
// today as it will next year, so it is done ONCE, offline (see packages/scripts), and shipped
// as data: a polygon atlas, which is to this path what the MSDF PNG is to the other one.
//
// So the engine now reads glyph outlines from an atlas and nothing else. This module is the
// seam that keeps that from being a restriction:
//
//   VectorFonts        what a VectorText holds - resolve a style, prepare some text, hand back
//                      the outline for a code point. PolygonFontBook implements it from atlases
//                      the application supplies; @mvpaint/ttf implements it by parsing a font
//                      file at runtime, for an application that genuinely needs an arbitrary
//                      font it has not seen before (a user upload, a font picker).
//   meshFromContours   rings -> fill triangles, shared by both, so an atlas glyph and a
//                      runtime-parsed one become geometry through the same code.
//
// The distinction is deliberate: the parser is what got expensive, not the outlines, and only
// the applications that need arbitrary fonts should pay for it.

import type { Vector2Like } from '../math/Vector2'
import type { Contour } from '../render/stroke'
import { simpleLoops, windingGroups } from '../render/nonzero'
import { triangulateGroup } from '../svg/triangulate'
import type { FontStyle } from './msdfProvider'
import type { FontMetrics } from './msdfMetrics'
import type { FontProvider } from './layout'

/** A glyph's fillable geometry, in y-up font units - built once and scaled per draw. */
export interface VectorGlyphMesh {
  /** Closed rings: what the contour stroker outlines, and what the fill was cut from. */
  contours: Contour[]
  /** Fill triangulation: vertices plus triangle indices into them. */
  vertices: Vector2Like[]
  indices: number[]
}

/** One style's outlines and metrics, however they were obtained. */
export interface VectorGlyphFont {
  /** Font units per em - the space `metrics` and every glyph mesh live in. */
  readonly unitsPerEm: number
  /** The same FontMetrics the MSDF path uses, in font units, for the shared shaper. */
  readonly metrics: FontMetrics
  /**
   * The outline for a code point, or undefined where this font has none (which is what makes
   * the shaper space it, exactly as an unmapped character in the MSDF charset is spaced).
   */
  mesh(codePoint: number): VectorGlyphMesh | undefined
  /**
   * Make sure `text` is measurable - what a runtime parser does on demand, and what an atlas
   * has already done. Called before shaping; an atlas-backed font implements it as a no-op.
   */
  ensure(text: string): void
}

/**
 * A set of styles VectorText can draw from: a FontProvider (so the SAME shaper lays this out
 * as lays out MSDF text) plus access to the outlines themselves.
 *
 * Written as an interface rather than a class so the runtime-parsing package can satisfy it
 * without the engine importing, or knowing about, a font parser.
 */
export interface VectorFonts extends FontProvider {
  /** Stable index for a style - the `atlasIndex` a shaped quad carries. */
  indexOf(style: FontStyle): number
  /** The font behind a resolved style's index - where a shaped quad's outline comes from. */
  fontByIndex(index: number): VectorGlyphFont | undefined
  /** Measure `text` into the font a style resolves to, before shaping it. */
  prepare(style: FontStyle, text: string): void
}

/** A glyph with no outline - whitespace, and anything else that only advances the pen. */
export const EMPTY_GLYPH_MESH: VectorGlyphMesh = { contours: [], vertices: [], indices: [] }

/**
 * Fill geometry for a set of closed rings.
 *
 * Read with the NONZERO WINDING RULE, which is the rule a font is drawn with (see
 * render/nonzero.ts). A letter is built from overlapping pieces wound the same way - the bar of
 * a 't' laid across its stem, the two strokes of a 'w' crossing at each V - and the fill is
 * their union. Rings are cut at their crossings so every piece reaching earcut is a simple
 * polygon, grouped into solids-with-holes by direction, then triangulated group by group with
 * the index spaces rebased into one flat mesh.
 *
 * `contours` comes back untouched: it is the outline the stroker follows, and a per-letter
 * outline traces the letterform as the font drew it, crossings included.
 */
export function meshFromContours(contours: Contour[]): VectorGlyphMesh {
  const vertices: Vector2Like[] = []
  const indices: number[] = []
  const loops = contours.flatMap((contour) => simpleLoops(contour.points))
  for (const group of windingGroups(loops)) {
    const triangulated = triangulateGroup(group)
    const base = vertices.length
    for (const v of triangulated.vertices) vertices.push(v)
    for (const i of triangulated.indices) indices.push(base + i)
  }
  return { contours, vertices, indices }
}
