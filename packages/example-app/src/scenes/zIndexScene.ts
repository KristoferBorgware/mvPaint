// Stacking order: what decides which of two overlapping objects is in front, and how to
// override it.
//
// Two things are on show, and the second is only interesting because of the first:
//
//   1. BY DEFAULT it is the order they were made in. Every shape takes the next number from
//      a running counter as its zIndex (see the engine's shapes/zOrder.ts), so a shape made
//      later is in front of one made earlier, with nothing to set. That holds across lanes as
//      much as within one - a mesh shape and a Text resolve through the same depth buffer, so
//      the text lane does not win merely by drawing second.
//   2. AN EXPLICIT zIndex OVERRIDES IT. The lower pair is made in the same order as the upper
//      one and then the circle is lifted over the text, so the two pairs differ in exactly one
//      assignment.

import { Circle, Text, type Scene } from '@mvpaint/engine'
import { DARK } from './palette'
import type { SceneContent } from './types'

export function buildZIndexScene(scene: Scene): SceneContent {
  const root = scene.root

  // Circle first, text second, neither saying anything about stacking - so the text is in
  // front, because it was made second.
  root.addChild(
    new Circle({
      name: 'circle-made-first',
      x: 470 + 40,
      y: 60 - 8,
      radius: 34,
      fill: [0.9, 0.3, 0.5, 0.7],
    }),
  )
  root.addChild(
    new Text({
      name: 'text-made-second',
      x: 470,
      y: 60,
      text: 'Text on top (made second)',
      style: { fontStyle: 'bold', fontSize: 26, color: DARK },
    }),
  )

  // The same two in the same order - and then the circle is lifted over the text. One above
  // the text's own number is all it takes, and saying it RELATIVE to the text keeps the pair
  // together no matter how many shapes the rest of the scene has made; a literal would have
  // to know the whole scene's numbering to mean anything.
  const circle = root.addChild(
    new Circle({
      name: 'circle-lifted',
      x: 470 + 40,
      y: -20 - 8,
      radius: 34,
      fill: [0.2, 0.55, 0.9, 0.85],
    }),
  )
  const text = root.addChild(
    new Text({
      name: 'text-overridden',
      x: 470,
      y: -20,
      text: 'Shape on top (zIndex)',
      style: { fontStyle: 'bold', fontSize: 26, color: DARK },
    }),
  )
  circle.zIndex = text.zIndex + 1

  return {}
}
