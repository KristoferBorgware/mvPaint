// The nonzero winding rule, checked against the rule itself.
//
// The hand-written cases below name the two shapes a font is actually built from - a bar laid
// across a stem, and a stroke that crosses itself at a join - because those are the ones that
// read as something else entirely under even-odd nesting: the bar of a 't' punched out, and a
// 'w' filled solid across its valleys.
//
// The last test is the one that matters. It takes every glyph of the committed atlas, samples a
// grid over it, and asks two independent questions at each point: is it inside a fill triangle,
// and is its winding number against the ORIGINAL rings non-zero. The first is what the engine
// draws and the second is what the font meant. A glyph they disagree about is a glyph drawn
// wrong, whatever it happens to look like.

import { expect, it } from 'vitest'
import type { Vector2Like } from '../math/Vector2'
// The committed atlas itself, by path rather than through a package entry point: it is a
// generated asset of the example app, not part of anybody's API, and this test exists precisely
// to check the engine against the file on disk. Test-only - nothing here ships.
import interRegular from '../../../example-app/public/fonts/polygons/inter-regular.polygons.json'
import { PolygonFont, type PolygonFontJson } from '../text/PolygonFont'
import { triangulateGroup } from '../svg/triangulate'
import { signedArea } from './contours'
import { simpleLoops, unionBoundary, windingGroups } from './nonzero'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}

const square = (x: number, y: number, w: number, h: number): Vector2Like[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
]
const reversed = (ring: Vector2Like[]): Vector2Like[] => [...ring].reverse()

/** Winding number of a point against a set of rings - the rule, computed straight. */
function windingNumber(px: number, py: number, rings: readonly (readonly Vector2Like[])[]): number {
  let winding = 0
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j]
      const b = ring[i]
      if (a.y <= py) {
        if (b.y > py && (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y) > 0) winding++
      } else if (b.y <= py && (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y) < 0) {
        winding--
      }
    }
  }
  return winding
}

function inTriangle(px: number, py: number, a: Vector2Like, b: Vector2Like, c: Vector2Like): boolean {
  const d = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)
  if (d === 0) return false
  const s = ((px - a.x) * (c.y - a.y) - (c.x - a.x) * (py - a.y)) / d
  const t = ((b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y)) / d
  return s >= 0 && t >= 0 && s + t <= 1
}

/** What meshFromContours does, on bare rings - fill triangles by the nonzero rule. */
function fillOf(rings: readonly Vector2Like[][]): { vertices: Vector2Like[]; indices: number[] } {
  const vertices: Vector2Like[] = []
  const indices: number[] = []
  for (const group of windingGroups(rings.flatMap((ring) => simpleLoops(ring)))) {
    const piece = triangulateGroup(group)
    const base = vertices.length
    for (const v of piece.vertices) vertices.push(v)
    for (const i of piece.indices) indices.push(base + i)
  }
  return { vertices, indices }
}

const filled = (fill: { vertices: Vector2Like[]; indices: number[] }, x: number, y: number): boolean => {
  for (let i = 0; i < fill.indices.length; i += 3) {
    const a = fill.vertices[fill.indices[i]]
    const b = fill.vertices[fill.indices[i + 1]]
    const c = fill.vertices[fill.indices[i + 2]]
    if (inTriangle(x, y, a, b, c)) return true
  }
  return false
}

it('a bar laid across a stem is a second solid, not a hole', () => {
  // The shape of a 't': two rings wound the same way, one crossing the other. Nesting reads the
  // bar's own sample point as being inside the stem and cuts it out; direction reads two solids.
  const stem = square(40, 0, 20, 100)
  const bar = square(0, 60, 100, 15)

  const groups = windingGroups([stem, bar])
  assert(groups.length === 2, 'both rings are solids')
  assert(groups.every((g) => g.holes.length === 0), 'and neither is a hole of the other')

  const fill = fillOf([stem, bar])
  assert(filled(fill, 10, 67), 'the bar is drawn where it reaches past the stem')
  assert(filled(fill, 50, 67), 'and where the two overlap')
  assert(filled(fill, 50, 20), 'the stem is drawn below the bar')
  assert(!filled(fill, 10, 20), 'and nothing is drawn beside it')
})

it('a ring wound the other way inside a solid is still a hole', () => {
  // The other half of the rule, and what an 'o' relies on.
  const outer = square(0, 0, 100, 100)
  const counter = reversed(square(30, 30, 40, 40))

  const groups = windingGroups([outer, counter])
  assert(groups.length === 1 && groups[0].holes.length === 1, 'one solid with one hole in it')

  const fill = fillOf([outer, counter])
  assert(filled(fill, 10, 50), 'the ring is drawn')
  assert(!filled(fill, 50, 50), 'and the counter is not')
})

it('a ring that crosses itself is cut into loops that do not', () => {
  // A bowtie: the classic self-crossing ring, and what earcut cannot take. Its two lobes are
  // wound opposite ways, so one is a solid and the other is a hole of nothing and is dropped -
  // which is the nonzero reading of a bowtie.
  const bowtie: Vector2Like[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 0, y: 100 },
    { x: 100, y: 100 },
  ]
  const loops = simpleLoops(bowtie)
  assert(loops.length === 2, 'the crossing splits it in two')
  assert(loops.every((loop) => simpleLoops(loop).length === 1), 'and neither half crosses anything')

  // The two strokes of a 'w' meeting at a V: same ring, doubling back over itself. The overlap
  // is wound the same way as the ring, so it stays filled rather than being punched out.
  const vee: Vector2Like[] = [
    { x: 0, y: 100 },
    { x: 20, y: 100 },
    { x: 55, y: 10 },
    { x: 45, y: 10 },
    { x: 80, y: 100 },
    { x: 100, y: 100 },
    { x: 60, y: 0 },
    { x: 40, y: 0 },
  ]
  const fill = fillOf([vee])
  assert(filled(fill, 50, 5), 'the bottom of the V is solid')
  assert(filled(fill, 50, 14), 'including the sliver where the two strokes cross')
  assert(!filled(fill, 50, 60), 'while the gap between them stays open')
})

it('the silhouette of overlapping pieces has no seam in it', () => {
  // Two squares crossing: the union is one ring, and the four stretches of edge buried inside
  // the other square are gone. Stroking the pieces instead would draw both squares in full.
  const cross = unionBoundary([
    { points: square(40, 0, 20, 100), closed: true },
    { points: square(0, 40, 100, 20), closed: true },
  ])
  assert(cross.length === 1, 'a plus sign is one ring')
  assert(cross[0].points.length === 12, 'with a corner at each of its twelve turns')

  // A counter survives as a hole in the silhouette, wound against it.
  const ring = unionBoundary([
    { points: square(0, 0, 100, 100), closed: true },
    { points: reversed(square(30, 30, 40, 40)), closed: true },
  ])
  assert(ring.length === 2, 'an outline with a counter is two rings')
  assert(Math.sign(signedArea(ring[0].points)) !== Math.sign(signedArea(ring[1].points)), 'wound against each other')

  // A piece entirely swallowed by another leaves nothing of itself behind.
  const swallowed = unionBoundary([
    { points: square(0, 0, 100, 100), closed: true },
    { points: square(20, 20, 10, 10), closed: true },
  ])
  assert(swallowed.length === 1 && swallowed[0].points.length === 4, 'the inner square is not part of the outline')
})

it('no glyph silhouette runs through the inside of its letter', () => {
  // The post-condition, over the whole face: every stretch of the outline has material on
  // exactly one side of it. A stretch with material on both is a join between two pieces - the
  // bar of a 't' outlined as a rectangle through the stem - which is what a stroke would draw.
  const json = interRegular as unknown as PolygonFontJson
  const font = new PolygonFont(json)

  let checked = 0
  for (const glyph of json.glyphs) {
    if (!glyph.rings || glyph.rings.length === 0) continue
    const rings = glyph.rings.map((flat) => {
      const points: Vector2Like[] = []
      for (let i = 0; i + 1 < flat.length; i += 2) points.push({ x: flat[i], y: flat[i + 1] })
      return points
    })
    for (const contour of font.mesh(glyph.codePoint)!.contours) {
      const points = contour.points
      for (let i = 0; i < points.length; i++) {
        const a = points[i]
        const b = points[(i + 1) % points.length]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const length = Math.hypot(dx, dy)
        if (length === 0) continue
        const off = 0.002
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        const inside = (sx: number, sy: number) => windingNumber(mx + sx, my + sy, rings) !== 0
        const one = inside((-dy / length) * off, (dx / length) * off)
        const other = inside((dy / length) * off, (-dx / length) * off)
        assert(one !== other, `'${String.fromCodePoint(glyph.codePoint)}' has a seam in its outline`)
        checked++
      }
    }
  }
  assert(checked > 10000, 'and that is the whole face, not a handful of letters')
})

it('every glyph in the atlas fills the way its outline was drawn', () => {
  // The whole face, against the rule rather than against a picture. Roughly a third of these
  // glyphs are built from overlapping pieces or cross themselves at a join.
  const json = interRegular as unknown as PolygonFontJson
  const font = new PolygonFont(json)

  const worst = { char: '-', rate: 0 }
  for (const glyph of json.glyphs) {
    if (!glyph.rings || glyph.rings.length === 0) continue
    const mesh = font.mesh(glyph.codePoint)!
    const rings = mesh.contours.map((c) => c.points as Vector2Like[])

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const ring of rings) {
      for (const p of ring) {
        if (p.x < minX) minX = p.x
        if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y
        if (p.y > maxY) maxY = p.y
      }
    }

    // An odd grid over the box, offset off the halfway lines so the samples miss the horizontal
    // and vertical edges a letterform is mostly made of - a sample sitting exactly on an edge is
    // a question neither test has an answer to.
    const steps = 31
    let wrong = 0
    let sampled = 0
    for (let r = 0; r < steps; r++) {
      for (let c = 0; c < steps; c++) {
        const x = minX + ((c + 0.317) / steps) * (maxX - minX)
        const y = minY + ((r + 0.211) / steps) * (maxY - minY)
        sampled++
        if (filled(mesh, x, y) !== (windingNumber(x, y, rings) !== 0)) wrong++
      }
    }
    if (wrong / sampled > worst.rate) {
      worst.char = String.fromCodePoint(glyph.codePoint)
      worst.rate = wrong / sampled
    }
  }

  // Not zero: a sample can still land within a rounding error of an edge, where "inside a
  // triangle" and "winding is non-zero" are each entitled to their own answer.
  assert(worst.rate < 0.01, `the worst glyph ('${worst.char}') disagrees at ${(worst.rate * 100).toFixed(2)}% of samples`)
})
