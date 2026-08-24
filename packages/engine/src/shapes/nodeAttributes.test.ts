// The attribute surface: what getAttr()/setAttr()/attrs expose, on which tier, and what is
// deliberately not there. A generic attribute walker - a property inspector, a serializer, a
// change-event dispatcher - finds the keys it expects where it expects them, and that is a
// claim about the SET rather than about any one key.
//
// So the lists below are DATA rather than assertions written out one by one: every attribute a
// Node declares is on every tier, three named ones are absent rather than stubbed, and the
// compound accessors exist as accessors without also appearing among the attributes. A
// half-finished change to any of those claims fails here rather than in whatever reads attrs
// six months later.

import { expect, it } from 'vitest'
import { Circle } from './Circle'
import { Container } from './Container'
import { CustomShape } from './CustomShape'
import { Group } from './Group'
import { Image } from './Image'
import { Layer } from './Layer'
import { MSDFText } from './MSDFText'
import { Node } from './Node'
import { Transformer } from './Transformer'
import { UniformVectorText } from './UniformVectorText'
import { SharedLifetime } from '../resources/SharedLifetime'
import type { ImageTexture } from '../image/ImageTexture'
import { Path } from './Path'
import { Polyline } from './Polyline'
import { Rect } from './Rect'
import type { ShapeContext } from './ShapeContext'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps

/** An Image needs a texture to be constructed; nothing here ever samples one. */
function stubTexture(width: number, height: number): ImageTexture {
  return { width, height, lifetime: new SharedLifetime(), destroy() {} }
}

/** Every attribute Node declares - see Node.attrKeys(). */
const NODE_ATTRIBUTES = [
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
 * Three attributes a 2D scene graph might be expected to carry, each absent for a reason about
 * this renderer rather than about the attribute:
 *
 *   globalCompositeOperation  a canvas blend mode. Here it means a render pipeline per mode and
 *                             a repack of the draw list by mode.
 *   transformsEnabled         names an optimisation Node.localMatrix() performs
 *                             unconditionally - rotation, skew and scale are each skipped when
 *                             they are the identity.
 *   filters                   a filter runs over a cached raster; there is no cache-to-texture
 *                             layer. (Image.filter is a texture sampling mode and is unrelated.)
 *
 * Asserted absent rather than left unmentioned, so that adding one of them as a field nothing
 * consults - the failure mode this list exists to prevent - stops here.
 */
const DELIBERATELY_ABSENT = ['globalCompositeOperation', 'transformsEnabled', 'filters'] as const

/**
 * The paint a painted shape carries and an Image does not - see UNPAINTED in Image.ts. Written
 * out here rather than imported, so that a key quietly gaining or losing its place in that list
 * fails as a change to a stated claim instead of as no change at all.
 */
const UNPAINTED_ON_AN_IMAGE = [
  'fill',
  'fillEnabled',
  'fillPriority',
  'fillLinearGradientStartPoint',
  'fillLinearGradientEndPoint',
  'fillLinearGradientColorStops',
  'fillRadialGradientStartPoint',
  'fillRadialGradientStartRadius',
  'fillRadialGradientEndPoint',
  'fillRadialGradientEndRadius',
  'fillRadialGradientColorStops',
  'stroke',
  'strokeEnabled',
  'strokeWidth',
  'hitStrokeWidth',
  'dash',
  'dashOffset',
  'dashEnabled',
  'strokeAlign',
  'lineJoin',
  'lineCap',
  'miterLimit',
  'strokeScaleEnabled',
] as const

/** The compound accessors, and the pair of components each one reads and writes. */
const COMPOUNDS = [
  { name: 'position', components: ['x', 'y'] },
  { name: 'scale', components: ['scaleX', 'scaleY'] },
  { name: 'skew', components: ['skewX', 'skewY'] },
  { name: 'offset', components: ['offsetX', 'offsetY'] },
  { name: 'size', components: ['width', 'height'] },
] as const

it('every Node attribute is on every tier', () => {
  // A bare Container as well as the drawable, because the claim is about NODES rather than
  // about drawables: a group, a layer and a plain container answer the same questions a shape
  // does.
  for (const node of [new Container(), new Group(), new Layer(), new Rect()]) {
    const keys = Object.keys(node.attrs)
    for (const attribute of NODE_ATTRIBUTES) {
      assert(keys.includes(attribute), `${node.nodeName}.attrs carries '${attribute}'`)
    }
  }

  // And a Shape adds its own on top rather than replacing any of them.
  const rect = new Rect({ width: 4, height: 2 })
  const shapeKeys = Object.keys(rect.attrs)
  assert(shapeKeys.includes('fill') && shapeKeys.includes('strokeWidth'), "a Shape's paint is there too")
  assert(shapeKeys.includes('overlay'), 'along with what only a drawable has')
})

it('the three unimplemented attributes are absent, not stubbed', () => {
  const node: Record<string, unknown> = new Rect() as unknown as Record<string, unknown>
  const keys = Object.keys(new Rect().attrs)
  for (const attribute of DELIBERATELY_ABSENT) {
    assert(!keys.includes(attribute), `'${attribute}' is not among the attributes`)
    assert(node[attribute] === undefined, `and there is no field called '${attribute}' either`)
  }
})

it('an Image reports no paint, because nothing paints it', () => {
  // An Image's triangles go to the image lane, which reads a texture and a tint and nothing
  // about a fill. Reporting the paint anyway put twenty-three attributes in front of every
  // property inspector and into every saved document, each one settable and none of them read.
  const image = new Image({ texture: stubTexture(4, 4) })
  const keys = new Set(image.attributeNames())
  const missing = new Rect().attributeNames().filter((key) => !keys.has(key))

  // Both directions at once: nothing on the list is still there, and nothing else has gone
  // missing with it. A Rect's own two are the other reason a key is absent from an Image.
  expect([...missing].sort()).toEqual([...UNPAINTED_ON_AN_IMAGE, 'cornerRadius', 'cornerSegments'].sort())

  assert(keys.has('shadowBlur') && keys.has('shadowColor'), 'the shadow settings stay, since an Image casts one')
  assert(keys.has('texture') && keys.has('tint'), 'along with what only an Image has')
  assert(keys.has('opacity') && keys.has('x'), 'and everything a Node carries')
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

/**
 * A class with an attribute in attrKeys() and no entry in attrDefaults() cannot be reset, and a
 * default for a key that is not an attribute is dead weight nothing would ever read. Neither
 * shows up anywhere else, so the two manifests are checked against each other here.
 *
 * `texture` is the one exception in the list, and is exempted by name rather than by a rule: an
 * Image with no picture has nothing to draw and nothing to stand in for it.
 */
const WITHOUT_DEFAULTS = new Set(['texture'])

it('every attribute has a default, and every default is an attribute', () => {
  class Blob extends CustomShape {
    protected describe(ctx: ShapeContext): void {
      ctx.moveTo(0, 0)
      ctx.lineTo(1, 0)
      ctx.closePath()
      ctx.fill()
    }
  }
  const nodes: Node[] = [
    new Node(),
    new Container(),
    new Group(),
    new Layer(),
    new Rect(),
    new Circle(),
    new Polyline({ points: [] }),
    new Path(),
    new Blob(),
    new MSDFText(),
    new UniformVectorText(),
    new Transformer(),
    new Image({ texture: stubTexture(4, 4) }),
  ]
  for (const node of nodes) {
    const keys = node.attributeNames()
    const defaults = node.attributeDefaults()
    for (const key of keys) {
      if (WITHOUT_DEFAULTS.has(key)) continue
      assert(key in defaults, `${node.nodeName}.attrDefaults() covers '${key}'`)
    }
    for (const key of Object.keys(defaults)) {
      assert(keys.includes(key), `${node.nodeName}.attrDefaults() has no '${key}' that is not an attribute`)
    }
  }
})

it('attrs writes reach the node, and deleting restores the default', () => {
  const rect = new Rect({ x: 1, y: 2, width: 10, height: 4, fill: 'tomato' })

  // The write that a snapshot would have swallowed.
  rect.attrs.x = 500
  assert(rect.x === 500, 'assigning through attrs moves the node')
  assert(rect.attrs.x === 500, 'and reading it back sees the node, not a stored copy')

  // Enumeration still behaves like an object, which is the other half of what attrs is for.
  const keys = Object.keys(rect.attrs)
  assert(keys.includes('x') && keys.includes('fill'), 'the view enumerates its attributes')
  assert(!keys.includes('nodeName'), 'and nothing that is not one')
  assert('x' in rect.attrs && !('nope' in rect.attrs), '`in` answers from the same list')

  // A write through the view raises the change event, like any other.
  const heard: unknown[] = []
  rect.on('yChange', (e) => heard.push(e))
  rect.attrs.y = 42
  assert(rect.y === 42 && heard.length === 1, 'and announces itself exactly once')

  // Deleting is how to ask for the default back.
  delete rect.attrs.x
  assert(rect.x === 0, 'deleting an attribute restores its default')
  rect.strokeWidth = 9
  rect.resetAttr('strokeWidth')
  assert(rect.strokeWidth === 2, "resetAttr does the same by name, from the class's own defaults")

  // Assigning undefined is not the same act - dragDistance means something by it.
  rect.dragDistance = 3
  rect.attrs.dragDistance = undefined
  assert(rect.dragDistance === undefined, 'assigning undefined assigns undefined')

  let threw = false
  try {
    new Rect().resetAttr('nope')
  } catch {
    threw = true
  }
  assert(threw, 'and resetting something with no default says so rather than doing nothing')
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

/**
 * A uniform text node's attributes are the flat ones it is written in terms of - `text`,
 * `fontSize` - rather than the run list they are rebuilt into on every write. The list is
 * DERIVED: it is not settable (a re-shape overwrites what a caller put there), it is not
 * resettable (there is no run list a node goes back to), and a document carrying both would name
 * the content twice and read back differently depending on which was applied last.
 */
it('a uniform text node declares the attributes it actually has', () => {
  const text = new UniformVectorText({ text: 'before', fontSize: 20 })
  const keys = Object.keys(text.attrs)
  for (const key of ['text', 'fontSize', 'fontStyle', 'textDecoration', 'letterSpacing']) {
    assert(keys.includes(key), `a uniform text node reports '${key}'`)
  }
  assert(!keys.includes('runs'), 'and not the run list it derives from them')
  assert(keys.includes('align') && keys.includes('lineHeight'), 'while the block options it inherits stay')

  // The write lands, and reads back through the same name it was written under. Routing it to
  // setText() instead - a method that replaces the RUNS - left `text` stale, so the value never
  // arrived and the next re-shape overwrote what did.
  const heard: { oldVal: unknown; newVal: unknown }[] = []
  text.on('textChange', (e) => heard.push(e as unknown as { oldVal: unknown; newVal: unknown }))
  text.setAttr('text', 'after')
  assert(text.getAttr('text') === 'after' && text.text === 'after', 'setAttr and getAttr are the same attribute')
  assert(text.runs.length === 1 && text.runs[0].text === 'after', 'and the run it draws is rebuilt from it')
  assert(heard.length === 1 && heard[0].oldVal === 'before' && heard[0].newVal === 'after', 'the write announces itself')

  // Every one of them has a default to go back to, which is what resetAttr needs.
  text.fontSize = 30
  text.resetAttr('fontSize')
  assert(text.fontSize === 12, 'resetAttr restores the size a uniform text node starts at')
  text.resetAttr('text')
  assert(text.text === '', 'and the empty string')
  assert(JSON.stringify(text.attributeDefaults().fill) === '[0,0,0,1]', 'its fill goes back to black, unlike a Shape')
})

/**
 * The selection frame's paint. Baked into its parts at construction and settable nowhere, a
 * themed application could not restyle the frame when the theme changed - the handles kept the
 * inner fill of whichever theme the board opened in.
 */
it("a Transformer's colours are attributes, and reach the parts", () => {
  const frame = new Transformer()
  const keys = Object.keys(frame.attrs)
  for (const key of ['borderColor', 'anchorFill', 'anchorStroke']) {
    assert(keys.includes(key), `the frame reports '${key}'`)
  }

  const edge = frame.findOne('.__transformer-top')
  const inner = frame.findOne('.__transformer-top-left')
  const ring = frame.findOne('.__transformer-top-left-border')
  assert(edge !== null && inner !== null && ring !== null, 'the parts the three colours are drawn on')

  frame.borderColor = 'red'
  frame.anchorFill = [0, 1, 0, 1]
  frame.anchorStroke = '#0000ff'
  const fillOf = (node: Node) => JSON.stringify((node as unknown as { fill: unknown }).fill)
  assert(fillOf(edge!) === '[1,0,0,1]', 'the border bars take the border colour')
  assert(fillOf(inner!) === '[0,1,0,1]', 'the inner disc of a handle takes the anchor fill')
  assert(fillOf(ring!) === '[0,0,1,1]', 'and the outer disc, which is what the ring is')
  assert(JSON.stringify(frame.borderColor) === '[1,0,0,1]', 'each reads back as the parsed colour')

  frame.resetAttr('anchorFill')
  assert(fillOf(inner!) === JSON.stringify(frame.attributeDefaults().anchorFill), 'and goes back to the default it was built with')
})
