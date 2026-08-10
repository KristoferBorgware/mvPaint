// getClientRect: one box that works on any node, in whichever space the caller names.
//
// The numbers below are worked out by hand rather than read off the implementation, which is
// what makes them a check on the maths and not a restatement of it.

import { expect, it } from 'vitest'
import { Circle } from './Circle'
import { Container } from './Container'
import { Group } from './Group'
import { Rect } from './Rect'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps

it('a shape measures its triangles, in its parent space', () => {
  // 40x20, placed at (100, 50), with a centred 4-wide stroke reaching 2 units each way.
  const rect = new Rect({ x: 100, y: 50, width: 40, height: 20, fill: 'tomato', stroke: 'black', strokeWidth: 4 })

  const box = rect.getClientRect()
  assert(near(box.x, 98) && near(box.y, 48), 'the stroke pushes the corner two units up and left')
  assert(near(box.width, 44) && near(box.height, 24), 'and adds its width to each axis')

  const noStroke = rect.getClientRect({ skipStroke: true })
  assert(near(noStroke.x, 100) && near(noStroke.width, 40), 'skipStroke measures the fill alone')

  const untransformed = rect.getClientRect({ skipTransform: true })
  assert(near(untransformed.x, -2) && near(untransformed.y, -2), 'skipTransform drops the placement')
  assert(near(untransformed.width, 44), 'while keeping the size')
})

it('a shadow is part of what a node covers, and can be left out', () => {
  const rect = new Rect({ width: 10, height: 10, fill: 'tomato' })
  const plain = rect.getClientRect()
  assert(near(plain.width, 10), 'no shadow, no growth')

  rect.shadowBlur = 6
  rect.shadowOffsetX = 4
  rect.shadowOffsetY = 0
  // The shadow copy spans x in [-6+4, 10+6+4] = [-2, 20], unioned with the shape's [0, 10].
  const shadowed = rect.getClientRect()
  assert(near(shadowed.x, -2), 'the blur reaches back past the shape, less the offset')
  assert(near(shadowed.x + shadowed.width, 20), 'and forward past it, plus the offset')
  assert(near(shadowed.y, -6) && near(shadowed.y + shadowed.height, 16), 'and symmetrically on the unoffset axis')

  const without = rect.getClientRect({ skipShadow: true })
  assert(near(without.width, 10) && near(without.x, 0), 'skipShadow measures the shape alone')
})

it('a container measures what it holds, through each local matrix', () => {
  const group = new Group({ x: 1000, y: 0 })
  group.add(
    new Rect({ x: 0, y: 0, width: 10, height: 10, fill: 'tomato', strokeWidth: 0 }),
    new Rect({ x: 90, y: 40, width: 10, height: 10, fill: 'teal', strokeWidth: 0 }),
  )

  // In the group's own space the two rects span x in [0, 100] and y in [0, 50].
  const own = group.getClientRect({ skipTransform: true })
  assert(near(own.x, 0) && near(own.y, 0) && near(own.width, 100) && near(own.height, 50), 'the union of its children')

  // In its parent's space the group's own x carries it.
  const placed = group.getClientRect()
  assert(near(placed.x, 1000), 'carried through the group\'s own transform')

  // An empty container has nothing to measure, and says so rather than claiming a point.
  const empty = new Container()
  const nothing = empty.getClientRect()
  assert(nothing.width === 0 && nothing.height === 0 && nothing.x === 0, 'an empty container measures as the empty box')

  // A hidden child is not part of the picture, so it is not part of the measurement.
  const shown = group.getClientRect({ skipTransform: true })
  ;(group.children[1] as Rect).visible = false
  const hidden = group.getClientRect({ skipTransform: true })
  assert(near(shown.width, 100) && near(hidden.width, 10), 'a hidden child drops out of the box')
})

it('relativeTo reports the box in an ancestor space, through every transform between', () => {
  const root = new Container()
  const outer = root.addChild(new Group({ x: 100, y: 0, scaleX: 2, scaleY: 2 }))
  const inner = outer.addChild(new Group({ x: 10, y: 0 }))
  const dot = inner.addChild(new Circle({ radius: 5, fill: 'tomato', strokeWidth: 0 }))

  // A circle of radius 5 is centred on its origin, so in `inner` it spans [-5, 5]. `inner` sits
  // at x=10, so in `outer` that is [5, 15]; `outer` doubles and shifts by 100, giving [110, 130].
  const inRoot = dot.getClientRect({ relativeTo: root })
  assert(near(inRoot.x, 110) && near(inRoot.width, 20), 'every transform between the two is composed')

  const inOuter = dot.getClientRect({ relativeTo: outer })
  assert(near(inOuter.x, 5) && near(inOuter.width, 10), 'and stopping earlier stops applying them')

  // The default is the parent's space, which for this node is `inner`.
  const inParent = dot.getClientRect()
  assert(near(inParent.x, -5) && near(inParent.width, 10), 'with no ancestor named, it is the parent')
})
