// Writing a scene down and reading it back, and copying a node in memory.

import { expect, it } from 'vitest'
import { Circle } from '../shapes/Circle'
import { Container } from '../shapes/Container'
import { CustomShape } from '../shapes/CustomShape'
import { Group } from '../shapes/Group'
import { Image } from '../shapes/Image'
import { Layer } from '../shapes/Layer'
import { Rect } from '../shapes/Rect'
import { UniformVectorText } from '../shapes/UniformVectorText'
import type { ShapeContext } from '../shapes/ShapeContext'
import { nextZIndex, peekZIndex } from '../shapes/zOrder'
import type { ImageTexture } from '../image/ImageTexture'
import { SharedLifetime } from '../resources/SharedLifetime'
import { registerNodeType } from './nodeRegistry'
import { clone, fromObject, toObject, type NodeSnapshot } from './serialize'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}

it('a snapshot carries the class, what differs from the defaults, and the children', () => {
  const group = new Group({ x: 10, name: 'panel' })
  group.add(new Rect({ width: 4, height: 2, fill: 'tomato' }), new Circle({ radius: 3 }))

  const snapshot = toObject(group)
  assert(snapshot.className === 'Group', 'the class is named')
  assert(snapshot.attrs.x === 10 && snapshot.attrs.name === 'panel', 'what was set is written')
  assert(!('y' in snapshot.attrs), 'and what was left at its default is not')
  assert(!('shadowBlur' in snapshot.attrs), 'however many defaults there are')
  assert(snapshot.children?.length === 2, 'children come along')
  assert(snapshot.children?.[0].className === 'Rect', 'each named by its own class')
  assert(snapshot.children?.[1].attrs.radius === 3, 'and carrying its own attributes')

  // It really is data - the whole point of writing it down.
  const text = JSON.stringify(snapshot)
  assert(text.includes('"Rect"'), 'a snapshot is JSON')
  assert(JSON.parse(text).children[0].attrs.fill.length === 4, 'a colour crosses as its four numbers')

  // A leaf carries no empty children array.
  assert(toObject(new Rect()).children === undefined, 'a leaf has no children key at all')
})

it('a document round-trips to an equal scene', () => {
  const original = new Layer({ name: 'art' })
  original.add(
    new Rect({ x: 1, y: 2, width: 30, height: 40, fill: 'tomato', stroke: 'black', strokeWidth: 3, cornerRadius: 5 }),
    new Group({ x: 100 }).add(new Circle({ radius: 7, fill: [0, 0.5, 1, 1], dash: [4, 2] })),
  )

  const restored = fromObject(JSON.parse(JSON.stringify(toObject(original)))) as Layer

  assert(restored.nodeName === 'Layer' && restored.name === 'art', 'the root comes back as itself')
  const rect = restored.children[0] as Rect
  assert(rect.x === 1 && rect.width === 30 && rect.cornerRadius === 5, 'a shape keeps its own attributes')
  assert(rect.strokeWidth === 3 && rect.stroke?.[3] === 1, 'including its paint')
  const circle = (restored.children[1] as Group).children[0] as Circle
  assert(circle.radius === 7, 'and so does one two levels down')
  assert(circle.dash.join() === '4,2', 'a list attribute crosses intact')

  // The claim that matters for a document: writing the restored scene gives the same data.
  assert(
    JSON.stringify(toObject(restored)) === JSON.stringify(toObject(original)),
    'and writing it back out again gives the same document',
  )
})

it('a uniform text node is written as the attributes it takes back', () => {
  // Its content is `text`, and the run list underneath is derived from it. Writing the list as
  // well would name the content twice - and a uniform text node refuses `runs` in its
  // constructor, so a document carrying one cannot be read at all.
  const original = new UniformVectorText({ text: 'hello', fontSize: 18, fontStyle: 'bold' })
  const snapshot = toObject(original)
  assert(snapshot.attrs.text === 'hello', 'the string is in the document')
  assert(!('runs' in snapshot.attrs), 'and the runs it is rebuilt into are not')

  const restored = fromObject(JSON.parse(JSON.stringify(snapshot))) as UniformVectorText
  assert(restored.text === 'hello' && restored.fontSize === 18, 'so it reads back as what it was')
  assert(restored.fontStyle === 'bold' && restored.runs[0].style?.fontStyle === 'bold', 'with the run rebuilt from it')
})

it('reading a document winds the stacking counter past it', () => {
  // A saved drawing carries zIndex values from the session that made it. A shape drawn after
  // the load has to land in FRONT of it, which it cannot do if the counter is still near zero.
  const saved: NodeSnapshot = {
    className: 'Container',
    attrs: {},
    children: [{ className: 'Rect', attrs: { zIndex: peekZIndex() + 5000, width: 1, height: 1 } }],
  }
  const loaded = fromObject(saved) as Container
  const top = (loaded.children[0] as Rect).zIndex

  assert(nextZIndex() > top, 'the next shape made lands above everything the document brought')
})

it('what cannot be written is reported, and can be stood in for', () => {
  const rect = new Rect({ width: 1, height: 1 })
  rect.dragBoundFunc = (p) => p

  const skipped: string[] = []
  const bare = toObject(rect, { onSkipped: (_node, key) => skipped.push(key) })
  assert(!('dragBoundFunc' in bare.attrs), 'a function is not written')
  assert(skipped.join() === 'dragBoundFunc', 'and the caller is told which attribute went missing')

  const named = toObject(rect, { replace: (_node, key) => (key === 'dragBoundFunc' ? 'clampToRow' : undefined) })
  assert(named.attrs.dragBoundFunc === 'clampToRow', 'a stand-in is written instead')

  const back = fromObject(named, {
    revive: (_className, key, value) => (key === 'dragBoundFunc' && value === 'clampToRow' ? (p: unknown) => p : value),
  }) as Rect
  assert(typeof back.dragBoundFunc === 'function', 'and revived on the way back in')
})

it('an application class round-trips once it is registered', () => {
  class Wedge extends CustomShape {
    override readonly nodeName: string = 'Wedge'
    protected describe(ctx: ShapeContext): void {
      ctx.moveTo(0, 0)
      ctx.lineTo(10, 0)
      ctx.lineTo(0, 10)
      ctx.closePath()
      ctx.fill()
    }
  }

  let threw = false
  try {
    fromObject({ className: 'Wedge', attrs: {} })
  } catch {
    threw = true
  }
  assert(threw, 'an unregistered class is refused by name rather than dropped')

  registerNodeType('Wedge', Wedge as never)
  const restored = fromObject(toObject(new Wedge({ x: 4, fill: 'teal', tolerance: 0.5 }))) as Wedge
  assert(restored instanceof Wedge && restored.x === 4 && restored.tolerance === 0.5, 'and read back once registered')
})

it('clone copies a subtree live, sharing what it holds', () => {
  const group = new Group({ x: 5, name: 'stamp' })
  const rect = group.addChild(new Rect({ width: 8, height: 4, fill: 'tomato' }))

  const copy = clone(group)
  assert(copy !== group && copy.x === 5 && copy.name === 'stamp', 'a second node with the same attributes')
  assert(copy.parent === null, 'detached, until it is added somewhere')
  assert(copy.children.length === 1 && copy.children[0] !== rect, 'and its children are copies too')
  assert((copy.children[0] as Rect).width === 8, 'carrying their own attributes')

  // Independent from here on.
  copy.x = 900
  assert(group.x === 5, 'moving the copy leaves the original alone')

  // Overrides are how a copy is placed, since a faithful copy ties with what it came from.
  const front = clone(rect, { zIndex: nextZIndex(), x: 50 })
  assert(front.zIndex > rect.zIndex && front.x === 50, 'an override lands on the copy only')
  assert(rect.x === 0, 'and not on the original')
})

it('clone retains a texture it copies, so each node frees it independently', () => {
  class FakeTexture implements ImageTexture {
    readonly lifetime = new SharedLifetime()
    readonly width = 4
    readonly height = 4
    freed = false
    destroy(): void {
      if (this.lifetime.release()) this.freed = true
    }
  }

  const texture = new FakeTexture()
  const original = new Image({ texture })
  const copy = clone(original)

  assert(texture.lifetime.holderCount === 2, 'the copy is a second holder, not a second name for the first')

  original.destroy()
  texture.destroy()
  assert(!texture.freed, 'one holder letting go leaves the texture the other node still draws intact')

  copy.destroy()
  texture.destroy()
  assert(texture.freed, 'the second holder letting go is what actually frees it')

  // An override supplying its own texture is the caller's object, on the caller's own terms -
  // clone() gains it no extra hold.
  const other = new FakeTexture()
  clone(new Image({ texture }), { texture: other })
  assert(other.lifetime.holderCount === 1, 'an overridden attribute is left exactly as the caller gave it')
})
