// A whole SVG document run through the path pipeline: its shapes (a gradient-filled ring
// with a hole, a radial-filled stroked circle, a stroked open curve) become Path nodes
// under one container, so the loader and the earcut/stroke geometry are exercised together.

import { loadSvgDocument, type Scene } from '@mvpaint/engine'
import { EXAMPLE_SVG } from '../svg/exampleSvg'
import type { SceneContent } from './types'

export function buildSvgScene(scene: Scene): SceneContent {
  // `fit` maps the document's own viewBox onto a 320-unit square and lands on the returned
  // group's transform, so the placement below is a write rather than a second parse. SVG is
  // y-down and so is the scene, so nothing is flipped.
  const svgDoc = loadSvgDocument(EXAMPLE_SVG, { fit: { width: 320, height: 320 } })
  svgDoc.root.x -= 160
  svgDoc.root.y -= 160
  scene.root.addChild(svgDoc.root)
  return {}
}
