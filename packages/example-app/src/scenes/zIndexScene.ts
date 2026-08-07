// Stacking order: what decides which of two overlapping objects is in front, and every way
// there is to say otherwise.
//
// The rule is one sentence - a shape made later is in front of one made earlier, because each
// takes the next number from a running counter as its zIndex (see the engine's
// shapes/zOrder.ts) - and the six panels here are that rule and the four idioms for
// overriding it:
//
//   made later is in front      the default, with nothing set anywhere
//   the lane does not decide    a mesh shape and an MSDFText obey the same rule as two shapes
//   one assignment overrides    front.zIndex = back.zIndex + 1
//   bring one to the front      shape.zIndex = nextZIndex(), live
//   send one behind everything  a negative value, which the counter can never reach
//   slot one between two        (a.zIndex + b.zIndex) / 2 - the numbers are not integers

import { Circle, Rect, MSDFText, nextZIndex, type ColorInput, type Scene } from '@mvpaint/engine'
import { CRIMSON, DARK, NAVY, SLATE, TEAL, YELLOW, withAlpha } from './palette'
import type { SceneContent } from './types'

// Two rows of three, centred on the origin: the panels reach the same distance above and
// below y = 0 and the same distance left and right of x = 0, so the scene needs no camera
// framing of its own.
//
// A panel is 204 tall, measured down from its heading: 17 of heading, a 24 gap, a 130 band of
// shapes, a 20 gap, then 13 of caption. The two rows are placed so the pair straddles y = 0.
const PANEL_H = 204
const ROW = [-227, 23] // each row's heading baseline (top edge - MSDFText hangs downwards)
const COL = [-520, -150, 250] // each column's left edge
const BODY = 41 // top of the band of shapes, relative to the row
const BAND = 130 // its height, so the band runs ROW+41 .. ROW+171
const FOOT = PANEL_H - 13 // caption baseline, clear of the band

const heading = (col: number, row: number, text: string): MSDFText =>
  new MSDFText({ x: COL[col], y: ROW[row], text, style: { fontSize: 17, fontStyle: 'bold', color: DARK } })

const caption = (x: number, row: number, text: string): MSDFText =>
  new MSDFText({ x, y: ROW[row] + FOOT, text, style: { fontSize: 13, color: SLATE } })

/** A card with a white keyline, so an overlap reads as one card over another. */
const card = (x: number, y: number, width: number, height: number, fill: ColorInput): Rect =>
  new Rect({ x, y, width, height, fill, stroke: '#fff', strokeWidth: 3, cornerRadius: 8 })

const STEPS: ColorInput[] = [
  '#218c99',
  '#e6802e',
  '#4066b8',
  '#cc476b',
  '#599e4c',
]

export function buildZIndexScene(scene: Scene): SceneContent {
  const root = scene.root

  // One text and one circle overlapping by about half the word, so whichever is behind still
  // shows enough of itself to be recognised. Both cells of every pair below use this exact
  // geometry, so the only thing that ever differs between two cells is the stacking.
  const word = (cx: number, row: number) =>
    new MSDFText({ x: cx - 52, y: ROW[row] + BODY + BAND / 2 - 18, text: 'ABC', style: { fontSize: 34, fontStyle: 'bold', color: NAVY } })
  const disc = (cx: number, row: number, fill: ColorInput) =>
    new Circle({ x: cx + 22, y: ROW[row] + BODY + BAND / 2, radius: 34, fill })

  // --- made later is in front -----------------------------------------------------------
  //
  // The default, and the only panel with nothing set on anything. Five cards made left to
  // right, each overlapping the one before, and each in front of it for no other reason.
  root.addChild(heading(0, 0, 'Made later is in front'))
  for (let i = 0; i < 5; i++) {
    root.addChild(card(COL[0] + i * 52, ROW[0] + BODY, 72, BAND, STEPS[i]))
  }
  root.addChild(caption(COL[0], 0, 'five cards, nothing set on any of them'))

  // --- the lane does not decide ---------------------------------------------------------
  //
  // A MSDFText draws through a different pipeline than a Circle, and would win every overlap if
  // stacking came from the order the lanes happen to be submitted in. It does not: both
  // resolve through one depth buffer, so the two cells differ only in which was made first.
  root.addChild(heading(1, 0, 'The lane does not decide'))

  root.addChild(disc(-78, 0, CRIMSON))
  root.addChild(word(-78, 0))

  root.addChild(word(78, 0))
  root.addChild(disc(78, 0, CRIMSON))

  root.addChild(caption(-146, 0, 'text made second'))
  root.addChild(caption(30, 0, 'shape made second'))

  // --- one assignment overrides it ------------------------------------------------------
  //
  // Both cells are built in the SAME order - circle, then text over it - and then the
  // right-hand circle is lifted, so the two differ by one line and nothing else. Said
  // relative to the text, because an explicit zIndex is absolute on the same scale as the
  // counter's: a literal would have to know how many shapes the rest of the scene has
  // already made to mean anything.
  root.addChild(heading(2, 0, 'One assignment overrides it'))

  root.addChild(disc(320, 0, TEAL))
  root.addChild(word(320, 0))

  const lifted = root.addChild(disc(460, 0, TEAL))
  const over = root.addChild(word(460, 0))
  lifted.zIndex = over.zIndex + 1

  root.addChild(caption(256, 0, 'made in order'))
  root.addChild(caption(400, 0, 'circle lifted'))

  // --- bring one to the front -----------------------------------------------------------
  //
  // The idiom behind an editor's "bring to front", on a timer so it can be watched: ask the
  // counter for a fresh number and the shape is in front of everything, wherever it was.
  root.addChild(heading(0, 1, 'Bring one to the front'))
  const risers = [0, 1, 2, 3].map((i) => root.addChild(card(COL[0] + i * 62, ROW[1] + BODY, 90, BAND, STEPS[i])))
  root.addChild(caption(COL[0], 1, 'shape.zIndex = nextZIndex(), one card at a time'))

  // --- send one behind everything -------------------------------------------------------
  //
  // The mirror image, and it needs no helper. The counter only ever counts up from zero, so
  // no shape can ever take a negative number - which makes any negative a place nothing else
  // can reach. The panel here is made LAST, after every circle, and is still behind them.
  root.addChild(heading(1, 1, 'Send one behind everything'))
  for (let i = 0; i < 3; i++) {
    root.addChild(new Circle({ name: `backdrop-dot-${i}`, x: -100 + i * 80, y: ROW[1] + BODY + BAND / 2, radius: 40, fill: NAVY }))
  }
  root.addChild(
    new Rect({
      name: 'backdrop',
      x: COL[1],
      y: ROW[1] + BODY,
      width: 300,
      height: BAND,
      fill: withAlpha(YELLOW, 0.85),
      cornerRadius: 10,
      zIndex: -1,
    }),
  )
  root.addChild(caption(COL[1], 1, 'made last, and still behind: zIndex: -1'))

  // --- slot one between two -------------------------------------------------------------
  //
  // Three cards take consecutive numbers, so there is no whole number left between the first
  // two - and none is needed. A zIndex is an ordinary number, not an integer, so the midpoint
  // of two of them is a real place in the stack. The yellow card covers the first card and is
  // covered by the second, which is the only evidence that matters.
  root.addChild(heading(2, 1, 'Slot one between two'))
  // The three take consecutive numbers, and are cut short top and bottom so the slotted card
  // can stand taller than them. Without that it would be a 25-wide strip between two cards -
  // correct, and almost impossible to see.
  const short = ROW[1] + BODY + 10
  const first = root.addChild(card(COL[2], short, 80, BAND - 20, STEPS[0]))
  const second = root.addChild(card(COL[2] + 60, short, 80, BAND - 20, STEPS[1]))
  root.addChild(card(COL[2] + 120, short, 80, BAND - 20, STEPS[2]))

  // Overlapping the first two and proud of both, so its edges are visible all the way along:
  // over the first card on the left, under the second on the right, which is the whole claim.
  const between = root.addChild(card(COL[2] + 30, ROW[1] + BODY, 80, BAND, YELLOW))
  between.zIndex = (first.zIndex + second.zIndex) / 2

  root.addChild(caption(COL[2], 1, '(a.zIndex + b.zIndex) / 2'))

  // One card at a time to the front - fast enough to see it happen, slow enough to read which
  // one moved.
  let t = 0
  let turn = 0
  return {
    onFrame: (dt, speed) => {
      t += dt * speed
      if (t < 1.1) return
      t = 0
      risers[turn].zIndex = nextZIndex()
      turn = (turn + 1) % risers.length
    },
  }
}
