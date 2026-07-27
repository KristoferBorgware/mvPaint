// zIndex: mesh shapes and Text resolve their stacking order through the same depth buffer,
// so a shape can sit in FRONT of text rather than the text lane always winning by virtue of
// drawing second.

import { Circle, Text, type Scene } from '@mvpaint/engine'
import { DARK } from './palette'
import type { SceneContent } from './types'

export function buildZIndexScene(scene: Scene): SceneContent {
  const root = scene.root

  // Default zIndex (0) on both: a tie falls back to scene order, so the later-added node
  // (the text) wins - same look as before zIndex existed, but for a different reason.
  root.addChild(
    new Circle({
      name: 'circle-zindex-tie',
      x: 470 + 40,
      y: 60 - 8,
      radius: 34,
      fill: [0.9, 0.3, 0.5, 0.7],
    }),
  )
  root.addChild(
    new Text({
      name: 'text-zindex-tie',
      x: 470,
      y: 60,
      text: 'Text on top (tie)',
      style: { fontStyle: 'bold', fontSize: 26, color: DARK },
    }),
  )

  // A higher zIndex on the circle now correctly brings it in front of the text.
  root.addChild(
    new Text({
      name: 'text-zindex-behind',
      x: 470,
      y: -20,
      text: 'Shape on top (zIndex)',
      style: { fontStyle: 'bold', fontSize: 26, color: DARK },
      zIndex: 0,
    }),
  )
  root.addChild(
    new Circle({
      name: 'circle-zindex-front',
      x: 470 + 40,
      y: -20 - 8,
      radius: 34,
      fill: [0.2, 0.55, 0.9, 0.85],
      zIndex: 1,
    }),
  )

  return {}
}
