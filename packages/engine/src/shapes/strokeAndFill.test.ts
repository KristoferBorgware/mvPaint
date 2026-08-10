// The switches over what a shape paints, and the one over what the pointer can hit.
//
// fillEnabled and strokeEnabled sit on opposite sides of the engine's central split - a fill is
// chosen per frame from a record, a stroke is baked into triangles - so the two look alike in
// the API and behave differently underneath. hitStrokeWidth is the one property that makes the
// drawn geometry and the hit geometry genuinely different, which is worth pinning down.

import { expect, it } from 'vitest'
import { AABB } from '../math/AABB'
import { meshGeometryEpoch, objectRecordEpoch } from './contentEpoch'
import { Group } from './Group'
import { MSDFText } from './MSDFText'
import { Polyline } from './Polyline'
import { Rect } from './Rect'
import { Scene } from '../scene/Scene'
import { pickNode } from '../scene/picking'
import { UniformMSDFText } from './UniformMSDFText'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}

/** AABB carries no equality of its own, and only the x/y extent matters for a 2D shape. */
const sameBox = (a: AABB, b: AABB) =>
  Math.abs(a.min.x - b.min.x) < 1e-6 &&
  Math.abs(a.min.y - b.min.y) < 1e-6 &&
  Math.abs(a.max.x - b.max.x) < 1e-6 &&
  Math.abs(a.max.y - b.max.y) < 1e-6

it('fillEnabled suppresses the fill without losing it, and costs no rebuild', () => {
  const rect = new Rect({ width: 10, height: 10, fill: 'tomato' })
  const triangles = rect.localBounds().clone()
  assert(rect.hasFill() && rect.fillPriority === 'color', 'a filled shape paints its colour')

  const geometry = meshGeometryEpoch()
  const record = objectRecordEpoch()
  rect.fillEnabled = false

  assert(!rect.hasFill() && rect.fillPriority === 'none', 'switched off, nothing is painted')
  assert(rect.fill !== null, 'and the colour is still there to switch back on')
  assert(objectRecordEpoch() > record, 'the record is rewritten, which is all it takes')
  assert(meshGeometryEpoch() === geometry, 'and no geometry is repacked - the triangles never changed')
  assert(sameBox(rect.localBounds(), triangles), 'so the shape measures exactly as it did')

  rect.fillEnabled = true
  assert(rect.fillPriority === 'color', 'and switching back restores the colour that was kept')
})

it('strokeEnabled re-tessellates, because a ribbon either exists or does not', () => {
  const rect = new Rect({ width: 10, height: 10, fill: 'tomato', stroke: 'black', strokeWidth: 4 })
  const outlined = rect.localBounds()
  assert(rect.hasStroke(), 'a stroked shape has a ribbon')
  // A centred 4-wide stroke puts 2 units outside the 10x10 fill on each side.
  assert(Math.abs(outlined.max.x - 12) < 1e-6, 'which the shape measures with')

  const geometry = meshGeometryEpoch()
  rect.strokeEnabled = false

  assert(!rect.hasStroke(), 'switched off, there is no ribbon')
  assert(rect.stroke !== null && rect.strokeWidth === 4, 'though the colour and width are kept')
  assert(meshGeometryEpoch() > geometry, 'the geometry is repacked, unlike a fill')
  assert(Math.abs(rect.localBounds().max.x - 10) < 1e-6, 'and the shape measures its fill alone')
})

it('hitStrokeWidth widens what can be clicked without widening what is drawn', () => {
  // A hairline: correct as a picture, unhittable as a target.
  const line = new Polyline({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], stroke: 'black', strokeWidth: 1 })

  assert(line.hitTestLocal(50, 0), 'the pointer can land on the line itself')
  assert(!line.hitTestLocal(50, 6), 'and six units away misses, which is the problem')

  const drawn = line.localBounds().clone()
  line.hitStrokeWidth = 24

  assert(line.hitTestLocal(50, 6), 'a wider hit ribbon catches the near miss')
  assert(line.hitTestLocal(50, 11), 'out to half the hit width')
  assert(!line.hitTestLocal(50, 20), 'and no further - it is a ribbon, not a free pass')

  // The whole point: the picture is untouched. localBounds() is the DRAWN extent, so a group's
  // measurement and a transformer's frame never see the hit ribbon.
  assert(sameBox(line.localBounds(), drawn), 'the drawn geometry measures exactly as before')
  assert(line.strokeWidth === 1, 'and still reports the width it is drawn at')

  line.hitStrokeWidth = 'auto'
  assert(!line.hitTestLocal(50, 6), "'auto' goes back to following the drawn width")
})

/**
 * The assertion above tests hitTestLocal, which is the INNER half. A pointer never arrives
 * there directly: it arrives at pickNode, which rejects against a bounding box first and only
 * then runs the exact test. Measured on the drawn box, that rejection clears every point the
 * hit ribbon was widened to catch - so hitStrokeWidth can pass every test above and still do
 * nothing whatsoever in an application. This is the test that says it works.
 */
it('a wide hit ribbon survives the bounding-box rejection, so a pick really finds it', () => {
  const scene = new Scene()
  const line = scene.root.addChild(
    new Polyline({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], stroke: 'black', strokeWidth: 1 }),
  )

  assert(pickNode(scene, 50, 0) === line, 'a pick lands on the line itself')
  assert(pickNode(scene, 50, 8) === null, 'and eight units off finds nothing, which is the problem')

  line.hitStrokeWidth = 24
  assert(pickNode(scene, 50, 8) === line, 'with a hit ribbon, the same pick finds the line')
  assert(pickNode(scene, 50, 11) === line, 'out to half the hit width')
  assert(pickNode(scene, 50, 20) === null, 'and no further')

  // What the hit ribbon must NOT reach: everything that measures the shape. The two boxes are
  // the two widths - the line is drawn 1 across and hit-tested 24 across.
  assert(Math.abs(line.localBounds().max.y - line.localBounds().min.y - 1) < 1e-6, 'the drawn box is still a hairline')
  assert(Math.abs(line.hitBounds().max.y - line.hitBounds().min.y - 24) < 1e-6, 'while the hit box is the wide one')

  line.hitStrokeWidth = 'auto'
  assert(pickNode(scene, 50, 8) === null, "and 'auto' gives the hairline back")
})

/**
 * hitStrokeWidth is a width in the shape's OWN units, put in place of the drawn one, so the hit
 * ribbon is ordinary geometry and scales with the node exactly as the line it belongs to does.
 * The two are set together and read as one thing - a 1-unit line with a 24-unit target - and a
 * ribbon that stayed put while the line grew would break that pairing at the first scale.
 */
it('the hit ribbon scales with the node, like the line it belongs to', () => {
  // How far off the line a pick still finds it, in WORLD units.
  const reachOf = (build: (scene: Scene) => Polyline): number => {
    const scene = new Scene()
    const line = build(scene)
    let reach = 0
    for (let d = 0; d <= 300; d += 0.25) if (pickNode(scene, 10, d) === line) reach = d
    return reach
  }
  const line = (strokeWidth: number) =>
    new Polyline({ points: [{ x: 0, y: 0 }, { x: 400, y: 0 }], stroke: 'black', strokeWidth, hitStrokeWidth: 24 })

  const reachAt = (strokeWidth: number, scale: number, inGroup = false) =>
    reachOf((scene) => {
      const parent = inGroup ? scene.root.addChild(new Group({ scaleX: scale, scaleY: scale })) : scene.root
      const node = parent.addChild(line(strokeWidth))
      if (!inGroup) {
        node.scaleX = scale
        node.scaleY = scale
      }
      return node
    })

  // A 24-wide hit stroke straddles the outline like any other, so it reaches 12 out - times the
  // scale, and whatever the drawn width happens to be. Within half a unit: the probe steps by a
  // quarter and the boundary lands between samples.
  for (const [strokeWidth, scale] of [[1, 0.25], [1, 1], [1, 6], [40, 1], [40, 3]] as [number, number][]) {
    const expected = 12 * scale
    const got = reachAt(strokeWidth, scale)
    assert(
      Math.abs(got - expected) <= 0.5,
      `strokeWidth ${strokeWidth} at scale ${scale}: reach should be ${expected}, got ${got}`,
    )
  }

  // The node's own scale is not the whole story: what counts is the WORLD one, so an ancestor
  // scaling the node scales its hit ribbon too.
  const grouped = reachAt(1, 3, true)
  assert(Math.abs(grouped - 36) <= 0.5, `inside a group scaled three times: expected 36, got ${grouped}`)
})

it('a pure scale needs no rebuild, because the hit ribbon is local geometry', () => {
  // The hit pass measures in the same units the drawn one does, so a transform is applied over
  // it rather than baked into it - nothing to go stale, exactly as for the drawn triangles.
  const scene = new Scene()
  const line = scene.root.addChild(
    new Polyline({ points: [{ x: 0, y: 0 }, { x: 400, y: 0 }], stroke: 'black', strokeWidth: 1, hitStrokeWidth: 24 }),
  )

  assert(pickNode(scene, 10, 11) === line, 'eleven units off is inside the ribbon')
  assert(pickNode(scene, 10, 14) === null, 'and fourteen is outside it')

  line.scaleX = 8
  line.scaleY = 8
  assert(pickNode(scene, 10, 90) === line, 'scaled eightfold, the ribbon reaches eight times as far')
  assert(pickNode(scene, 10, 100) === null, 'and stops where the scaled ribbon does')
})

it('a hit ribbon is rebuilt when the shape changes under it', () => {
  const line = new Polyline({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], stroke: 'black', strokeWidth: 1 })
  line.hitStrokeWidth = 24
  assert(line.hitTestLocal(50, 6), 'the wide ribbon catches a near miss')

  // The pick pass runs the shape's own buildGeometry(), so it follows the geometry it is
  // derived from - a moved point moves both ribbons.
  line.points = [{ x: 0, y: 100 }, { x: 100, y: 100 }]
  assert(!line.hitTestLocal(50, 6), 'and follows the points when they move')
  assert(line.hitTestLocal(50, 106), 'to wherever they moved to')
})

it('the base text classes say when a paint goes nowhere, and the uniform ones do not', () => {
  const said: string[] = []
  const original = console.warn
  console.warn = (message: unknown) => said.push(String(message))
  try {
    // A plain MSDFText holds independently styled runs, so it has no one fill and Shape's is
    // never read. Assigning one looks like it should work and does nothing, which is what the
    // warning is for.
    const styled = new MSDFText({ text: 'hello' })
    assert(said.length === 0, 'constructing one says nothing')

    styled.fill = 'tomato'
    assert(said.length === 1 && said[0].includes('UniformMSDFText'), 'and it names the class that would work')
    styled.stroke = 'black'
    assert(said.length === 1, 'said once per node, not once per assignment')

    // The uniform class projects the paint onto its single run, so it is silent.
    const uniform = new UniformMSDFText({ text: 'hello' })
    uniform.fill = 'tomato'
    uniform.stroke = 'black'
    assert(said.length === 1, 'a uniform node paints from the shape and says nothing')
    assert(uniform.runs[0].style?.color?.[0] === 1, 'because the fill really did reach the run')
  } finally {
    console.warn = original
  }
})
