// The path reader against the library it replaces.
//
// svgpath is a devDependency, present for this file alone: it never reaches the tarball, and
// the engine's only runtime dependency is earcut. Keeping it here holds the reader to a second
// implementation of the same grammar for as long as the file exists, which is a stronger claim
// than any set of hand-written expectations - a `d` string has too many ways of meaning the
// same thing to enumerate by hand.
//
// The comparison is on CONTOURS, not segments. Both sides run through flattenPathData, so what
// is asserted is the shape a consumer draws rather than the intermediate form either reader
// happens to produce.

import { expect, it } from 'vitest'
import svgpath from 'svgpath'
// The corpus, as text. `?raw` rather than node:fs so this file needs no Node types - the engine
// is a browser library and its tsconfig says so.
import tigerSvg from '../../../example-app/src/assets/tiger.svg?raw'
import tuxSvg from '../../../example-app/src/assets/Tux.svg?raw'
import { flattenCubic, flattenPathData, flattenQuadratic } from './flattenPath'
import { readPathData } from './pathData'
import type { Mat2x3 } from './matrix'
import type { Contour } from '../render/stroke'
import type { Vector2Like } from '../math/Vector2'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}

/** flattenPathData as it was written against svgpath, kept verbatim as the reference. */
function flattenViaSvgpath(d: string, options: { tolerance?: number; matrix?: Mat2x3 } = {}): Contour[] {
  const tol = options.tolerance ?? 0.25
  let sp = svgpath(d).abs().unshort().unarc()
  if (options.matrix) sp = sp.matrix(options.matrix).abs()

  const contours: Contour[] = []
  let current: Vector2Like[] | null = null
  const finish = (closed: boolean) => {
    if (current && current.length >= 2) contours.push({ points: current, closed })
    current = null
  }
  const ensure = (x: number, y: number) => {
    if (!current) current = [{ x, y }]
  }
  sp.iterate((segment: (string | number)[], _index: number, x: number, y: number) => {
    const n = segment as [string, ...number[]]
    switch (n[0]) {
      case 'M':
        finish(false)
        current = [{ x: n[1], y: n[2] }]
        break
      case 'L':
        ensure(x, y)
        current!.push({ x: n[1], y: n[2] })
        break
      case 'H':
        ensure(x, y)
        current!.push({ x: n[1], y })
        break
      case 'V':
        ensure(x, y)
        current!.push({ x, y: n[1] })
        break
      case 'C':
        ensure(x, y)
        flattenCubic(x, y, n[1], n[2], n[3], n[4], n[5], n[6], tol, current!)
        break
      case 'Q':
        ensure(x, y)
        flattenQuadratic(x, y, n[1], n[2], n[3], n[4], tol, current!)
        break
      case 'Z':
      case 'z':
        finish(true)
        break
    }
  })
  finish(false)
  return contours
}

/**
 * How far apart two flattenings are, as the largest distance between corresponding points.
 * Infinity when the two disagree about the shape's structure at all, which is the failure that
 * matters most - a contour count or a closed flag differing is not a rounding difference.
 */
function maxDeviation(a: Contour[], b: Contour[]): number {
  if (a.length !== b.length) return Infinity
  let worst = 0
  for (let c = 0; c < a.length; c++) {
    if (a[c].closed !== b[c].closed) return Infinity
    if (a[c].points.length !== b[c].points.length) return Infinity
    for (let p = 0; p < a[c].points.length; p++) {
      worst = Math.max(worst, Math.hypot(a[c].points[p].x - b[c].points[p].x, a[c].points[p].y - b[c].points[p].y))
    }
  }
  return worst
}

const CORPUS: readonly (readonly [string, string])[] = [
  ['tiger.svg', tigerSvg],
  ['Tux.svg', tuxSvg],
]

const pathsIn = (svg: string): string[] => [...svg.matchAll(/\sd="([^"]*)"/g)].map((m) => m[1]).filter((d) => d.trim())

// Hand-written cases, covering what the corpus below does not reach and the grammar corners
// that separate a reader that works from one that works on tidy input.
const CASES: readonly (readonly [string, string])[] = [
  ['absolute basics', 'M 10 20 L 30 40 L 50 20 Z'],
  ['relative basics', 'm 10 20 l 20 20 l 20 -20 z'],
  ['horizontal and vertical', 'M0 0 H 50 V 50 H 0 Z'],
  ['relative h and v', 'm0 0 h50 v50 h-50 z'],
  ['implicit lineto after moveto', 'M 0 0 10 0 10 10 0 10 Z'],
  ['implicit relative lineto after moveto', 'm 0 0 10 0 0 10 -10 0 z'],
  ['repeated curveto without repeating the letter', 'M0 0 C 1 1 2 2 3 3 4 4 5 5 6 6'],
  ['cubic', 'M0 0 C 10 0 20 10 20 20'],
  ['smooth cubic after cubic', 'M0 0 C 10 0 20 10 20 20 S 40 40 50 20'],
  ['smooth cubic with nothing to mirror', 'M0 0 S 20 10 30 0'],
  ['quadratic', 'M0 0 Q 15 30 30 0'],
  ['smooth quadratic after quadratic', 'M0 0 Q 15 30 30 0 T 60 0'],
  ['smooth quadratic with nothing to mirror', 'M0 0 T 30 30'],
  ['relative quadratic and smooth quadratic', 'm0 0 q 15 30 30 0 t 30 0'],
  ['arc, small sweep', 'M 10 10 A 20 20 0 0 1 50 10'],
  ['arc, large-arc flag', 'M 10 10 A 20 20 0 1 1 50 10'],
  ['arc, both flags set', 'M 10 10 A 20 20 0 1 0 50 10'],
  ['arc, rotated ellipse', 'M 0 0 A 40 20 30 1 0 60 20'],
  ['arc, relative', 'm 10 10 a 20 20 0 0 1 40 0'],
  ['arc with radii too small to span the chord', 'M 0 0 A 1 1 0 0 1 40 0'],
  ['arc with a zero radius is a line', 'M 0 0 A 0 20 0 0 1 40 0'],
  ['packed arc flags', 'M10 10a20 20 0 0110 10'],
  ['no separator before a negative number', 'M1-2L3-4'],
  ['run-on decimals', 'M.5.5L1.5.5'],
  ['scientific notation', 'M 1e1 2e1 L 1.5e1 2.5e1'],
  ['negative exponent', 'M 0 0 L 1e-2 1e-2'],
  ['commas as separators', 'M0,0 L10,0 L10,10 Z'],
  ['extra whitespace everywhere', '  M  0   0\n\tL\t10\r0  Z  '],
  ['multiple subpaths', 'M0 0 H10 V10 H0 Z M20 20 H30 V30 H20 Z'],
  ['subpath continuing after close without a moveto', 'M0 0 H10 V10 Z L20 20 L20 0 Z'],
  ['closepath then relative moveto', 'M0 0 h10 v10 z m20 20 h10 v10 z'],
  ['lowercase z', 'M0 0 L10 0 L10 10 z'],
  ['trailing closepath only', 'M0 0 L10 10 Z'],
  ['degenerate: single moveto', 'M 5 5'],
  ['degenerate: zero-length line', 'M 5 5 L 5 5'],
]

const MATRICES: readonly (readonly [string, Mat2x3])[] = [
  ['identity', [1, 0, 0, 1, 0, 0]],
  ['translate', [1, 0, 0, 1, 13, -7]],
  ['scale', [2.5, 0, 0, 2.5, 0, 0]],
  ['non-uniform scale', [3, 0, 0, 0.5, 0, 0]],
  ['rotate+translate', [0.866, 0.5, -0.5, 0.866, 10, 20]],
  ['skew', [1, 0.4, 0.3, 1, 0, 0]],
]

// Float arithmetic reaches the same answers by different routes on the two sides, so the
// comparison is to a tolerance rather than to the bit. This bound is four orders of magnitude
// under the 0.25 flattening tolerance - far too tight for a wrong curve to hide beneath.
const EPSILON = 1e-9

it('pathData: matches svgpath across the grammar', () => {
  for (const [name, d] of CASES) {
    const mine = flattenPathData(d)
    const theirs = flattenViaSvgpath(d)
    const deviation = maxDeviation(mine, theirs)
    assert(deviation <= EPSILON, `${name}: contours match svgpath (deviation ${deviation}) for "${d}"`)
  }
})

it('pathData: matches svgpath with a matrix baked in', () => {
  for (const [matrixName, matrix] of MATRICES) {
    for (const [name, d] of CASES) {
      const mine = flattenPathData(d, { matrix })
      const theirs = flattenViaSvgpath(d, { matrix })
      const deviation = maxDeviation(mine, theirs)
      assert(deviation <= EPSILON, `${name} under ${matrixName}: matches svgpath (deviation ${deviation})`)
    }
  }
})

it('pathData: matches svgpath across every path in the example app assets', () => {
  let paths = 0
  let worst = 0
  for (const [file, svg] of CORPUS) {
    const ds = pathsIn(svg)
    assert(ds.length > 0, `${file} has path data to compare`)
    for (const d of ds) {
      const deviation = maxDeviation(flattenPathData(d), flattenViaSvgpath(d))
      if (deviation > worst) worst = deviation
      assert(deviation <= EPSILON, `${file}: a path matches svgpath (deviation ${deviation}) - "${d.slice(0, 70)}"`)
      paths++
    }
  }
  assert(paths >= 280, `the corpus is the whole of both files (${paths} paths compared)`)
  assert(worst <= EPSILON, `every path in the corpus agrees (worst deviation ${worst})`)
})

it('pathData: matches svgpath at several flattening tolerances', () => {
  for (const tolerance of [0.01, 0.25, 2]) {
    for (const [name, d] of CASES) {
      const deviation = maxDeviation(flattenPathData(d, { tolerance }), flattenViaSvgpath(d, { tolerance }))
      assert(deviation <= EPSILON, `${name} at tolerance ${tolerance}: matches svgpath (deviation ${deviation})`)
    }
  }
})

// The one place the two readers disagree, kept as a test so the disagreement is a decision
// rather than a discovery. SVG 1.1 F.6.2: "If the endpoints (x1, y1) and (x2, y2) are
// identical, then this is equivalent to omitting the elliptical arc segment entirely."
// svgpath emits a zero-length lineto instead, which reaches the mesh builder as a contour of
// two identical points - zero area to triangulate and a zero-length segment to put a stroke
// cap on. Omitting it is what the specification asks for and what the rest of the engine can
// use, so this reader omits it.
it('pathData: an arc that returns to its start is omitted, per the specification', () => {
  const d = 'M 10 10 A 20 20 0 1 1 10 10'
  const mine = flattenPathData(d)
  const theirs = flattenViaSvgpath(d)

  assert(mine.length === 0, 'the arc contributes nothing, leaving a lone moveto and no contour')
  assert(theirs.length === 1 && theirs[0].points.length === 2, 'svgpath instead yields a two-point contour')
  assert(
    theirs[0].points[0].x === theirs[0].points[1].x && theirs[0].points[0].y === theirs[0].points[1].y,
    "and that contour's two points are the same point",
  )
})

it('pathData: malformed data names the offset rather than truncating', () => {
  const bad: readonly string[] = ['M 0 0 L', 'M 0 0 X 1 1', '10 10 L 20 20', 'M 0 0 A 5 5 0 2 1 10 10', 'M 0 0 Z 5']
  for (const d of bad) {
    let message = ''
    try {
      flattenPathData(d)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    assert(message.includes('Invalid SVG path data at offset'), `"${d}" is rejected with an offset, got: ${message || '(no error)'}`)
  }
})

it('pathData: the reader hands over absolute segments with the shorthands resolved', () => {
  const seen: string[] = []
  readPathData('m 10 10 h 10 v 10 s 5 5 10 0 t 5 5 a 5 5 0 0 1 5 5 z', {
    moveTo: (x, y) => seen.push(`M${x},${y}`),
    lineTo: (x, y) => seen.push(`L${x},${y}`),
    cubicTo: (_a, _b, _c, _d, x, y) => seen.push(`C${x},${y}`),
    quadraticTo: (_a, _b, x, y) => seen.push(`Q${x},${y}`),
    closePath: () => seen.push('Z'),
  })
  assert(seen[0] === 'M10,10', 'a relative moveto from the origin is absolute')
  assert(seen[1] === 'L20,10', 'a horizontal shorthand becomes a lineto')
  assert(seen[2] === 'L20,20', 'a vertical shorthand becomes a lineto')
  assert(seen[3] === 'C30,20', 'a smooth cubic becomes a cubic')
  assert(seen[4] === 'Q35,25', 'a smooth quadratic becomes a quadratic')
  assert(
    seen.slice(5, -1).every((s) => s.startsWith('C')),
    'an arc becomes cubics',
  )
  assert(seen[seen.length - 1] === 'Z', 'the closepath survives')
})
