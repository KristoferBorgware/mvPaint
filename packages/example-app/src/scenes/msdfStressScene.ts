// MSDF text stress test: four pages of richly, randomly styled lorem ipsum in a 2x2 grid,
// each page a single Text node - the atlas half of the pair with vectorTextStressScene, which
// renders the identical words in the identical styles as tessellated glyph outlines instead.
//
// Every glyph here is four vertices sampling a shared distance-field atlas, regardless of how
// many words are on the page - which is exactly what this scene is meant to make obvious next
// to its outline-text counterpart: the same content costs the mesh lane orders of magnitude
// more triangles than it costs this lane quads.

import { Text, type Scene } from '@mvpaint/engine'
import { addPageFrame, buildLoremPages, PAGE_COUNT, PAGE_WIDTH, PAGE_PADDING, GRID_BOUNDS, WORDS_PER_PAGE } from './loremStress'
import { DARK, SLATE } from './palette'
import type { SceneContent } from './types'

const BODY_MAX_WIDTH = PAGE_WIDTH - PAGE_PADDING * 2

export function buildMsdfStressScene(scene: Scene): SceneContent {
  const root = scene.root
  const pages = buildLoremPages()

  root.addChild(
    new Text({
      name: 'msdf-stress-title',
      x: -PAGE_WIDTH,
      y: GRID_BOUNDS.top + 70,
      text: `MSDF text: ${PAGE_COUNT} pages, ${PAGE_COUNT * WORDS_PER_PAGE} words, one atlas`,
      style: { fontStyle: 'bold', fontSize: 32, color: DARK },
    }),
  )
  root.addChild(
    new Text({
      name: 'msdf-stress-note',
      x: -PAGE_WIDTH,
      y: GRID_BOUNDS.top + 34,
      text: 'Every glyph is four vertices into one shared atlas, however many words are on the page.',
      style: { fontSize: 17, color: SLATE },
    }),
  )

  pages.forEach((page, i) => {
    const body = addPageFrame(root, i)
    root.addChild(
      new Text({
        name: `msdf-stress-page-${i}`,
        x: body.x,
        y: body.y,
        runs: page.runs,
        maxWidth: BODY_MAX_WIDTH,
        lineHeight: 1.25,
        align: 'left',
      }),
    )
  })

  return {}
}
