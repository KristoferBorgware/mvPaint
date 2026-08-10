// Cutting a contour into dashes. The walk is arc-length arithmetic with a handful of edge
// cases that are easy to get subtly wrong - a pattern that does not divide the path, an odd
// entry count, a closed ring whose start point falls mid-dash - so each is pinned here.

import { expect, it } from 'vitest'
import type { Vector2Like } from '../math/Vector2'
import { dashContour, normalizeDashPattern } from './dash'
import { Polyline } from '../shapes/Polyline'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}

/** Total drawn length, which is what a dash pattern is really a statement about. */
function inkLength(pieces: readonly (readonly Vector2Like[])[]): number {
  let total = 0
  for (const piece of pieces) {
    for (let i = 0; i + 1 < piece.length; i++) {
      total += Math.hypot(piece[i + 1].x - piece[i].x, piece[i + 1].y - piece[i].y)
    }
  }
  return total
}

const line = (length: number): Vector2Like[] => [
  { x: 0, y: 0 },
  { x: length, y: 0 },
]

it('a pattern is normalized, or refused in favour of a solid line', () => {
  assert(normalizeDashPattern([4, 2])?.join() === '4,2', 'an even list is taken as written')
  assert(normalizeDashPattern([6])?.join() === '6,6', 'an odd one is doubled, so a lone entry is on-and-off')
  assert(normalizeDashPattern([1, 2, 3])?.join() === '1,2,3,1,2,3', 'however long it is')

  assert(normalizeDashPattern(undefined) === null, 'no pattern draws solid')
  assert(normalizeDashPattern([]) === null, 'and neither does an empty one')
  assert(normalizeDashPattern([0, 0]) === null, 'a pattern with no length at all draws solid rather than looping')
  assert(normalizeDashPattern([5, -2]) === null, 'so does a negative entry')
  assert(normalizeDashPattern([5, NaN]) === null, 'and one that is not a number')
})

it('an open path is cut along its length, not per edge', () => {
  const pieces = dashContour(line(40), false, [10, 10], 0)
  assert(pieces.length === 2, 'a 40-long line under 10-on-10-off draws twice')
  assert(pieces[0][0].x === 0 && pieces[0][1].x === 10, 'the first dash runs from the start')
  assert(pieces[1][0].x === 20 && pieces[1][1].x === 30, 'and the second after one gap')
  assert(inkLength(pieces) === 20, 'half the path is drawn')

  // The pattern crosses the corner rather than restarting at it, which is the whole reason the
  // walk is by arc length: a dash spanning the corner keeps the corner point, so the stroker
  // still has a join to build there.
  const bent = dashContour([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false, [15, 5], 0)
  assert(bent[0].length === 3, 'a dash that spans a corner keeps the corner in it')
  assert(bent[0][1].x === 10 && bent[0][1].y === 0, 'the corner itself')
  assert(Math.abs(inkLength(bent) - 15) < 1e-9, 'and it is fifteen long, measured around the bend')
})

it('dashOffset moves the pattern along the path', () => {
  // Five units in, the first dash is already half spent.
  const pieces = dashContour(line(40), false, [10, 10], 5)
  assert(Math.abs(pieces[0][1].x - 5) < 1e-9, 'the opening dash is cut short by the offset')
  assert(Math.abs(pieces[1][0].x - 15) < 1e-9, 'and everything after it shifts back by five')

  // A whole period is no shift at all.
  const shifted = dashContour(line(40), false, [10, 10], 20)
  const plain = dashContour(line(40), false, [10, 10], 0)
  assert(inkLength(shifted) === inkLength(plain), 'a full period leaves the path as it was')
})

it('a closed ring is dashed round its closing edge, and the seam is rejoined', () => {
  // A 40-perimeter square under a pattern that does not divide it: the run through the start
  // corner is one dash the walk happens to cut in half, and it comes back whole.
  const square: Vector2Like[] = [
    { x: 0, y: 0 },
    { x: 12, y: 0 },
    { x: 12, y: 12 },
    { x: 0, y: 12 },
  ]
  const pieces = dashContour(square, true, [10, 6], 0)
  assert(pieces.length > 0, 'a closed ring draws something')

  // Every piece must be a real run, and the closing edge has to be dashed like any other -
  // 48 of perimeter under 10-on-6-off is 3 whole periods (48) exactly.
  assert(Math.abs(inkLength(pieces) - 30) < 1e-9, 'three dashes of ten, including across the corners')
  for (const piece of pieces) assert(piece.length >= 2, 'and no piece is a single point')

  // The seam: with the pattern starting mid-dash, the run through (0,0) is one piece rather
  // than a pair of stubs meeting there.
  const seamed = dashContour(square, true, [10, 6], 4)
  const touchesStart = seamed.filter((p) => p.some((q) => q.x === 0 && q.y === 0))
  assert(touchesStart.length === 1, 'the dash the start point falls inside is a single piece')
})

it('a dashed shape is only hittable where it is drawn', () => {
  // The end-to-end claim, through the stroker and the pick cache: the gaps are really gaps.
  const dashed = new Polyline({
    points: line(40),
    stroke: 'black',
    strokeWidth: 4,
    dash: [10, 10],
  })

  assert(dashed.hitTestLocal(5, 0), 'the first dash is there')
  assert(!dashed.hitTestLocal(15, 0), 'the gap after it is not')
  assert(dashed.hitTestLocal(25, 0), 'and the second dash is')

  dashed.dashEnabled = false
  assert(dashed.hitTestLocal(15, 0), 'switching the dash off fills the gaps back in')

  dashed.dashEnabled = true
  dashed.dashOffset = 10
  assert(!dashed.hitTestLocal(5, 0), 'and an offset moves which parts are drawn')
  assert(dashed.hitTestLocal(15, 0), 'to where the pattern now puts them')
})
