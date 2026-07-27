// Outline text stress test: the same four pages of lorem ipsum as msdfStressScene, same
// words, same random styling, same per-paragraph split (see loremStress.ts), rendered as
// tessellated glyph outlines through the mesh lane instead of sampled from an MSDF atlas.
//
// This is the scene that makes the cost of the vector path concrete: a page of body copy here
// is tens of thousands of real triangles rather than four vertices per glyph, so loading it is
// a genuine CPU tessellation stress test (first build only - nothing here re-tessellates while
// idle) as well as a GPU one. Compare against msdfStressScene's near-zero cost for the exact
// same content.
//
// Captions and the page chrome stay plain MSDF Text throughout, same as in vectorTextScene -
// they're UI, not the content being stress-tested, so there's no reason to pay tessellation
// cost for them.

import { Text, VectorText, type Scene, type VectorFontBook, loadDefaultVectorFonts } from '@mvpaint/engine'
import { addPageFrame, loremStressLayout, BODY_MAX_WIDTH, PAGE_COUNT, PAGE_WIDTH, PARAGRAPH_LINE_HEIGHT, WORDS_PER_PAGE } from './loremStress'
import { DARK, SLATE } from './palette'
import type { SceneContent } from './types'

// Held here rather than passed through the scene contract, same reasoning as vectorTextScene:
// parsed outlines own no GPU resources, so there's nothing for the renderer to hand out.
let fonts: VectorFontBook | null = null

/** Fetch and parse the TTFs. Called by the canvas before build(), and memoized downstream. */
export async function prepareVectorTextStressScene(): Promise<void> {
  fonts = await loadDefaultVectorFonts()
}

export function buildVectorTextStressScene(scene: Scene): SceneContent {
  if (!fonts) throw new Error('Vector fonts are not loaded yet')
  const book = fonts
  const root = scene.root
  const layout = loremStressLayout()

  root.addChild(
    new Text({
      name: 'vector-stress-title',
      x: -PAGE_WIDTH,
      y: layout.gridTop + 70,
      text: `Outline text: ${PAGE_COUNT} pages, ${PAGE_COUNT * WORDS_PER_PAGE} words, no atlas`,
      style: { fontStyle: 'bold', fontSize: 32, color: DARK },
    }),
  )
  root.addChild(
    new Text({
      name: 'vector-stress-note',
      x: -PAGE_WIDTH,
      y: layout.gridTop + 34,
      text: 'Every glyph is a real triangulated outline - tessellated once, cached, and never re-blurred.',
      style: { fontSize: 17, color: SLATE },
    }),
  )

  layout.pages.forEach((page, i) => {
    const body = addPageFrame(root, i, layout)
    page.paragraphs.forEach((paragraph, pi) => {
      root.addChild(
        new VectorText({
          fonts: book,
          name: `vector-stress-page-${i}-para-${pi}`,
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
