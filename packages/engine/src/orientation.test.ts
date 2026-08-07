// Self-test for the scene's ORIENTATION convention: which way is up, and what every part of
// the engine does about it. Run with:
//   npx vitest run packages/engine/src/orientation.test.ts
//
// The convention is one fact, but it is applied independently in a dozen places - each shape
// writes its own geometry, the camera builds its own view, the shaper stacks its own lines.
// Nothing checks that they agree, and nothing can: the agreement is only visible on a screen,
// and this suite has no GPU. So the facts are pinned here instead, one assertion each.
//
// TWO KINDS OF CHECK LIVE HERE, and the difference is the point of the file.
//
// The first kind PINS THE CONVENTION. A Rect hangs below its origin; a text block's second
// line sits below its first; the camera's rectangle extends down from its top-left corner.
// Each reads a sign, and turning the scene's vertical axis over turns every one of them.
// They are a listed set of facts, so changing the convention is an edit to a list rather than
// a rendering nobody can see until it is wrong.
//
// The second kind PROVES A MIRROR INVARIANT. Stroke alignment and hole classification decide
// which side of a contour is inside from the ring's winding, and a vertical mirror reverses
// winding - which looks like it should invert the answer. It does not: the mirror also
// reverses the normal the decision is taken against, and the two reversals cancel. These
// checks hold whichever way up the scene is, and they are the ones that catch a flip applied
// to some geometry and not the rest.

import { expect, it } from 'vitest'
import type { Vector2Like } from './math/Vector2'
import { Camera2D } from './camera/Camera2D'
import { Circle } from './shapes/Circle'
import { CustomShape } from './shapes/CustomShape'
import { Image } from './shapes/Image'
import type { ImageTexture } from './image/ImageTexture'
import { Rect } from './shapes/Rect'
import type { Shape } from './shapes/Shape'
import type { ShapeContext } from './shapes/ShapeContext'
import { anchorPosition, rotateAnchorPosition, type OrientedBox } from './shapes/transformerMath'
import type { MeshSink } from './render/meshFormat'
import { strokeContours, strokePolyline, type StrokeAlign } from './render/stroke'
import { layoutText, type FontProvider, type TextRun } from './text/layout'
import { normalizeMetrics, type FontMetrics, type MsdfFontJson } from './text/msdfMetrics'
import { atlasLayerSize, type StyleJson } from './text/msdfProvider'
import regularJson from '../../example-app/public/fonts/msdf/inter-regular.json'

/**
 * Every check in this file goes through here, so each one reads as the sentence it is making
 * and vitest reports that sentence when it stops being true.
 */
function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

function capturingSink(): { sink: MeshSink; verts: Vector2Like[] } {
  const verts: Vector2Like[] = []
  const sink: MeshSink = {
    vertex: (x, y) => {
      verts.push({ x, y })
      return verts.length - 1
    },
    triangle: () => {},
  }
  return { sink, verts }
}

/** The local-space box a shape's own geometry occupies. */
function span(shape: Shape): { minX: number; maxX: number; minY: number; maxY: number } {
  const { sink, verts } = capturingSink()
  shape.tessellate(sink)
  return {
    minX: Math.min(...verts.map((v) => v.x)),
    maxX: Math.max(...verts.map((v) => v.x)),
    minY: Math.min(...verts.map((v) => v.y)),
    maxY: Math.max(...verts.map((v) => v.y)),
  }
}

/** A shape whose geometry is whatever the caller draws into the context. */
function drawn(describe: (ctx: ShapeContext) => void): Shape {
  return new (class extends CustomShape {
    protected describe(ctx: ShapeContext): void {
      describe(ctx)
    }
  })()
}

const mirrored = (points: readonly Vector2Like[]): Vector2Like[] => points.map((p) => ({ x: p.x, y: -p.y }))

/**
 * True if two vertex lists describe the same points, in any order.
 *
 * Order is deliberately not compared. A stroke ribbon emits its two sides in the order the
 * edge normal points, and mirroring reverses that normal - so the mirrored ribbon hands back
 * each pair the other way round while covering exactly the same ground. The ground is the
 * claim; which of the two sides was written first is not.
 */
function samepoints(a: readonly Vector2Like[], b: readonly Vector2Like[]): boolean {
  if (a.length !== b.length) return false
  const order = (p: Vector2Like, q: Vector2Like) => p.x - q.x || p.y - q.y
  const sortedA = [...a].sort(order)
  const sortedB = [...b].sort(order)
  return sortedA.every((p, i) => near(p.x, sortedB[i].x) && near(p.y, sortedB[i].y))
}

// ---------------------------------------------------------------------------------------
// The convention. Every assertion below reads a vertical sign; all of them turn together.
// ---------------------------------------------------------------------------------------

it('a Rect hangs below its origin, spanning x in [0, width] and y in [0, height]', () => {
  const box = span(new Rect({ width: 100, height: 60 }))
  assert(near(box.minX, 0) && near(box.maxX, 100), 'the rectangle extends right from its origin')
  assert(near(box.minY, 0) && near(box.maxY, 60), 'and downward from it')
})

it('rounding the corners does not move the box the rectangle occupies', () => {
  const box = span(new Rect({ width: 100, height: 60, cornerRadius: 12 }))
  assert(near(box.minX, 0) && near(box.maxX, 100), 'a rounded rectangle keeps its horizontal span')
  assert(near(box.minY, 0) && near(box.maxY, 60), 'and its vertical one')
})

it("an Image's quad hangs exactly where a Rect of the same size does", () => {
  // Only the size is read here; the texture's GPU half never comes into tessellation.
  const texture = { width: 200, height: 100 } as ImageTexture
  const image = span(new Image({ texture, width: 100, height: 60 }))
  const rect = span(new Rect({ width: 100, height: 60 }))
  assert(near(image.minY, rect.minY) && near(image.maxY, rect.maxY), 'the drawn pixels and the hit test agree vertically')
  assert(near(image.minX, rect.minX) && near(image.maxX, rect.maxX), 'and horizontally')
})

it("ShapeContext.rect() lands on the same corner a Rect node does", () => {
  const node = span(new Rect({ width: 100, height: 60 }))
  const ctx = span(
    drawn((c) => {
      c.rect(0, 0, 100, 60)
      c.fill()
    }),
  )
  assert(near(ctx.minY, node.minY) && near(ctx.maxY, node.maxY), 'the two agree about which way the rectangle hangs')
  assert(near(ctx.minX, node.minX) && near(ctx.maxX, node.maxX), 'and about where it starts')
})

it('a Circle is centred on its origin, so it is the one shape a vertical flip leaves alone', () => {
  const box = span(new Circle({ radius: 40 }))
  assert(near(box.minY, -box.maxY), 'the rim is symmetric about the origin')
  assert(near(box.minX, -box.maxX), 'on both axes')
})

it("the camera's rectangle extends down from the world point at its top-left corner", () => {
  const bounds = new Camera2D({ x: 0, y: 0, zoom: 1 }).viewBounds(100, 50)
  assert(near(bounds.min.x, 0) && near(bounds.max.x, 100), 'the view extends right from camera.x')
  assert(near(bounds.min.y, 0) && near(bounds.max.y, 50), 'and downward from camera.y')
})

it("the transformer's 'top' anchors sit on the -y side of its box", () => {
  const box: OrientedBox = { cx: 0, cy: 0, halfW: 50, halfH: 30, rotation: 0 }
  assert(anchorPosition(box, 'top-center').y < 0, "'top-center' is above the middle")
  assert(anchorPosition(box, 'bottom-center').y > 0, "'bottom-center' is below it")
  assert(rotateAnchorPosition(box, 10).y < anchorPosition(box, 'top-center').y, 'and the rotate handle sits beyond the top edge')
})

it("a text block's second line sits below its first", () => {
  const shaped = layoutText([run('one\ntwo')], {}, fonts)
  const baselines = [...new Set(shaped.quads.filter((q) => q.isGlyph).map((q) => q.originY))].sort((a, b) => a - b)
  assert(baselines.length === 2, 'two lines produce two baselines')
  assert(baselines[1] > baselines[0], 'and the later one is further down, at a LARGER y')
})

// ---------------------------------------------------------------------------------------
// The mirror invariants. Nothing below reads a sign; all of it holds either way up.
// ---------------------------------------------------------------------------------------

const SQUARE: Vector2Like[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
]

it('stroke alignment is a fact about the shape, not about which way up it is drawn', () => {
  for (const align of ['inside', 'outside', 'center'] as StrokeAlign[]) {
    const upright = capturingSink()
    strokePolyline(SQUARE, upright.sink, { width: 20, closed: true, join: 'miter', align })
    const flipped = capturingSink()
    strokePolyline(mirrored(SQUARE), flipped.sink, { width: 20, closed: true, join: 'miter', align })

    assert(
      samepoints(upright.verts, mirrored(flipped.verts)),
      `${align}: the mirrored stroke covers exactly the mirror of the upright one`,
    )
  }
})

it('which ring is a hole survives a vertical mirror', () => {
  // Wound opposite ways, as an outline and the hole inside it are.
  const hole: Vector2Like[] = [
    { x: 40, y: 40 },
    { x: 40, y: 60 },
    { x: 60, y: 60 },
    { x: 60, y: 40 },
  ]
  const strokeDonut = (outer: Vector2Like[], inner: Vector2Like[]) => {
    const { sink, verts } = capturingSink()
    strokeContours(
      [
        { points: outer, closed: true },
        { points: inner, closed: true },
      ],
      sink,
      { width: 10, join: 'miter', align: 'inside' },
    )
    return verts
  }

  const upright = strokeDonut(SQUARE, hole)
  const flipped = strokeDonut(mirrored(SQUARE), mirrored(hole))
  assert(
    samepoints(upright, mirrored(flipped)),
    'the mirrored donut strokes exactly the mirror of the upright one - the hole is still the hole',
  )
})

// --- the font the text check is measured against ----------------------------------------
// The same real metrics text.test.ts uses, reduced to the one style this file needs.

const STYLE_JSON = regularJson as unknown as MsdfFontJson
const STYLES: StyleJson[] = [{ style: 'regular', json: STYLE_JSON }]
const METRICS: FontMetrics = normalizeMetrics(STYLE_JSON, atlasLayerSize(STYLES))
const fonts: FontProvider = {
  resolve: () => ({ metrics: METRICS, atlasIndex: 0, fauxBold: false, fauxItalic: false }),
}
const run = (text: string, style: TextRun['style'] = {}): TextRun => ({ text, style })
