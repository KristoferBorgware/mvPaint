// The example-scene registry. The picker lists whatever is in here, in this order, and the
// canvas loads by id - so adding a demo is one new file plus one entry below.

import { buildShadowScene } from './shadowScene'
import { buildShapesScene } from './shapesScene'
import { buildStressScene } from './stressScene'
import { buildSvgScene } from './svgScene'
import { buildTextScene } from './textScene'
import { buildZIndexScene } from './zIndexScene'
import type { ExampleScene } from './types'

export type { ExampleScene, SceneContent } from './types'

export const EXAMPLE_SCENES: ExampleScene[] = [
  {
    id: 'shapes',
    title: 'Shapes & gradients',
    description:
      'Rects, a circle and an open polyline: linear and radial gradient fills in local space, stroke joins and caps, and two shapes spinning about their own centres.',
    build: buildShapesScene,
  },
  {
    id: 'text',
    title: 'MSDF text',
    description:
      'Four Inter styles, mixed sizes, per-letter outlines, decorations, gradient and highlighted runs, wrapping and justification, RTL and vertical flow.',
    build: buildTextScene,
  },
  {
    id: 'shadows',
    title: 'Shadows',
    description:
      'Canvas-style blur, offset and spread, fill-only shadows, and overlapping cards showing shadows stack against other shapes rather than flattening into one layer.',
    build: buildShadowScene,
  },
  {
    id: 'svg',
    title: 'SVG document',
    description:
      'A whole SVG parsed into Path nodes: a gradient-filled ring with a hole, a radial-filled stroked circle, and a stroked open curve.',
    build: buildSvgScene,
  },
  {
    id: 'zindex',
    title: 'Stacking order',
    description:
      'Mesh shapes and text share one depth buffer, so zIndex can put a shape in front of text instead of the text lane always winning.',
    build: buildZIndexScene,
  },
  {
    id: 'stress',
    title: 'Shadow stress test',
    description:
      'Over a thousand independently shadowed, drifting shapes - every shadow cached in the shared atlas and drawn in a single call. Zoom out to see the whole field.',
    build: buildStressScene,
  },
]

export const DEFAULT_SCENE_ID = EXAMPLE_SCENES[0].id
