// What a Node exposes, measured against Konva's Node - the reference this engine's scene-graph
// API is shaped after, so that someone who knows one can read the other and a generic attribute
// walker (a property inspector, a serializer, a change-event dispatcher) finds the keys it
// expects where it expects them. Run with:
//   npx vitest run packages/engine/src/shapes/konvaParity.test.ts
//
// The lists below are DATA rather than assertions written out one by one, because the claim
// being made is about the SET: every scalar attribute Konva registers on its Node is on this
// one, three named ones are deliberately absent, and the compound accessors exist as accessors
// without also appearing among the attributes. A half-finished change to any of those three
// claims fails here rather than in whatever reads attrs six months later.

import { expect, it } from 'vitest'
import { Container } from './Container'
import { Group } from './Group'
import { Layer } from './Layer'
import { Node } from './Node'
import { Rect } from './Rect'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps

/**
 * Every scalar attribute Konva registers on Node (konva/src/Node.ts, the Factory block at the
 * end of the file), minus the three below that this engine does not have.
 */
const KONVA_NODE_ATTRIBUTES = [
  'id',
  'name',
  'x',
  'y',
  'width',
  'height',
  'rotation',
  'scaleX',
  'scaleY',
  'skewX',
  'skewY',
  'offsetX',
  'offsetY',
  'visible',
  'opacity',
  'zIndex',
  'listening',
  'preventDefault',
  'draggable',
  'dragDistance',
  'dragBoundFunc',
] as const

/**
 * The three Konva registers that are not here, each for a reason that is about this renderer
 * rather than about the attribute:
 *
 *   globalCompositeOperation  a canvas 2D blend mode. Here it means a render pipeline per mode
 *                             and a repack of the draw list by mode.
 *   transformsEnabled         names an optimisation Node.localMatrix() already performs
 *                             unconditionally - rotation, skew and scale are each skipped when
 *                             they are the identity.
 *   filters                   Konva's filters run over a cached canvas; there is no
 *                             cache-to-texture layer. (Image.filter is a texture sampling mode
 *                             and is unrelated.)
 *
 * Asserted absent rather than left unmentioned, so that adding one of them as a field nothing
 * consults - the failure mode this list exists to prevent - stops here.
 */
const DELIBERATELY_ABSENT = ['globalCompositeOperation', 'transformsEnabled', 'filters'] as const

/** The compound accessors, and the pair of components each one reads and writes. */
const COMPOUNDS = [
  { name: 'position', components: ['x', 'y'] },
  { name: 'scale', components: ['scaleX', 'scaleY'] },
  { name: 'skew', components: ['skewX', 'skewY'] },
  { name: 'offset', components: ['offsetX', 'offsetY'] },
  { name: 'size', components: ['width', 'height'] },
] as const

it('every attribute Konva puts on Node is on this Node, on every tier', () => {
    // A bare Container, because the claim is about NODES rather than about drawables: a group,
    // a layer and a plain container answer the same questions a shape does.
    for (const node of [new Container(), new Group(), new Layer(), new Rect()]) {
      const keys = Object.keys(node.attrs)
      for (const attribute of KONVA_NODE_ATTRIBUTES) {
        assert(keys.includes(attribute), `${node.nodeName}.attrs carries '${attribute}'`)
      }
    }

    // And a Shape adds its own on top rather than replacing any of them.
    const rect = new Rect({ width: 4, height: 2 })
    const shapeKeys = Object.keys(rect.attrs)
    assert(shapeKeys.includes('fill') && shapeKeys.includes('strokeWidth'), "a Shape's paint is there too")
    assert(shapeKeys.includes('pickable') && shapeKeys.includes('overlay'), 'along with what only a drawable has')
})

it('the three Konva attributes this engine does not implement are absent, not stubbed', () => {
    const node: Record<string, unknown> = new Rect() as unknown as Record<string, unknown>
    const keys = Object.keys(new Rect().attrs)
    for (const attribute of DELIBERATELY_ABSENT) {
      assert(!keys.includes(attribute), `'${attribute}' is not among the attributes`)
      assert(node[attribute] === undefined, `and there is no field called '${attribute}' either`)
    }
})

it('attrs reports the components, never the compound that reads them', () => {
    // A compound in attrKeys() would report every value twice and give setAttr two racing ways
    // to write one field, so the accessors exist while the attribute list stays the components.
    const rect = new Rect({ width: 4, height: 2 })
    const keys = Object.keys(rect.attrs)
    for (const { name, components } of COMPOUNDS) {
      assert(!keys.includes(name), `'${name}' is an accessor, not an attribute`)
      for (const component of components) assert(keys.includes(component), `while '${component}' is one`)
    }
    assert(!keys.includes('absolutePosition'), 'and absolutePosition is derived from the whole chain, not stored')
})

it('each compound reads and writes its pair', () => {
    const node = new Node()

    node.position = { x: 3, y: 4 }
    node.scale = { x: 2, y: 5 }
    node.skew = { x: 0.25, y: 0.5 }
    node.offset = { x: 7, y: 8 }
    node.size = { width: 30, height: 20 }

    assert(node.x === 3 && node.y === 4, 'position writes x and y')
    assert(node.scaleX === 2 && node.scaleY === 5, 'scale writes scaleX and scaleY')
    assert(node.skewX === 0.25 && node.skewY === 0.5, 'skew writes skewX and skewY')
    assert(node.offsetX === 7 && node.offsetY === 8, 'offset writes offsetX and offsetY')
    assert(node.width === 30 && node.height === 20, 'size writes width and height')

    node.x = 11
    assert(node.position.x === 11, 'and reading a compound reads the components back, not a stored copy')

    // A fresh object each read, so a caller holding one cannot write through it by accident.
    const held = node.position
    node.y = 99
    assert(held.y === 4 && node.position.y === 99, 'each read is a snapshot, not a live view')
})

it('absolutePosition is where x/y land in the world, and setting it is the exact inverse', () => {
    const outer = new Group({ x: 100, y: 50, rotation: 90, scaleX: 2, scaleY: 2 })
    const inner = outer.addChild(new Group({ x: 10, y: 0, offsetX: 4, offsetY: 6 }))
    const leaf = inner.addChild(new Rect({ x: 5, y: 5, width: 1, height: 1, offsetX: 3 }))

    // Worked out by hand rather than by asking the matrices, which is what makes this a check
    // and not a restatement. The inner group folds its pivot into its placement, so it maps a
    // local (p, q) to (p + 6, q - 6) and the leaf's (5, 5) becomes (11, -1). The outer group
    // doubles that and turns it a quarter turn - (a, b) → (-2b, 2a) - then places it at
    // (100, 50), giving (100 + 2, 50 + 22).
    const world = leaf.absolutePosition
    assert(near(world.x, 102) && near(world.y, 72), 'it is the point x/y names, seen from the scene')

    // The pivot is applied to a node's CONTENTS, so it is not in this answer - which is exactly
    // what lets the setter undo the getter through a chain that has one at every level.
    leaf.absolutePosition = { x: -40, y: 17 }
    const back = leaf.absolutePosition
    assert(near(back.x, -40) && near(back.y, 17), 'assigning a world point puts the origin on it')

    // A detached node has no chain, so its own x/y already are the world position.
    const loose = new Rect({ x: 2, y: 3 })
    assert(loose.absolutePosition.x === 2 && loose.absolutePosition.y === 3, 'and a node with no parent is its own world')
    loose.absolutePosition = { x: 8, y: 9 }
    assert(loose.x === 8 && loose.y === 9, 'writing one straight through')
})
