// Dashed strokes, and the two other things a stroke can be asked lately.
//
// A dash is not a different kind of stroke. The outline is cut into pieces BEFORE the ribbon is
// built, and each piece is run through the same stroker as any open path - so joins, caps, the
// miter limit, the alignment and the gauge all behave in a dash exactly as they do in a solid
// line, because there is no second code path for them to disagree with.
//
// Four consequences are worth seeing rather than reading, and each has a section below:
//
//   - the pattern is measured along the OUTLINE, not per edge, so a dash keeps its length round
//     a corner and a dash that spans one is a single piece with a real join in it;
//   - each piece is an open path, so each is capped - which is the whole of how a dotted line
//     is made;
//   - `strokeAlign` still works, even though a dash has no enclosed side of its own to answer
//     from (the sides are resolved once from the whole ring and carried into every piece);
//   - and it is real geometry, so a dash under a fixed-width stroke is measured after the
//     transform along with the width.
//
// The bottom right is not about dashes at all. `hitStrokeWidth` is the other half of drawing a
// thin line: one unit wide is a correct picture and an almost unhittable target, so the pointer
// is offered a wider ribbon than the eye is - a width in the shape's own units, so the two keep
// their ratio wherever the shape is scaled to.

import { Circle, Group, Polyline, Rect, MSDFText, type Scene, type StrokeAlign } from '@mvpaint/engine'
import { CRIMSON, DARK, NAVY, SLATE, TEAL } from './palette'
import type { SceneContent } from './types'

function label(x: number, y: number, text: string): MSDFText {
  return new MSDFText({ x, y, text, style: { fontSize: 15, color: SLATE } })
}

function caption(x: number, y: number, text: string): MSDFText {
  return new MSDFText({ x, y, text, style: { fontSize: 13, color: SLATE } })
}

function heading(x: number, y: number, text: string): MSDFText {
  return new MSDFText({ x, y, text, style: { fontSize: 17, fontStyle: 'bold', color: DARK } })
}

/** The patterns worth knowing, each with the one thing it demonstrates. */
const PATTERNS: readonly { dash: number[]; cap: 'butt' | 'round'; text: string }[] = [
  { dash: [14, 9], cap: 'butt', text: 'dash: [14, 9]' },
  { dash: [9], cap: 'butt', text: 'dash: [9]   an odd list is doubled' },
  { dash: [1, 14], cap: 'round', text: "dash: [1, 14] + lineCap 'round'   dots" },
  { dash: [26, 8, 3, 8], cap: 'butt', text: 'dash: [26, 8, 3, 8]   dash-dot' },
]

export function buildDashScene(scene: Scene): SceneContent {
  const root = scene.root

  root.addChild(
    new MSDFText({ x: -520, y: -340, text: 'Dashed strokes', style: { fontStyle: 'bold', fontSize: 40, color: DARK } }),
  )
  root.addChild(label(-520, -284, 'the outline is cut into pieces before the ribbon is built, so a dash is an ordinary stroke that stops and starts'))

  // --- the vocabulary ---------------------------------------------------------------------
  //
  // Each line is the same 320-long path under a different pattern. The dotted one is the case
  // worth pausing on: a 1-long dash under a round cap is a disc, so a dotted line is not a
  // separate feature - it is a dash short enough that its two caps meet.
  PATTERNS.forEach((pattern, i) => {
    const y = -236 + i * 34
    root.addChild(caption(-520, y - 4, pattern.text))
    root.addChild(
      new Polyline({
        name: `pattern-${i}`,
        points: [
          { x: -190, y },
          { x: 40, y },
        ],
        stroke: NAVY,
        strokeWidth: 7,
        lineCap: pattern.cap,
        dash: pattern.dash,
      }),
    )
  })
  root.addChild(label(-520, -76, 'one path, four patterns - each piece is an open path, so each is capped'))

  // --- measured along the outline, not per edge --------------------------------------------
  //
  // The pattern is walked by arc length, so it crosses a corner rather than restarting at it.
  // A piece that spans the corner comes back with the corner's own vertex still in it, which
  // is what leaves the stroker a real join to build there rather than two butt ends meeting.
  const zig = new Polyline({
    name: 'dashed-corners',
    points: [
      { x: -500, y: 30 },
      { x: -400, y: -30 },
      { x: -300, y: 30 },
      { x: -200, y: -30 },
      { x: -100, y: 30 },
    ],
    stroke: TEAL,
    strokeWidth: 10,
    lineJoin: 'round',
    lineCap: 'round',
    dash: [34, 14],
  })
  root.addChild(zig)
  root.addChild(caption(-520, 70, 'measured around the bend: a dash that spans a corner is one piece, with a join in it'))

  // --- a dash under a stroke that does not follow the scale ---------------------------------
  //
  // The pattern is geometry like the width, so it goes through the gauge with it: the ribbon is
  // built where the transform puts it and mapped back, which measures the dash lengths there
  // too. So the pattern holds its size on screen while the shape breathes. It re-tessellates
  // every frame, which is what a fixed-width stroke costs and what an animated dash costs -
  // here, both at once.
  const breathing = root.addChild(new Group({ name: 'dash-breathing', x: -330, y: 220 }))
  breathing.addChild(
    new Circle({
      radius: 62,
      fill: '#f2d9e0',
      stroke: CRIMSON,
      strokeWidth: 4,
      dash: [12, 8],
      strokeScaleEnabled: false,
    }),
  )
  root.addChild(heading(-520, 130, 'a dash goes through the gauge with the width'))
  root.addChild(caption(-520, 158, 'strokeScaleEnabled: false - the pattern holds its size on screen while the circle breathes'))
  root.addChild(caption(-520, 316, 're-tessellated every frame, which is what this one costs'))

  // --- strokeAlign survives being cut up -----------------------------------------------------
  //
  // "Inside" is answered from a RING's winding, and a dash is an open path with no enclosed
  // side - so left to itself every piece would silently centre. The sides are resolved once
  // from the whole contour and carried into each piece instead. The hairline over each box is
  // the outline all three are dashing, so it is easy to see the ribbon sitting inside it,
  // straddling it, or entirely beyond it.
  const ALIGNMENTS: readonly StrokeAlign[] = ['inside', 'center', 'outside']
  root.addChild(heading(60, -244, 'strokeAlign, on a dashed ring'))
  ALIGNMENTS.forEach((align, i) => {
    const x = 60 + i * 165
    const y = -210
    const box = root.addChild(
      new Rect({
        name: `dash-align-${align}`,
        x,
        y,
        width: 120,
        height: 74,
        fill: '#dfe9f5',
        stroke: NAVY,
        strokeWidth: 14,
        strokeAlign: align,
        dash: [18, 10],
      }),
    )
    root.addChild(
      new Rect({
        name: `dash-align-${align}-guide`,
        x,
        y,
        width: 120,
        height: 74,
        fill: [0, 0, 0, 0],
        stroke: CRIMSON,
        strokeWidth: 1,
        strokeScaleEnabled: false,
        zIndex: box.zIndex + 1,
      }),
    )
    root.addChild(caption(x, y + 100, align))
  })
  root.addChild(caption(60, -80, 'every piece lands on the side the whole ring asked for, not on its own centre'))

  // --- marching ants, and the switch ---------------------------------------------------------
  //
  // Animating dashOffset is what a selection frame does, and it is the one dash property worth
  // calling expensive: a dash is geometry, so a moving pattern is a re-tessellation per frame.
  // Beside it, the same rectangle with dashEnabled off - the pattern is kept, not lost.
  root.addChild(heading(60, -30, 'dashOffset, and the switch'))
  const ants = root.addChild(
    new Rect({
      name: 'marching-ants',
      x: 60,
      y: 6,
      width: 180,
      height: 96,
      fill: '#e8f2f2',
      stroke: TEAL,
      strokeWidth: 3,
      dash: [10, 7],
      cornerRadius: 6,
    }),
  )
  root.addChild(caption(60, 128, 'dashOffset animated'))

  root.addChild(
    new Rect({
      name: 'dash-off',
      x: 290,
      y: 6,
      width: 180,
      height: 96,
      fill: '#e8f2f2',
      stroke: TEAL,
      strokeWidth: 3,
      dash: [10, 7],
      dashEnabled: false,
      cornerRadius: 6,
    }),
  )
  root.addChild(caption(290, 128, 'the same dash, dashEnabled: false'))

  // --- hitStrokeWidth ------------------------------------------------------------------------
  //
  // Not a dash at all, and the other half of drawing a thin line. Both of these are one unit
  // wide and identical on screen; the right one carries a hit ribbon twenty units across, which
  // nothing measures and nothing draws. Every scene's content is draggable in this app, so the
  // difference is what it takes to grab each.
  root.addChild(heading(60, 176, 'hitStrokeWidth'))
  root.addChild(caption(60, 204, 'every hairline below is 1 unit wide - try to drag each one'))
  ;[false, true].forEach((wide, i) => {
    const x = 130 + i * 150
    root.addChild(
      new Polyline({
        name: wide ? 'hairline-easy' : 'hairline-hard',
        points: [
          { x, y: 230 },
          { x, y: 310 },
        ],
        stroke: wide ? CRIMSON : NAVY,
        strokeWidth: 1,
        hitStrokeWidth: wide ? 24 : 'auto',
      }),
    )
    root.addChild(caption(x - 46, 336, wide ? 'hitStrokeWidth: 24' : "hitStrokeWidth: 'auto'"))
  })

  // The third one is the same line as the second, inside a group scaled by six. Both halves are
  // scaled by the group - it is drawn six units wide and grabs anything within seventy-two - so
  // the pair keeps the ratio it was given, which is what a caller setting the two together is
  // after.
  const scaled = root.addChild(new Group({ name: 'hit-scaled', x: 470, y: 230, scaleX: 6, scaleY: 6 }))
  scaled.addChild(
    new Polyline({
      name: 'hairline-scaled',
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 13.33 },
      ],
      stroke: CRIMSON,
      strokeWidth: 1,
      hitStrokeWidth: 24,
    }),
  )
  root.addChild(caption(424, 336, 'the same, in a group x6'))

  let t = 0
  return {
    onFrame: (dt, speed) => {
      t += dt * speed
      // Negative, so the pattern travels the way the outline is wound - ants marching forward
      // rather than backward.
      ants.dashOffset = -t * 26
      const scale = 1 + Math.sin(t * 1.1) * 0.45
      breathing.scaleX = scale
      breathing.scaleY = scale
    },
  }
}
