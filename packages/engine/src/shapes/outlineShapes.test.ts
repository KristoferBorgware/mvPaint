// Polyline and Path: what their point lists mean, what they measure, and how far along them a
// distance lands. Plus the one thing an Image's size does that is not a number - follow its
// texture. Run with:
//   npx vitest run packages/engine/src/shapes/outlineShapes.test.ts

import { expect, it } from 'vitest'
import type { ImageTexture } from '../image/ImageTexture'
import { SharedLifetime } from '../resources/SharedLifetime'
import { clone, toObject } from '../serialize/serialize'
import { Image } from './Image'
import { Path } from './Path'
import { Polyline } from './Polyline'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps

/** An Image needs a texture to be constructed; nothing here ever samples one. */
function stubTexture(width: number, height: number): ImageTexture {
  return { width, height, lifetime: new SharedLifetime(), destroy() {} }
}

const SQUARE = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
]

it('a point list reads the same written flat or as objects', () => {
  const objects = new Polyline({ points: [{ x: 0, y: 0 }, { x: 10, y: 4 }] })
  const flat = new Polyline({ points: [0, 0, 10, 4] })

  assert(flat.points.length === 2, 'a flat list becomes points')
  assert(flat.points[1].x === 10 && flat.points[1].y === 4, 'in the order it was written')
  assert(objects.getLength() === flat.getLength(), 'and describes the same line')

  // A trailing coordinate with nothing to pair with names no point.
  assert(new Polyline({ points: [0, 0, 10, 4, 7] }).points.length === 2, 'an odd tail is not half a point')
  assert(new Polyline().points.length === 0, 'and a Polyline with no points is legal')
})

it('a closed polyline has an interior; an open one does not', () => {
  const closed = new Polyline({ points: SQUARE, closed: true })
  const open = new Polyline({ points: SQUARE })

  assert(closed.hitTestLocal(5, 5), 'a click in the middle of a closed one hits it')
  assert(!open.hitTestLocal(5, 5), 'the same click through an open one hits nothing')
  assert(!closed.hitTestLocal(-1, 5), 'and outside is still outside')
})

it('tension curves through the points, bezier follows them', () => {
  const straight = new Polyline({ points: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }] })
  const curved = new Polyline({ points: straight.points, tension: 1 })

  assert(curved.outline().length > 3, 'a tensioned outline is the flattened curve, not the three corners')
  assert(
    curved.outline().some((p) => p.x === 10 && p.y === 10),
    'which still passes exactly through each point it was drawn through',
  )
  assert(curved.getLength() > straight.getLength(), 'and takes a longer way round than the straight list')

  // Read as control points, the same four describe one cubic: two ends and two handles.
  const curve = new Polyline({ points: [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }], bezier: true })
  const outline = curve.outline()
  assert(outline.length > 4, 'a bezier list is flattened too')
  assert(outline[0].x === 0 && outline[0].y === 0, 'starting on the first point')
  const end = outline[outline.length - 1]
  assert(end.x === 10 && end.y === 0, 'and ending on the last')
  assert(curve.height < 10, 'the handles are pulled toward, not passed through')
})

it('an outline shape measures itself, unless it was given a size', () => {
  const line = new Polyline({ points: SQUARE })
  assert(line.width === 10 && line.height === 10, 'width and height are the extent of the points')

  line.points = [{ x: 0, y: 0 }, { x: 40, y: 5 }]
  assert(line.width === 40 && line.height === 5, 'and follow them when they change')

  line.width = 100
  assert(line.width === 100, 'assigning one records a size of its own')
  line.points = [{ x: 0, y: 0 }, { x: 3, y: 3 }]
  assert(line.width === 100 && line.height === 3, 'which the points no longer move, while the other half still follows')

  const path = new Path({ d: 'M0 0 L10 0 L10 4 Z' })
  assert(path.width === 10 && path.height === 4, 'a Path measures its contours the same way')
})

it('a copy goes on measuring itself', () => {
  // The measured size is written into a snapshot like any other attribute, and arrives back as
  // an explicit one. A size that merely restates the measurement is not an override, which is
  // what keeps the copy tracking its points as the original did.
  const copy = clone(new Polyline({ points: SQUARE }))
  copy.points = [{ x: 0, y: 0 }, { x: 55, y: 1 }]
  assert(copy.width === 55, 'the copy still measures its own points')

  const pinned = clone(new Polyline({ points: SQUARE, width: 200 }))
  pinned.points = [{ x: 0, y: 0 }, { x: 55, y: 1 }]
  assert(pinned.width === 200, 'and one that was given a size keeps it')
})

it('a Path describes itself by whichever of data and contours it holds', () => {
  const path = new Path({ d: 'M0 0 L10 0 L10 10 Z' })
  assert(path.contours.length === 1, 'data is flattened into contours')

  path.d = 'M0 0 L20 0 L20 5 Z'
  assert(path.width === 20, 'and re-flattened when it is assigned again')

  const written = toObject(path).attrs
  assert(written.d === 'M0 0 L20 0 L20 5 Z', 'a path built from data is written as that data')
  assert(!('contours' in written), 'and not as the points it became')

  const rebuilt = clone(path)
  assert(rebuilt.d === path.d && rebuilt.width === 20, 'which is enough to rebuild it')

  // The other way round: contours given directly have no data string to write.
  const direct = new Path({ contours: [{ points: SQUARE, closed: true }] })
  const directAttrs = toObject(direct).attrs
  assert('contours' in directAttrs && !('d' in directAttrs), 'contours are written as contours')
  assert(clone(direct).width === 10, 'and rebuild the same outline')

  // Assigning contours drops the data, since the string no longer describes these points.
  path.contours = [{ points: SQUARE, closed: true }]
  assert(path.d === undefined, 'writing contours over data leaves no stale string behind')
})

it('a distance along an outline lands where the ruler says', () => {
  const line = new Polyline({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] })
  assert(line.getLength() === 20, 'an open outline is the sum of its segments')

  const at = line.getPointAtLength(15)
  assert(at !== null && at.x === 10 && at.y === 5, 'and a distance along it lands mid-segment')
  assert(line.getPointAtLength(0)?.x === 0, 'zero is the start')

  const past = line.getPointAtLength(1000)
  assert(past?.x === 10 && past.y === 10, 'past the end clamps to the end rather than extrapolating')
  assert(new Polyline().getPointAtLength(1) === null, 'and an empty outline has no point to give')

  line.closed = true
  assert(near(line.getLength(), 20 + Math.hypot(10, 10)), 'closing it adds the segment back to the start')

  const square = new Path({ d: 'M0 0 L10 0 L10 10 L0 10 Z' })
  assert(square.getLength() === 40, 'a closed subpath counts its closing segment')
})

it('an image follows its texture unless it was given a size', () => {
  const image = new Image({ texture: stubTexture(64, 64) })
  assert(image.width === 64 && image.height === 64, "a size not given is the texture's own")

  image.texture = stubTexture(128, 32)
  assert(image.width === 128 && image.height === 32, 'and follows a different picture into it')

  const sized = new Image({ texture: stubTexture(64, 64), width: 10 })
  sized.texture = stubTexture(128, 32)
  assert(sized.width === 10, 'a width that was written stays written')
  assert(sized.height === 32, 'while the half that was not still follows')

  const copy = clone(image)
  copy.texture = stubTexture(7, 9)
  assert(copy.width === 7 && copy.height === 9, 'and a copy follows its texture as the original did')
})
