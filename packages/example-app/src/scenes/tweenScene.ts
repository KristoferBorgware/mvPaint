// Tweening: attributes carried from one value to another over time.
//
// A tween sits entirely above the render. It assigns `node.x`, and everything that follows -
// the epoch bump, the per-object record refresh, the draw - happens exactly as it would for an
// assignment made by hand. So the interesting claims are not about pixels but about VALUES, and
// each section below makes one:
//
//   - every curve, plotted from the same function the tween reads, with a runner tracing it -
//     and each runner is TWO tweens on one node, since x and y are following different curves;
//   - any attribute the node exposes, not a fixed list of animatable ones - rotation, scale,
//     opacity, colour, stroke width, corner radius, radius, dash offset;
//   - the values that are not numbers: a gradient's stops, and a points list growing from three
//     points to eight;
//   - and what happens at the ends: a yoyo turning around, `to()` chaining into the next leg
//     from its own onFinish, and a second tween taking one attribute off the first.
//
// THE SCENE OWNS ITS CLOCK. A tween normally drives itself off an animation frame and needs
// nothing set up, but a scene that is torn down and rebuilt wants its animation to stop when it
// does - and the app's speed control has to reach it, so that at speed 0 everything holds still
// and can be looked at. Both come from stepping a ticker of this scene's own from onFrame; the
// tweens go with the scene when it is dropped, because nothing else ever held them.

import {
  Circle,
  Easings,
  Polyline,
  Rect,
  MSDFText,
  Tween,
  TweenTicker,
  type EasingFunction,
  type Node,
  type Scene,
  type Vector2Like,
} from '@mvpaint/engine'
import { CRIMSON, DARK, NAVY, SLATE, TEAL, YELLOW } from './palette'
import type { SceneContent } from './types'

const heading = (x: number, y: number, text: string): MSDFText =>
  new MSDFText({ x, y, text, style: { fontSize: 17, fontStyle: 'bold', color: DARK } })

const caption = (x: number, y: number, text: string, size = 13): MSDFText =>
  new MSDFText({ x, y, text, style: { fontSize: size, color: SLATE } })

// --- the curve grid -------------------------------------------------------------------------

/** Every curve, in families: the plain ones, then the ones that leave 0..1 on the way. */
const CURVES: readonly { name: string; easing: EasingFunction }[] = [
  { name: 'Linear', easing: Easings.Linear },
  { name: 'EaseIn', easing: Easings.EaseIn },
  { name: 'EaseOut', easing: Easings.EaseOut },
  { name: 'EaseInOut', easing: Easings.EaseInOut },
  { name: 'StrongEaseIn', easing: Easings.StrongEaseIn },
  { name: 'StrongEaseOut', easing: Easings.StrongEaseOut },
  { name: 'StrongEaseInOut', easing: Easings.StrongEaseInOut },
  { name: 'BackEaseIn', easing: Easings.BackEaseIn },
  { name: 'BackEaseOut', easing: Easings.BackEaseOut },
  { name: 'BackEaseInOut', easing: Easings.BackEaseInOut },
  { name: 'ElasticEaseIn', easing: Easings.ElasticEaseIn },
  { name: 'ElasticEaseOut', easing: Easings.ElasticEaseOut },
  { name: 'ElasticEaseInOut', easing: Easings.ElasticEaseInOut },
  { name: 'BounceEaseIn', easing: Easings.BounceEaseIn },
  { name: 'BounceEaseOut', easing: Easings.BounceEaseOut },
  { name: 'BounceEaseInOut', easing: Easings.BounceEaseInOut },
]

const GRID_X = -520
const GRID_Y = -212
const CELL_W = 116
const CELL_H = 128
const PLOT_W = 86
const PLOT_H = 46
/** Where a cell's plot sits inside it: `p` of 0 on this line, 1 the plot height above. */
const PLOT_LEFT = 6
const PLOT_BASE = 82
/** How long one traverse of a curve takes, before the yoyo sends it back. */
const RUN = 1.6

/**
 * One curve: its own axes, the curve itself sampled from the easing, and a runner tracing it.
 *
 * The runner is TWO tweens on one node, and that is the point of drawing it this way. `x` runs
 * linearly, `y` runs through the curve, and neither knows about the other - a node is not
 * limited to one tween, only to one tween per attribute. Both are the same duration and start
 * together, so they turn around on the same frame for as long as the scene is up.
 */
function curveCell(
  index: number,
  name: string,
  easing: EasingFunction,
  ticker: TweenTicker,
): { nodes: Node[]; runner: Circle } {
  const x0 = GRID_X + (index % 4) * CELL_W
  const y0 = GRID_Y + Math.floor(index / 4) * CELL_H
  const left = x0 + PLOT_LEFT
  const base = y0 + PLOT_BASE
  const top = base - PLOT_H

  // The two lines the curve is read against: 0 at the bottom, 1 at the top. Back and Elastic
  // pass outside both, which is only legible with something to pass outside of.
  const guide = (y: number): Polyline =>
    new Polyline({
      points: [
        { x: left, y },
        { x: left + PLOT_W, y },
      ],
      stroke: '#c9d0dc',
      strokeWidth: 1,
    })

  // Sampled from the same function the tween reads, so the runner cannot drift off the line it
  // is drawn against - if the plot and the motion disagreed, one of them would be wrong.
  const samples: Vector2Like[] = []
  for (let i = 0; i <= 48; i++) {
    const t = i / 48
    samples.push({ x: left + t * PLOT_W, y: base - easing(t, 0, 1, 1) * PLOT_H })
  }

  const runner = new Circle({ name: `runner-${name}`, x: left, y: base, radius: 4, fill: CRIMSON })

  new Tween({ node: runner, ticker, duration: RUN, yoyo: true, easing: Easings.Linear, x: left + PLOT_W }).play()
  new Tween({ node: runner, ticker, duration: RUN, yoyo: true, easing, y: top }).play()

  return {
    nodes: [
      guide(base),
      guide(top),
      new Polyline({ name: `curve-${name}`, points: samples, stroke: NAVY, strokeWidth: 2 }),
      runner,
      caption(x0 + 2, y0 + 112, name, 11),
    ],
    runner,
  }
}

// --- the attribute row ----------------------------------------------------------------------

const RIGHT_X = -20
const ATTR_Y = -212
const ATTR_CELL_W = 137
const ATTR_CELL_H = 100

/** Where a cell's shape sits, with the caption naming the attribute it animates. */
function attrCell(index: number, label: string): { x: number; y: number; caption: MSDFText } {
  const x = RIGHT_X + (index % 4) * ATTR_CELL_W
  const y = ATTR_Y + Math.floor(index / 4) * ATTR_CELL_H
  return { x, y, caption: caption(x, y + 84, label, 12) }
}

// --- the scene --------------------------------------------------------------------------------

export function buildTweenScene(scene: Scene): SceneContent {
  const root = scene.root

  // Stepped from onFrame below rather than from an animation frame of its own, so the app's
  // speed control reaches every tween in the scene and 0 stops time outright.
  const ticker = new TweenTicker()
  ticker.autoDrive = false

  /** Nodes a tween writes x or y on. A drag would fight the tween for the same attribute. */
  const driven: Node[] = []

  root.addChild(
    new MSDFText({ x: -520, y: -340, text: 'Tweening', style: { fontStyle: 'bold', fontSize: 40, color: DARK } }),
  )
  root.addChild(
    caption(
      -520,
      -284,
      'attributes carried over time - every key that is not a setting is one of the node’s own, so anything setAttr reaches can be animated',
      15,
    ),
  )

  // --- every curve --------------------------------------------------------------------------
  root.addChild(heading(GRID_X, GRID_Y - 26, 'Every curve, and the runner tracing it'))
  CURVES.forEach((curve, i) => {
    const cell = curveCell(i, curve.name, curve.easing, ticker)
    for (const node of cell.nodes) root.addChild(node)
    driven.push(cell.runner)
  })
  root.addChild(
    caption(GRID_X, GRID_Y + 4 * CELL_H + 6, 'each runner is two tweens on one node: x linear, y through the curve'),
  )

  // --- anything the node exposes --------------------------------------------------------------
  //
  // Eight cells, eight kinds of attribute, one tween each. Nothing here is an animation feature
  // of the shape - a Circle has no idea its radius is being animated, and neither does the tween
  // know what a radius is. It reads the attribute, works out what carries it to the value asked
  // for, and writes it back.
  root.addChild(heading(RIGHT_X, ATTR_Y - 26, 'Anything the node exposes'))

  const spin = attrCell(0, 'rotation')
  const spinner = root.addChild(
    new Rect({ x: spin.x + 34, y: spin.y + 40, width: 44, height: 44, offsetX: 22, offsetY: 22, fill: NAVY, cornerRadius: 6 }),
  )
  new Tween({ node: spinner, ticker, duration: 2.4, yoyo: true, easing: Easings.EaseInOut, rotation: 180 }).play()
  root.addChild(spin.caption)

  const grow = attrCell(1, 'scaleX, scaleY')
  const grower = root.addChild(
    new Rect({ x: grow.x + 34, y: grow.y + 40, width: 44, height: 44, offsetX: 22, offsetY: 22, fill: TEAL, cornerRadius: 6 }),
  )
  new Tween({ node: grower, ticker, duration: 1.3, yoyo: true, easing: Easings.EaseInOut, scaleX: 1.5, scaleY: 0.6 }).play()
  root.addChild(grow.caption)

  const fade = attrCell(2, 'opacity')
  const fader = root.addChild(
    new Rect({ x: fade.x + 12, y: fade.y + 18, width: 44, height: 44, fill: CRIMSON, cornerRadius: 6 }),
  )
  new Tween({ node: fader, ticker, duration: 1.1, yoyo: true, opacity: 0.1 }).play()
  root.addChild(fade.caption)

  const tint = attrCell(3, 'fill   channel by channel')
  const tinted = root.addChild(
    new Rect({ x: tint.x + 12, y: tint.y + 18, width: 44, height: 44, fill: NAVY, cornerRadius: 6 }),
  )
  new Tween({ node: tinted, ticker, duration: 1.7, yoyo: true, easing: Easings.EaseInOut, fill: YELLOW }).play()
  root.addChild(tint.caption)

  const thicken = attrCell(4, 'strokeWidth')
  const ring = root.addChild(
    new Circle({ x: thicken.x + 34, y: thicken.y + 40, radius: 20, fill: null, stroke: NAVY, strokeWidth: 2 }),
  )
  new Tween({ node: ring, ticker, duration: 1.5, yoyo: true, easing: Easings.EaseInOut, strokeWidth: 12 }).play()
  root.addChild(thicken.caption)

  const round = attrCell(5, 'cornerRadius')
  const rounding = root.addChild(
    new Rect({ x: round.x + 12, y: round.y + 18, width: 44, height: 44, fill: TEAL, cornerRadius: 0 }),
  )
  new Tween({ node: rounding, ticker, duration: 1.9, yoyo: true, easing: Easings.EaseInOut, cornerRadius: 22 }).play()
  root.addChild(round.caption)

  const swell = attrCell(6, 'radius')
  const disc = root.addChild(new Circle({ x: swell.x + 34, y: swell.y + 40, radius: 8, fill: CRIMSON }))
  new Tween({ node: disc, ticker, duration: 1.2, yoyo: true, easing: Easings.BounceEaseOut, radius: 24 }).play()
  root.addChild(swell.caption)

  // A dash pattern marches by moving where the outline starts reading it. No yoyo: the offset
  // runs one whole period and the finish puts it back and plays again, which is a loop that
  // always travels the same way rather than one that reverses.
  const march = attrCell(7, 'dashOffset   restarted on finish')
  const ants = root.addChild(
    new Rect({
      name: 'marching-ants',
      x: march.x + 12,
      y: march.y + 22,
      width: 92,
      height: 40,
      fill: null,
      stroke: NAVY,
      strokeWidth: 2,
      dash: [8, 6],
    }),
  )
  const antsTween = new Tween({ node: ants, ticker, duration: 0.9, dashOffset: 14 })
  antsTween.onFinish = function () {
    this.reset()
    this.play()
  }
  antsTween.play()
  root.addChild(march.caption)

  // --- values that are not numbers ---------------------------------------------------------
  const SHAPE_Y = 20
  root.addChild(heading(RIGHT_X, SHAPE_Y, 'Values that are not numbers'))

  // A gradient carries two kinds of value at once: where it runs, as points, and what it runs
  // through, as stops of offset plus colour. Both stop lists are written flat, which is one of
  // the two forms the attribute takes and not the one it reads back as - so the tween puts them
  // into the form the shape holds before working out what lies between them.
  const gradient = root.addChild(
    new Rect({ name: 'gradient', x: RIGHT_X, y: SHAPE_Y + 22, width: 250, height: 88, cornerRadius: 8 }),
  )
  gradient.fillPriority = 'linear-gradient'
  gradient.fillLinearGradientStartPoint = { x: 0, y: 0 }
  gradient.fillLinearGradientEndPoint = { x: 250, y: 0 }
  gradient.fillLinearGradientColorStops = [0, NAVY, 1, TEAL]
  new Tween({
    node: gradient,
    ticker,
    duration: 2.6,
    yoyo: true,
    easing: Easings.EaseInOut,
    fillLinearGradientEndPoint: { x: 90, y: 88 },
    fillLinearGradientColorStops: [0.25, CRIMSON, 0.85, YELLOW],
  }).play()
  root.addChild(caption(RIGHT_X, SHAPE_Y + 128, 'gradient stops and geometry'))

  // Three points becoming eight. The new points do not exist at the start, so each one begins
  // at its nearest place on the line it is joining and slides out from there - the line grows
  // rather than five points flying in from the origin.
  const ZIG: Vector2Like[] = [
    { x: RIGHT_X + 290, y: SHAPE_Y + 100 },
    { x: RIGHT_X + 380, y: SHAPE_Y + 30 },
    { x: RIGHT_X + 470, y: SHAPE_Y + 100 },
  ]
  const WAVE: Vector2Like[] = Array.from({ length: 8 }, (_, i) => ({
    x: RIGHT_X + 290 + (i / 7) * 180,
    y: SHAPE_Y + 66 + Math.sin((i / 7) * Math.PI * 2) * 40,
  }))
  const morph = root.addChild(
    new Polyline({ name: 'morph', points: ZIG, stroke: CRIMSON, strokeWidth: 3, lineJoin: 'round' }),
  )
  new Tween({ node: morph, ticker, duration: 2.6, yoyo: true, easing: Easings.EaseInOut, points: WAVE }).play()
  root.addChild(caption(RIGHT_X + 290, SHAPE_Y + 128, 'points: 3 → 8, resampled to grow'))

  // --- the ends ------------------------------------------------------------------------------
  const END_Y = 172
  root.addChild(heading(RIGHT_X, END_Y, 'What happens at the ends'))

  // `to()` is the fire-and-forget form: it plays at once and destroys itself at the finish,
  // which is what makes this legal - the next leg claims x and y from a handler running after
  // the tween that held them has let go.
  const hopper = root.addChild(new Circle({ x: RIGHT_X + 20, y: END_Y + 60, radius: 11, fill: NAVY }))
  driven.push(hopper)
  const LEGS: Vector2Like[] = [
    { x: RIGHT_X + 20, y: END_Y + 60 },
    { x: RIGHT_X + 150, y: END_Y + 60 },
    { x: RIGHT_X + 150, y: END_Y + 106 },
    { x: RIGHT_X + 20, y: END_Y + 106 },
  ]
  let leg = 0
  const hop = (): void => {
    leg = (leg + 1) % LEGS.length
    hopper.to({ ticker, duration: 0.75, easing: Easings.EaseInOut, x: LEGS[leg].x, y: LEGS[leg].y, onFinish: hop })
  }
  hop()
  root.addChild(caption(RIGHT_X, END_Y + 134, 'to(), chained from its own onFinish'))

  // One attribute moving between two tweens, mid-flight. The drift owns x and y; part-way
  // through, a second tween takes x and pulls it back, and the drift carries on with y alone -
  // so the square keeps descending while its horizontal motion is somebody else's.
  const START = { x: RIGHT_X + 260, y: END_Y + 26 }
  const taken = root.addChild(
    new Rect({ x: START.x, y: START.y, width: 26, height: 26, fill: TEAL, cornerRadius: 4 }),
  )
  driven.push(taken)
  const drift = (): void => {
    taken.x = START.x
    taken.y = START.y
    let stolen = false
    const drifting = new Tween({
      node: taken,
      ticker,
      duration: 3,
      x: START.x + 210,
      y: START.y + 64,
      onFinish: drift,
    })
    drifting.onUpdate = function () {
      // Half way along, and only once: from here the drift is writing y and nothing else.
      if (stolen || this.time < 1.5) return
      stolen = true
      new Tween({ node: taken, ticker, duration: 1.5, easing: Easings.BackEaseOut, x: START.x }).play()
    }
    drifting.play()
  }
  drift()
  root.addChild(caption(RIGHT_X + 260, END_Y + 134, 'a second tween takes x; the first keeps y'))

  return {
    keepDragOptOut: driven,
    onFrame: (dt, speed) => ticker.advance(dt * speed * 1000),
  }
}
