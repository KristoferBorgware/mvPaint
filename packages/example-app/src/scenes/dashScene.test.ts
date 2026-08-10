// The dash scene, checked as geometry rather than looked at.
//
// A scene is content, so most of what it demonstrates is a picture and belongs on screen. Four
// of its claims are not: they are statements about where the triangles ended up, and each one
// would fail silently on screen as something a reader would take for a design choice - a dotted
// line whose dots have merged, a corner the pattern happened to miss, a dashed ring whose
// alignment quietly reverted to centred. Those are pinned here.

import { expect, it } from 'vitest'
import { pickNode, Polyline, Rect, Scene } from '@mvpaint/engine'
import { buildDashScene } from './dashScene'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps

function built() {
  const scene = new Scene()
  const content = buildDashScene(scene)
  const find = <T>(name: string): T => {
    const node = scene.root.findOne(`.${name}`)
    if (!node) throw new Error(`the scene has no node named '${name}'`)
    return node as T
  }
  return { scene, content, find }
}

it('the dotted line is really dots, with gaps between them', () => {
  // dash [1, 14] under a round cap: a one-long dash whose two caps meet, repeating every 15.
  // If the pattern were ignored the whole line would be ink and every probe below would hit.
  const { find } = built()
  const dotted = find<Polyline>('pattern-2')
  const y = dotted.points[0].y

  assert(dotted.hitTestLocal(-190, y), 'the first dot is at the start of the path')
  assert(!dotted.hitTestLocal(-182.5, y), 'and the middle of the gap after it is empty')
  assert(dotted.hitTestLocal(-175, y), 'with the next dot one period along')
  assert(!dotted.hitTestLocal(-167.5, y), 'and a gap after that one too')
})

it('a dash spans the corner rather than restarting at it', () => {
  // Walked by arc length from (-500, 30): dashes at 0-34, 48-82, 96-130. The first corner is at
  // 116.6 along, which falls inside the third - so the corner itself is inked, and the piece
  // carrying it has the corner vertex in it for the stroker to build a join from.
  const { find } = built()
  const zig = find<Polyline>('dashed-corners')
  assert(zig.hitTestLocal(-400, -30), 'the corner is covered by the dash that runs through it')

  // 48 along is the start of the second dash; 40 along is inside the gap before it.
  const at = (d: number) => ({ x: -500 + (d / 116.619) * 100, y: 30 - (d / 116.619) * 60 })
  const gap = at(40)
  const ink = at(60)
  assert(!zig.hitTestLocal(gap.x, gap.y), 'a gap is a gap on a diagonal too')
  assert(zig.hitTestLocal(ink.x, ink.y), 'and the dash after it is drawn')
})

it('a dashed ring keeps the alignment the whole ring asked for', () => {
  // The one that would fail quietly. A dash is an open path with no enclosed side, so a piece
  // left to answer `strokeAlign` for itself centres - and a centred 14-wide ribbon on a 120x74
  // box measures 134x88 whichever alignment was asked for. These three numbers are only right
  // if the sides were resolved from the ring and carried into every piece.
  const { find } = built()
  const size = (name: string) => {
    const box = find<Rect>(name).localBounds()
    return { w: box.max.x - box.min.x, h: box.max.y - box.min.y }
  }

  const inside = size('dash-align-inside')
  assert(near(inside.w, 120) && near(inside.h, 74), 'an inside dash does not grow the node at all')

  const centre = size('dash-align-center')
  assert(near(centre.w, 134) && near(centre.h, 88), 'a centred one grows by half the width each way')

  const outside = size('dash-align-outside')
  assert(near(outside.w, 148) && near(outside.h, 102), 'and an outside one by the whole width')
})

it('the ants march, and the two hairlines differ only in what can grab them', () => {
  const { scene, content, find } = built()
  const ants = find<Rect>('marching-ants')
  const before = ants.dashOffset
  const version = ants.geometryVersion

  content.onFrame?.(0.5, 1)
  assert(ants.dashOffset !== before, 'a frame moves the pattern along the outline')
  assert(ants.geometryVersion > version, 'and re-tessellates, which is what an animated dash costs')

  // All three hairlines are drawn one unit wide; two of them are worth aiming at. Tested
  // through pickNode in WORLD coordinates, where an application's pointer arrives.
  const hard = find<Polyline>('hairline-hard')
  const easy = find<Polyline>('hairline-easy')
  const scaled = find<Polyline>('hairline-scaled')
  assert(
    hard.strokeWidth === 1 && easy.strokeWidth === 1 && scaled.strokeWidth === 1,
    'all three lines are drawn identically',
  )

  assert(pickNode(scene, 130, 270) === hard, 'the plain one can be hit dead on')
  assert(pickNode(scene, 138, 270) === null, 'and eight units off it is missed')

  assert(pickNode(scene, 288, 270) === easy, 'the one with a hit ribbon is caught eight units off')
  assert(pickNode(scene, 300, 270) === null, 'and lost twenty units off')

  // The claim the third one is there for: six times the scale, six times the reach.
  assert(pickNode(scene, 470 + 60, 270) === scaled, 'the one in a group scaled by six is caught sixty units off')
  assert(pickNode(scene, 470 + 80, 270) === null, 'and lost at eighty, six times where the ungrouped one gives up')
})
