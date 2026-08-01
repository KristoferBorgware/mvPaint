// Object opacity: one number that fades a whole object, kept out of its colours.
//
// The distinction the scene exists to make. A colour's alpha is part of how a shape is
// PAINTED and belongs to its design; `shape.opacity` is a property of the object - what an
// editor's opacity slider drives and what an animation fades. Baking one into the other means
// a fade has to know, and afterwards restore, every colour it touched.
//
// Four panels: the ramp, how it combines with a colour that is already translucent, that
// every lane and the shadow obey it, and that it is cheap enough to animate.
//
// Everything sits over a set of bars, because transparency you cannot see through is just a
// paler colour - the bars are what make the difference visible.

import { Circle, Container, Rect, Text, type RGBA, type Scene } from '@mvpaint/engine'
import { CRIMSON, DARK, NAVY, SLATE, TEAL } from './palette'
import type { SceneContent } from './types'

const PANEL_H = 204
const ROW = [227, -23] // each row's heading baseline (Text hangs downwards from its y)
const COL = [-520, 40] // each column's left edge
const BODY = -41 // top of the band of shapes, relative to the row
const BAND = 130
const FOOT = -(PANEL_H - 13)

const heading = (col: number, row: number, text: string): Text =>
  new Text({ x: COL[col], y: ROW[row], text, style: { fontSize: 17, fontStyle: 'bold', color: DARK } })

const caption = (x: number, row: number, text: string): Text =>
  new Text({ x, y: ROW[row] + FOOT, text, style: { fontSize: 13, color: SLATE } })

/**
 * The backdrop a panel's shapes are laid over. Diagonal bars rather than a flat colour: a
 * shape at half opacity over white is indistinguishable from a paler shape, and the whole
 * claim of the scene is that you are seeing THROUGH the thing rather than at a lighter
 * version of it.
 */
function bars(root: Container, col: number, row: number, width: number): void {
  const top = ROW[row] + BODY
  for (let i = 0; i * 34 < width + BAND; i++) {
    root.addChild(
      new Rect({
        name: `bar-${col}-${row}-${i}`,
        x: COL[col] + i * 34 - BAND,
        y: top,
        width: 17,
        height: BAND,
        fill: [0.87, 0.89, 0.92, 1],
        rotation: -0.5,
      }),
    )
  }
}

export function buildOpacityScene(scene: Scene): SceneContent {
  const root = scene.root
  const swatch = (x: number, row: number, fill: RGBA, opacity: number, w = 78): Rect =>
    new Rect({ x, y: ROW[row] + BODY, width: w, height: BAND, fill, cornerRadius: 8, opacity })

  // --- a fade, not a colour ---------------------------------------------------------------
  //
  // The same fill five times, differing only in `opacity`. Nothing about the paint changes -
  // set every one of these back to 1 and they are indistinguishable.
  root.addChild(heading(0, 0, 'A fade, not a colour'))
  bars(root, 0, 0, 440)
  for (let i = 0; i < 5; i++) {
    root.addChild(swatch(COL[0] + i * 88, 0, NAVY, 1 - i * 0.2))
  }
  root.addChild(caption(COL[0], 0, 'one fill, opacity 1.0 down to 0.2'))

  // --- it multiplies the colour's own alpha ------------------------------------------------
  //
  // The two are not alternatives, they compose. The first two cells are the same shape reached
  // two ways and should be identical; the third has both at once and is the product.
  root.addChild(heading(1, 0, "It multiplies the colour's own alpha"))
  bars(root, 1, 0, 440)
  root.addChild(swatch(COL[1], 0, [CRIMSON[0], CRIMSON[1], CRIMSON[2], 1], 0.5, 120))
  root.addChild(swatch(COL[1] + 150, 0, [CRIMSON[0], CRIMSON[1], CRIMSON[2], 0.5], 1, 120))
  root.addChild(swatch(COL[1] + 300, 0, [CRIMSON[0], CRIMSON[1], CRIMSON[2], 0.5], 0.5, 120))
  root.addChild(caption(COL[1], 0, 'opacity 0.5'))
  root.addChild(caption(COL[1] + 150, 0, 'alpha 0.5'))
  root.addChild(caption(COL[1] + 300, 0, 'both - so 0.25'))

  // --- every lane obeys it, and so does the shadow ------------------------------------------
  //
  // A mesh shape, a Text and a shadowed shape all at the same opacity. They are drawn by three
  // different pipelines and the shadow by a fourth, so this is the only panel that proves the
  // property is the object's rather than any one lane's. The shadow fading WITH its caster is
  // the part worth watching: a half-transparent shape casting a solid shadow reads as two
  // objects rather than one.
  root.addChild(heading(0, 1, 'Every lane obeys it'))
  bars(root, 0, 1, 440)
  root.addChild(new Circle({ name: 'lane-mesh', x: COL[0] + 55, y: ROW[1] + BODY - BAND / 2, radius: 52, fill: TEAL, opacity: 0.45 }))
  root.addChild(
    new Text({
      name: 'lane-text',
      x: COL[0] + 130,
      y: ROW[1] + BODY - 34,
      text: 'Text',
      style: { fontSize: 62, fontStyle: 'bold', color: NAVY },
      opacity: 0.45,
    }),
  )
  root.addChild(
    new Rect({
      name: 'lane-shadowed',
      x: COL[0] + 300,
      y: ROW[1] + BODY - 12,
      width: 100,
      height: 100,
      fill: CRIMSON,
      cornerRadius: 10,
      opacity: 0.45,
      shadowColor: [0, 0, 0, 0.9],
      shadowBlur: 20,
      shadowOffsetX: 14,
      shadowOffsetY: 14,
    }),
  )
  root.addChild(caption(COL[0], 1, 'mesh, text and a shadow - all at 0.45, and the shadow fades too'))

  // --- and it is cheap enough to animate ----------------------------------------------------
  //
  // Which is the whole reason for keeping it out of the colours: this writes one float per
  // frame and touches no geometry, no colour and no tessellation.
  root.addChild(heading(1, 1, 'Cheap enough to animate'))
  bars(root, 1, 1, 440)
  const pulsing = [0, 1, 2, 3].map((i) =>
    root.addChild(swatch(COL[1] + i * 110, 1, i % 2 === 0 ? NAVY : TEAL, 1, 92)),
  )
  root.addChild(caption(COL[1], 1, 'one float per frame - no geometry, no colours touched'))

  let t = 0
  return {
    onFrame: (dt, speed) => {
      t += dt * speed
      // Offset per swatch, so the row reads as a wave rather than four things blinking.
      for (let i = 0; i < pulsing.length; i++) {
        pulsing[i].opacity = 0.55 + 0.45 * Math.sin(t * 1.6 - i * 0.7)
      }
    },
  }
}
