// The other way to draw text: VectorText tessellates each glyph's real outline and sends it
// through the mesh lane, where MSDF Text samples a distance-field atlas in a lane of its own.
// The engine keeps both; this scene is here to make the difference visible side by side.
//
// The whole left column is styling the two implementations share - they run the same shaper,
// so runs, sizes, gradients, outlines, decorations, wrapping and justification look the same
// on either. The right column is what only this path can do: a real blurred shadow cast from
// the letterforms (Text has no silhouette to blur, so it duplicates its glyphs instead), and
// glyph-accurate picking, since the letters ARE the geometry the hit test walks.
//
// The four Inter TTFs are fetched the first time this scene opens - about 1.6MB, which is why
// they aren't loaded at startup like the atlases.

import { Text, VectorText, type Scene, type VectorFontBook, loadDefaultVectorFonts } from '@mvpaint/engine'
import { CRIMSON, DARK, HIGHLIGHT, NAVY, SLATE, TEAL } from './palette'
import type { SceneContent } from './types'

const LEFT = -470
const RIGHT = 60

// Held here rather than passed through the scene contract: parsed outlines own no GPU
// resources, so nothing about them has to be handed out by the renderer.
let fonts: VectorFontBook | null = null

/** Fetch and parse the TTFs. Called by the canvas before build(), and memoized downstream. */
export async function prepareVectorTextScene(): Promise<void> {
  fonts = await loadDefaultVectorFonts()
}

export function buildVectorTextScene(scene: Scene): SceneContent {
  if (!fonts) throw new Error('Vector fonts are not loaded yet')
  const book = fonts
  const root = scene.root

  const label = (x: number, y: number, text: string) =>
    new Text({ name: `label-${text.slice(0, 12)}`, x, y, text, style: { fontSize: 16, color: SLATE } })

  // --- title: a gradient run, filled by the mesh lane's own gradient rather than a second
  // implementation of one inside a text shader.
  root.addChild(
    new VectorText({
      fonts: book,
      name: 'vt-title',
      x: LEFT,
      y: 350,
      text: 'Outline text',
      style: {
        fontStyle: 'bold',
        fontSize: 56,
        gradient: {
          type: 'linear',
          start: { x: 0, y: 0 },
          end: { x: 380, y: 0 },
          stops: [
            { offset: 0, color: [0.9, 0.2, 0.32, 1] },
            { offset: 1, color: [0.38, 0.22, 0.86, 1] },
          ],
        },
      },
    }),
  )

  root.addChild(label(LEFT, 288, 'Every glyph below is triangulated from the TTF at runtime - no atlas.'))

  // --- the four styles, one node, one run each.
  root.addChild(
    new VectorText({
      fonts: book,
      name: 'vt-styles',
      x: LEFT,
      y: 250,
      runs: [
        { text: 'Regular ', style: { fontStyle: 'regular', fontSize: 32, color: NAVY } },
        { text: 'Bold ', style: { fontStyle: 'bold', fontSize: 32, color: NAVY } },
        { text: 'Italic ', style: { fontStyle: 'italic', fontSize: 32, color: NAVY } },
        { text: 'Bold+Italic', style: { fontStyle: 'bold-italic', fontSize: 32, color: NAVY } },
      ],
    }),
  )

  // --- per-run colour, size and decoration, all inside one node: each of these becomes its
  // own material record on a single mesh object (see Shape.materials()).
  root.addChild(
    new VectorText({
      fonts: book,
      name: 'vt-runs',
      x: LEFT,
      y: 190,
      runs: [
        { text: 'colour ', style: { fontSize: 30, color: CRIMSON } },
        { text: 'size ', style: { fontSize: 20, color: TEAL } },
        { text: 'underline ', style: { fontSize: 26, color: NAVY, underline: true } },
        { text: 'struck ', style: { fontSize: 26, color: SLATE, strikethrough: true } },
        { text: 'marked', style: { fontSize: 26, color: DARK, highlight: HIGHLIGHT } },
      ],
    }),
  )

  // --- per-letter outline: the shared contour stroker, run over the glyph's own rings.
  root.addChild(
    new VectorText({
      fonts: book,
      name: 'vt-outline',
      x: LEFT,
      y: 130,
      runs: [
        { text: 'Stroked', style: { fontStyle: 'bold', fontSize: 44, color: [1, 1, 1, 1], strokeColor: NAVY, strokeWidth: 2.5 } },
        { text: ' glyphs', style: { fontStyle: 'bold', fontSize: 44, color: NAVY } },
      ],
    }),
  )

  // --- wrapping, justification and a hanging indent, exactly as the MSDF path does them:
  // the shaper is the same code, only its output is consumed differently.
  root.addChild(
    new VectorText({
      fonts: book,
      name: 'vt-paragraph',
      x: LEFT,
      y: 60,
      maxWidth: 420,
      align: 'justify',
      lineHeight: 1.15,
      runs: [
        { text: 'Both text kinds share one shaper, ', style: { fontSize: 19, color: NAVY } },
        { text: 'so wrapping, kerning, alignment and justification are the same code either way. ', style: { fontSize: 19, color: SLATE } },
        { text: 'What changes is only what the shaped quads are turned into.', style: { fontSize: 19, color: NAVY } },
      ],
    }),
  )

  // --- the same string both ways, stacked, so the comparison is direct.
  root.addChild(label(LEFT, -110, 'The same line, drawn each way:'))
  root.addChild(
    new VectorText({
      fonts: book,
      name: 'vt-compare-vector',
      x: LEFT,
      y: -140,
      text: 'Hamburgefonstiv 38px',
      style: { fontSize: 38, color: NAVY },
    }),
  )
  root.addChild(label(LEFT + 400, -152, 'outlines'))
  root.addChild(
    new Text({
      name: 'vt-compare-msdf',
      x: LEFT,
      y: -200,
      text: 'Hamburgefonstiv 38px',
      style: { fontSize: 38, color: NAVY },
    }),
  )
  root.addChild(label(LEFT + 400, -212, 'MSDF atlas'))

  // --- right column: what geometry buys ---------------------------------------------

  // A real canvas-style blurred shadow, from Shape's own shadow properties - the letterforms
  // are baked into the shared shadow atlas like any other silhouette. Text can't do this: it
  // has no rasterized shape to blur, so its shadow is an offset duplicate of the glyphs.
  root.addChild(
    new VectorText({
      fonts: book,
      name: 'vt-shadow',
      x: RIGHT,
      y: 330,
      text: 'Blurred',
      style: { fontStyle: 'bold', fontSize: 64, color: [1, 1, 1, 1] },
      shadowColor: NAVY,
      shadowBlur: 18,
      shadowOffsetX: 6,
      shadowOffsetY: 8,
      shadowOpacity: 0.75,
    }),
  )
  root.addChild(
    new VectorText({
      fonts: book,
      name: 'vt-shadow-spread',
      x: RIGHT,
      y: 250,
      text: 'shadows',
      style: { fontStyle: 'bold', fontSize: 64, color: CRIMSON },
      shadowColor: [0.9, 0.2, 0.32, 1],
      shadowBlur: 26,
      shadowSpread: 3,
      shadowOpacity: 0.55,
    }),
  )
  root.addChild(label(RIGHT, 210, 'Shape.shadowBlur / spread, cast from the letterforms themselves.'))

  // Faux bold and a glow, both of which are dilations of the outline here - a ring stroked
  // around the glyph's own contours rather than a distance-field threshold shift.
  root.addChild(
    new VectorText({
      fonts: book,
      name: 'vt-glow',
      x: RIGHT,
      y: 150,
      runs: [
        { text: 'glow ', style: { fontSize: 40, color: DARK, glow: { color: HIGHLIGHT, radius: 5 } } },
        { text: 'faux bold', style: { fontSize: 40, color: TEAL, fauxBold: true } },
      ],
    }),
  )

  // Picking walks the actual triangles, so only the ink is clickable - try the middle of the
  // O, which is a hole in the outline and therefore not part of the shape at all.
  root.addChild(
    new VectorText({
      fonts: book,
      name: 'vt-pick',
      x: RIGHT,
      y: 40,
      text: 'CLICK O',
      style: { fontStyle: 'bold', fontSize: 88, color: NAVY },
    }),
  )
  root.addChild(label(RIGHT, -10, "Picking is per-glyph: the O's counter is a hole, not a hit."))

  // Turning and growing under the animation - geometry, so it stays exact at any size.
  const spun = new VectorText({
    fonts: book,
    name: 'vt-spun',
    x: RIGHT + 190,
    y: -160,
    offsetX: 95,
    offsetY: 0,
    text: 'zoom in',
    style: { fontStyle: 'bold-italic', fontSize: 46, color: [0.38, 0.22, 0.86, 1] },
  })
  root.addChild(spun)
  root.addChild(label(RIGHT, -230, 'Scroll to zoom: outlines have no resolution to run out of.'))

  let angle = 0
  return {
    onFrame: (dt, speed) => {
      angle += dt * speed * 0.4
      spun.rotation = Math.sin(angle) * 0.25
    },
  }
}
