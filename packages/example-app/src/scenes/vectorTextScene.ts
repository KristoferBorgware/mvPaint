// The other way to draw text: VectorText tessellates each glyph's real outline and sends it
// through the mesh lane, where MSDFText samples a distance-field atlas in a lane of its own.
// The engine keeps both; this scene is here to make the difference visible side by side.
//
// The left column is styling the two implementations share - they run the same shaper, so
// runs, sizes, gradients, outlines, decorations and wrapping look the same on either. So do
// the block-layout features along the bottom and right: every alignment mode, per-run
// baseline shift, and vertical flow. The middle column is what only this path can do: a real
// blurred shadow cast from the letterforms (MSDFText has no silhouette to blur, so it duplicates
// its glyphs instead), and glyph-accurate picking, since the letters ARE the geometry the hit
// test walks.
//
// The outlines come from this application's own polygon atlases (public/fonts/polygons/, generated
// by packages/scripts and copied in), fetched the first time this scene opens rather than at
// startup - about 200kB, and the reason the engine needs no font parser at all. They are the
// application's asset, not the engine's, which ships an MSDF fallback and no outlines at all. A
// font the atlases do not cover is the other scene: Runtime TTF.

import { MSDFText, VectorText, type Scene } from '@mvpaint/engine'
import { INTER, loadVectorFonts } from '../fonts'
import { CRIMSON, DARK, HIGHLIGHT, NAVY, SLATE, TEAL } from './palette'
import type { SceneContent } from './types'

const LEFT = -470
const RIGHT = 60
// The vertical block hangs down the right edge; its columns advance leftward from here.
const VERTICAL = 520

// Held here rather than passed through the scene contract: parsed outlines own no GPU
// resources, so nothing about them has to be handed out by the renderer.
let ready = false

/** Fetch the glyph atlases. Called by the canvas before build(), and memoized downstream. */
export async function prepareVectorTextScene(): Promise<void> {
  await loadVectorFonts()
  ready = true
}

export function buildVectorTextScene(scene: Scene): SceneContent {
  if (!ready) throw new Error('Vector fonts are not loaded yet')
  const root = scene.root

  const label = (x: number, y: number, text: string, maxWidth?: number) =>
    new MSDFText({ name: `label-${text.slice(0, 12)}`, x, y, text, maxWidth, lineHeight: 1.25, style: { fontSize: 16, color: SLATE } })

  // --- title: a gradient run, filled by the mesh lane's own gradient rather than a second
  // implementation of one inside a text shader.
  root.addChild(
    new VectorText({
      fontFamily: INTER,
      name: 'vt-title',
      x: LEFT,
      y: -350,
      text: 'Outline text',
      style: {
        fontStyle: 'bold',
        fontSize: 56,
        gradient: {
          type: 'linear',
          start: { x: 0, y: 0 },
          end: { x: 380, y: 0 },
          stops: [
            { offset: 0, color: '#e63352' },
            { offset: 1, color: '#6138db' },
          ],
        },
      },
    }),
  )

  // Wrapped inside the left column: run on one line this reaches x 180, which is past where
  // the right column starts and straight through the top of the shadowed word there.
  root.addChild(label(LEFT, -290, 'Every glyph below is real geometry, triangulated from an outline - not a sampled field.', 500))

  // --- the four styles, one node, one run each.
  root.addChild(
    new VectorText({
      fontFamily: INTER,
      name: 'vt-styles',
      x: LEFT,
      y: -250,
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
      fontFamily: INTER,
      name: 'vt-runs',
      x: LEFT,
      y: -190,
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
      fontFamily: INTER,
      name: 'vt-outline',
      x: LEFT,
      y: -130,
      runs: [
        { text: 'Stroked', style: { fontStyle: 'bold', fontSize: 44, color: '#fff', strokeColor: NAVY, strokeWidth: 2.5 } },
        { text: ' glyphs', style: { fontStyle: 'bold', fontSize: 44, color: NAVY } },
      ],
    }),
  )

  // --- wrapping, justification and a hanging indent, exactly as the MSDF path does them:
  // the shaper is the same code, only its output is consumed differently.
  root.addChild(
    new VectorText({
      fontFamily: INTER,
      name: 'vt-paragraph',
      x: LEFT,
      y: -60,
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
  root.addChild(label(LEFT, 110, 'The same line, drawn each way:'))
  root.addChild(
    new VectorText({
      fontFamily: INTER,
      name: 'vt-compare-vector',
      x: LEFT,
      y: 140,
      text: 'Hamburgefonstiv 38px',
      style: { fontSize: 38, color: NAVY },
    }),
  )
  root.addChild(label(LEFT + 430, 152, 'outlines'))
  root.addChild(
    new MSDFText({
      name: 'vt-compare-msdf',
      x: LEFT,
      y: 200,
      text: 'Hamburgefonstiv 38px',
      style: { fontSize: 38, color: NAVY },
    }),
  )
  root.addChild(label(LEFT + 430, 212, 'MSDF atlas'))

  // --- right column: what geometry buys ---------------------------------------------

  // A real canvas-style blurred shadow, from Shape's own shadow properties - the letterforms
  // are baked into the shared shadow atlas like any other silhouette. MSDFText can't do this: it
  // has no rasterized shape to blur, so its shadow is an offset duplicate of the glyphs.
  root.addChild(
    new VectorText({
      fontFamily: INTER,
      name: 'vt-shadow',
      x: RIGHT,
      y: -330,
      text: 'Blurred',
      style: { fontStyle: 'bold', fontSize: 64, color: '#fff' },
      shadowColor: NAVY,
      shadowBlur: 18,
      shadowOffsetX: 6,
      shadowOffsetY: 8,
      shadowOpacity: 0.75,
    }),
  )
  root.addChild(
    new VectorText({
      fontFamily: INTER,
      name: 'vt-shadow-spread',
      x: RIGHT,
      y: -250,
      text: 'shadows',
      style: { fontStyle: 'bold', fontSize: 64, color: CRIMSON },
      shadowColor: '#e63352',
      shadowBlur: 26,
      shadowSpread: 3,
      shadowOpacity: 0.55,
    }),
  )
  root.addChild(label(RIGHT, -190, 'shadowBlur and spread, cast from the letterforms.'))

  // Faux bold and a glow, both of which are dilations of the outline here - a ring stroked
  // around the glyph's own contours rather than a distance-field threshold shift.
  root.addChild(
    new VectorText({
      fontFamily: INTER,
      name: 'vt-glow',
      x: RIGHT,
      y: -150,
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
      fontFamily: INTER,
      name: 'vt-pick',
      x: RIGHT,
      y: -40,
      text: 'CLICK O',
      style: { fontStyle: 'bold', fontSize: 88, color: NAVY },
    }),
  )
  root.addChild(label(RIGHT, 45, "Picking is per-glyph: the O's counter is a hole, not a hit."))

  // Turning and growing under the animation - geometry, so it stays exact at any size.
  const spun = new VectorText({
    fontFamily: INTER,
    name: 'vt-spun',
    x: RIGHT + 190,
    y: 140,
    offsetX: 95,
    offsetY: 0,
    text: 'zoom in',
    style: { fontStyle: 'bold-italic', fontSize: 46, color: '#6138db' },
  })
  root.addChild(spun)
  root.addChild(label(RIGHT, 208, 'Scroll to zoom: outlines have no resolution to run out of.'))

  // Baseline shift, per run: the shaper moves the pen origin, and the outline follows it, so
  // a superscript is a real raised glyph rather than a smaller one nudged by eye.
  root.addChild(
    new VectorText({
      fontFamily: INTER,
      name: 'vt-baseline',
      x: RIGHT,
      y: 240,
      runs: [
        { text: 'E = mc', style: { fontSize: 34, color: NAVY } },
        { text: '2', style: { fontSize: 20, color: CRIMSON, baselineShift: 15 } },
        { text: '   H', style: { fontSize: 34, color: NAVY } },
        { text: '2', style: { fontSize: 20, color: CRIMSON, baselineShift: -6 } },
        { text: 'O', style: { fontSize: 34, color: NAVY } },
        { text: '   x', style: { fontSize: 34, color: NAVY } },
        { text: '-1', style: { fontSize: 20, color: TEAL, baselineShift: 15 } },
      ],
    }),
  )
  root.addChild(label(RIGHT, 285, 'baselineShift, in world px: + raises a run, - lowers it.'))

  // --- vertical flow: glyphs stack downward, columns advance right-to-left ------------
  // A pragmatic subset, the same one the MSDF path implements: no wrapping, justification or
  // decorations in this orientation, but faux styles, shadows and glows all still apply.
  root.addChild(label(VERTICAL - 150, -372, 'orientation: vertical'))
  root.addChild(
    new VectorText({
      fontFamily: INTER,
      name: 'vt-vertical',
      x: VERTICAL,
      y: -340,
      text: 'VERTICAL\nFLOW',
      orientation: 'vertical',
      lineHeight: 1.05,
      style: { fontStyle: 'bold', fontSize: 30, color: NAVY },
    }),
  )

  // --- alignment: one wrapped block per mode, side by side -----------------------------
  root.addChild(label(LEFT, 320, 'align, over a 220px wrap width:'))
  const ALIGNMENTS = [
    { align: 'left', color: NAVY },
    { align: 'center', color: TEAL },
    { align: 'right', color: CRIMSON },
    { align: 'justify', color: SLATE },
  ] as const
  ALIGNMENTS.forEach(({ align, color }, i) => {
    const x = LEFT + i * 255
    root.addChild(label(x, 350, align))
    root.addChild(
      new VectorText({
        fontFamily: INTER,
        name: `vt-align-${align}`,
        x,
        y: 375,
        maxWidth: 220,
        align,
        lineHeight: 1.2,
        text: 'The shaper decides alignment; the outlines follow it.',
        style: { fontSize: 17, color },
      }),
    )
  })

  let angle = 0
  return {
    onFrame: (dt, speed) => {
      angle += dt * speed * 0.4
      spun.rotation = Math.sin(angle) * 14
    },
  }
}
