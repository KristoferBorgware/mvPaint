// Outline text stress test: the same four pages of lorem ipsum as msdfStressScene, same
// words, same random styling (see loremStress.ts), rendered as tessellated glyph outlines
// through the mesh lane instead of sampled from an MSDF atlas.
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
import { addPageFrame, buildLoremPages, PAGE_COUNT, PAGE_WIDTH, PAGE_PADDING, GRID_BOUNDS, WORDS_PER_PAGE } from './loremStress'
import { DARK, SLATE } from './palette'
import type { SceneContent } from './types'

const BODY_MAX_WIDTH = PAGE_WIDTH - PAGE_PADDING * 2

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
  const pages = buildLoremPages()

  root.addChild(
    new Text({
      name: 'vector-stress-title',
      x: -PAGE_WIDTH,
      y: GRID_BOUNDS.top + 70,
      text: `Outline text: ${PAGE_COUNT} pages, ${PAGE_COUNT * WORDS_PER_PAGE} words, no atlas`,
      style: { fontStyle: 'bold', fontSize: 32, color: DARK },
    }),
  )
  root.addChild(
    new Text({
      name: 'vector-stress-note',
      x: -PAGE_WIDTH,
      y: GRID_BOUNDS.top + 34,
      text: 'Every glyph is a real triangulated outline - tessellated once, cached, and never re-blurred.',
      style: { fontSize: 17, color: SLATE },
    }),
  )

  pages.forEach((page, i) => {
    const body = addPageFrame(root, i)
    root.addChild(
      new VectorText({
        fonts: book,
        name: `vector-stress-page-${i}`,
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
