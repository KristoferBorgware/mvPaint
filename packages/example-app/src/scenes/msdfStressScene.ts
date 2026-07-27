// MSDF text stress test: four pages of richly, randomly styled lorem ipsum in a 2x2 grid,
// each paragraph its own Text node - the atlas half of the pair with vectorTextStressScene,
// which renders the identical words in the identical styles as tessellated glyph outlines
// instead.
//
// Every glyph here is four vertices sampling a shared distance-field atlas, regardless of how
// many words are on the page - which is exactly what this scene is meant to make obvious next
// to its outline-text counterpart: the same content costs the mesh lane orders of magnitude
// more triangles than it costs this lane quads.

import { Text, type Scene } from '@mvpaint/engine'
import { addPageFrame, loremStressLayout, BODY_MAX_WIDTH, PAGE_COUNT, PAGE_WIDTH, PARAGRAPH_LINE_HEIGHT, WORDS_PER_PAGE } from './loremStress'
import { DARK, SLATE } from './palette'
import type { SceneContent } from './types'

export function buildMsdfStressScene(scene: Scene): SceneContent {
  const root = scene.root
  const layout = loremStressLayout()

  root.addChild(
    new Text({
      name: 'msdf-stress-title',
      x: -PAGE_WIDTH,
      y: layout.gridTop + 70,
      text: `MSDF text: ${PAGE_COUNT} pages, ${PAGE_COUNT * WORDS_PER_PAGE} words, one atlas`,
      style: { fontStyle: 'bold', fontSize: 32, color: DARK },
    }),
  )
  root.addChild(
    new Text({
      name: 'msdf-stress-note',
      x: -PAGE_WIDTH,
      y: layout.gridTop + 34,
      text: 'Every glyph is four vertices into one shared atlas, however many words are on the page.',
      style: { fontSize: 17, color: SLATE },
    }),
  )

  layout.pages.forEach((page, i) => {
    const body = addPageFrame(root, i, layout)
    page.paragraphs.forEach((paragraph, pi) => {
      root.addChild(
        new Text({
          name: `msdf-stress-page-${i}-para-${pi}`,
          x: body.x,
          y: body.y + paragraph.y,
          runs: paragraph.runs,
          maxWidth: BODY_MAX_WIDTH,
          lineHeight: PARAGRAPH_LINE_HEIGHT,
          align: 'left',
        }),
      )
    })
  })

  return {}
}
