/// <reference path="./opentype-js.d.ts" />
// (opentype.js ships no types of its own; the reference above travels with this
// module so every consumer picks the declarations up without tsconfig changes.)

// Glyph outlines: a font's contours, flattened into the same polygon Contour the SVG path
// loader and the contour stroker already speak. This is the whole bridge between opentype.js
// and the mesh lane - once a glyph is a list of closed rings, it fills and strokes through
// exactly the machinery Path uses, with nothing text-specific left in it.
//
// Coordinates come out in raw FONT UNITS with y pointing up, which is how a font stores them
// and how this scene's local space works. opentype hands paths back in SVG's y-down
// convention (asking for the outline at `unitsPerEm` units per em keeps the scale at 1 but
// still flips the sign), so the y of every point is negated on the way through.
//
// Fonts describe glyphs with the nonzero winding rule - an outer ring winds one way and the
// counters ('o', 'B', '%') wind the other. Filling goes through classifyContours' even-odd
// NESTING test instead, which agrees with nonzero for any outline whose rings don't overlap
// each other; that covers ordinary text faces, and Inter in particular. A face that draws a
// glyph as several overlapping strokes (some script and decorative faces do) would show the
// overlaps punched out as holes.

// From '@mvpaint/engine/core' for the reason given in TtfFont.ts: the engine's main entry point
// carries bundler-only asset imports, and this package has to run under node too. flattenPath
// is pure curve subdivision - and sharing it is what makes an outline flattened here identical
// to one flattened by the offline atlas generator, or by the engine's own SVG loader.
import type { Vector2Like, Contour } from '@mvpaint/engine/core'
import { flattenCubic, flattenQuadratic } from '@mvpaint/engine/core'
import type { Glyph as OpenTypeGlyph, PathCommand } from 'opentype.js/dist/opentype.mjs'

/**
 * Curve flatness, as a fraction of the em square. A glyph's flattened outline is cached
 * once in font units and then scaled to whatever size it's drawn at, so this can't be
 * chosen per draw: it has to be fine enough for the largest size anyone will render. At
 * 1/400 em a 32px glyph deviates by under a tenth of a pixel and a 200px one by half a
 * pixel, for a couple of hundred points on a typical letter.
 */
export const DEFAULT_CURVE_TOLERANCE_EM = 1 / 400

// Points closer together than this (in font units, where the em is ~1000-2048) are the same
// point. Fonts routinely emit a moveto immediately followed by a lineto to the same
// coordinate, and a duplicated vertex is not harmless here: classifyContours samples the
// midpoint of a ring's first edge to test containment, and the midpoint of a zero-length
// edge lands exactly ON the ring, where point-in-polygon is undefined.
const DUPLICATE_EPSILON = 1e-6

function appendPoint(points: Vector2Like[], x: number, y: number): void {
  const last = points[points.length - 1]
  if (last && Math.abs(last.x - x) < DUPLICATE_EPSILON && Math.abs(last.y - y) < DUPLICATE_EPSILON) return
  points.push({ x, y })
}

/**
 * Turn a glyph's opentype path commands into closed contours in y-up font units.
 *
 * Exported separately from the font wrapper so it can be tested against hand-written
 * command streams, with no font file involved.
 */
export function contoursFromCommands(commands: readonly PathCommand[], tolerance: number): Contour[] {
  const contours: Contour[] = []
  let current: Vector2Like[] | null = null
  let x = 0
  let y = 0

  const finish = () => {
    if (current) {
      // A ring that closes back onto its own first point doesn't need it spelled twice -
      // `closed` already says the last vertex joins the first.
      const first = current[0]
      const last = current[current.length - 1]
      if (
        current.length > 1 &&
        Math.abs(first.x - last.x) < DUPLICATE_EPSILON &&
        Math.abs(first.y - last.y) < DUPLICATE_EPSILON
      ) {
        current.pop()
      }
      if (current.length >= 3) contours.push({ points: current, closed: true })
    }
    current = null
  }

  for (const command of commands) {
    switch (command.type) {
      case 'M':
        finish()
        x = command.x ?? 0
        y = -(command.y ?? 0)
        current = [{ x, y }]
        break
      case 'L':
        if (!current) current = [{ x, y }]
        x = command.x ?? 0
        y = -(command.y ?? 0)
        appendPoint(current, x, y)
        break
      case 'Q': {
        if (!current) current = [{ x, y }]
        const cx = command.x1 ?? 0
        const cy = -(command.y1 ?? 0)
        const ex = command.x ?? 0
        const ey = -(command.y ?? 0)
        const out: Vector2Like[] = []
        flattenQuadratic(x, y, cx, cy, ex, ey, tolerance, out)
        for (const p of out) appendPoint(current, p.x, p.y)
        x = ex
        y = ey
        break
      }
      case 'C': {
        if (!current) current = [{ x, y }]
        const c1x = command.x1 ?? 0
        const c1y = -(command.y1 ?? 0)
        const c2x = command.x2 ?? 0
        const c2y = -(command.y2 ?? 0)
        const ex = command.x ?? 0
        const ey = -(command.y ?? 0)
        const out: Vector2Like[] = []
        flattenCubic(x, y, c1x, c1y, c2x, c2y, ex, ey, tolerance, out)
        for (const p of out) appendPoint(current, p.x, p.y)
        x = ex
        y = ey
        break
      }
      case 'Z':
        finish()
        break
    }
  }
  finish()

  return contours
}

/**
 * A glyph's outline in y-up font units. `tolerance` is in font units - scale
 * DEFAULT_CURVE_TOLERANCE_EM by the font's unitsPerEm to get it.
 *
 * Asking opentype for the path at `unitsPerEm` units per em is what keeps the numbers in
 * raw font units: its scale factor is fontSize / unitsPerEm, so passing the latter makes it 1.
 */
export function glyphContours(glyph: OpenTypeGlyph, unitsPerEm: number, tolerance: number): Contour[] {
  return contoursFromCommands(glyph.getPath(0, 0, unitsPerEm).commands, tolerance)
}
