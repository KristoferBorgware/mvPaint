// The unit the shaper produces and every text consumer reads: one quad, plus the one
// function that turns its corners into points.
//
// A quad is stored as an axis-aligned box with two deformations layered on top - a shear for
// faux italic and a rotation for text following a curve - rather than as four loose corners.
// That keeps it small and keeps a straight line of text exactly axis-aligned, but it means a
// corner is not simply (x0, y0): it has to go through quadCorner(). Three separate consumers
// draw these (the text lane's batcher, the outline shape, and the bounds used for picking and
// culling), so the transform lives here once instead of three times over.

import type { RGBA } from '../render/meshFormat'

/**
 * The deformations a quad carries beyond its box - everything quadCorner() needs. Split out
 * so code that only has corners (bounds for picking and culling) can use the same transform
 * without carrying a glyph's uvs and materials around.
 */
export interface QuadTransform {
  /** Faux-italic shear factor: each corner's x is offset by skew*(y - skewPivotY). */
  skew: number
  skewPivotY: number
  /** Rotation in radians about (rotationPivotX, rotationPivotY); 0 for ordinary straight text. */
  rotation: number
  rotationPivotX: number
  rotationPivotY: number
}

/** One quad in node-local space (y-up). Glyph quads carry an atlas uv rect. */
export interface TextQuad extends QuadTransform {
  material: number
  /** Which font source the glyph came from - an atlas for MSDF text, a parsed TTF for vector text. */
  atlasIndex: number
  isGlyph: boolean
  x0: number
  y0: number
  x1: number
  y1: number
  u0: number
  v0: number
  u1: number
  v1: number
  color: RGBA
  // --- outline placement -------------------------------------------------------------
  // The three fields below say where this glyph's OUTLINE sits, for a consumer that draws
  // the real contours instead of sampling a textured quad (see shapes/VectorText.ts).
  // The quad itself is only the glyph's bounding box, which a blank glyph doesn't have and
  // an outline can't be reconstructed from - so the shaper records the placement directly
  // rather than making the second consumer re-derive it and drift from this one.
  /** The glyph's code point; 0 on a decoration or highlight quad. */
  codePoint: number
  /** Pen origin ON the baseline, including baseline shift and any shadow/glow offset. */
  originX: number
  /**
   * The baseline this quad sits on. For a glyph that is its pen origin's y; a decoration or
   * highlight carries the baseline of the line it belongs to, which is what lets it be bent
   * onto a curve alongside the glyphs it underlines.
   */
  originY: number
  /** Font units -> node-local units: multiply an outline's coordinates by this. */
  unitScale: number
}

/**
 * Where a point of the quad actually lands: the shear first, then the rotation. Pass a box
 * corner for the quad's own outline, or any point in the glyph's frame - an outline consumer
 * puts every contour point through this, so glyph outlines bend with the box they belong to.
 */
export function quadCorner(quad: QuadTransform, x: number, y: number): { x: number; y: number } {
  const sheared = x + quad.skew * (y - quad.skewPivotY)
  if (quad.rotation === 0) return { x: sheared, y }
  const cos = Math.cos(quad.rotation)
  const sin = Math.sin(quad.rotation)
  const dx = sheared - quad.rotationPivotX
  const dy = y - quad.rotationPivotY
  return {
    x: quad.rotationPivotX + dx * cos - dy * sin,
    y: quad.rotationPivotY + dx * sin + dy * cos,
  }
}

/** No rotation - what every quad off a straight baseline gets. */
export const NO_ROTATION = { rotation: 0, rotationPivotX: 0, rotationPivotY: 0 } as const
