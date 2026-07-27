// The example-scene registry. The picker lists whatever is in here, in this order, and the
// canvas loads by id - so adding a demo is one new file plus one entry below.

import { buildMsdfStressScene } from './msdfStressScene'
import { buildShadowScene } from './shadowScene'
import { buildShapesScene } from './shapesScene'
import { buildShapeStressScene } from './shapeStressScene'
import { buildStressScene } from './stressScene'
import { buildSvgScene } from './svgScene'
import { buildTextScene } from './textScene'
import { buildVectorTextScene, prepareVectorTextScene } from './vectorTextScene'
import { buildVectorTextStressScene, prepareVectorTextStressScene } from './vectorTextStressScene'
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
    id: 'vector-text',
    title: 'Outline text',
    description:
      'The same runs and shaping drawn as tessellated glyph outlines through the mesh lane instead of an MSDF atlas - with real blurred shadows and per-glyph picking. Fetches the TTFs on first open.',
    prepare: prepareVectorTextScene,
    build: buildVectorTextScene,
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
    id: 'shape-stress',
    title: 'Shape stress test',
    description:
      '5000 rects, circles, polygons, stars and lines scattered randomly - size, rotation, stroke, colour and opacity all vary, but deliberately no shadows. Viewport culling is off, so every shape draws regardless of zoom/pan. Reload scene for a fresh layout.',
    disableCulling: true,
    build: buildShapeStressScene,
  },
  {
    id: 'stress',
    title: 'Shadow stress test',
    description:
      'Over a thousand independently shadowed, drifting shapes - every shadow cached in the shared atlas and drawn in a single call. Zoom out to see the whole field.',
    build: buildStressScene,
  },
  {
    id: 'msdf-text-stress',
    title: 'MSDF text stress test',
    description:
      'Four pages of randomly styled lorem ipsum, one MSDF Text node per page. Same words and styling as the outline-text stress test, for a direct cost comparison. Zoom out to see all four pages.',
    build: buildMsdfStressScene,
  },
  {
    id: 'vector-text-stress',
    title: 'Outline text stress test',
    description:
      'The identical four pages as the MSDF stress test, rendered as tessellated glyph outlines instead - tens of thousands of real triangles per page rather than four vertices per glyph. Fetches the TTFs on first open.',
    prepare: prepareVectorTextStressScene,
    build: buildVectorTextStressScene,
  },
]

export const DEFAULT_SCENE_ID = EXAMPLE_SCENES[0].id
