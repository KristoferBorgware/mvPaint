// A whole SVG document run through the path pipeline: its shapes (a gradient-filled ring
// with a hole, a radial-filled stroked circle, a stroked open curve) become Path nodes
// under one container, so the loader and the earcut/stroke geometry are exercised together.

import { loadSvgDocument, type Scene } from '@mvpaint/engine'
import { EXAMPLE_SVG } from '../svg/exampleSvg'
import type { SceneContent } from './types'

export function buildSvgScene(scene: Scene): SceneContent {
  // The root matrix flips Y (SVG is y-down, the scene is y-up) and centres the 0..200
  // artwork in the view.
  const svgDoc = loadSvgDocument(EXAMPLE_SVG, { rootMatrix: [1.6, 0, 0, -1.6, -160, 160] })
  scene.root.addChild(svgDoc)
  return {}
}
