// Shapes the engine does not know about: five classes written here, in this file, each one
// a subclass of CustomShape that draws its own outline.
//
// The sections are about what that buys, in order of how much of it is free:
//
//   top left      a star and a heart - describe(), and nothing else
//   top right     one continuous route whose legs have their own colour and thickness
//   bottom left   a gear: holes, and a gradient and a shadow it never asked for
//   bottom right  a wave whose outline really does change, and what that costs
//
// Every one of them is picked on its real outline, framed by its real bounds, and stacked
// in the same scene-wide order as everything else - none of which is written below, because
// none of it has to be.

import { CustomShape, Text, type CustomShapeOptions, type Scene, type ShapeContext, type Vector2Like } from '@mvpaint/engine'
import { CRIMSON, DARK, NAVY, SLATE, TEAL } from './palette'
import type { SceneContent } from './types'

// --- the shapes ------------------------------------------------------------------------

/** A star of `tips` points, centred on its own origin. */
class Star extends CustomShape {
  constructor(
    private readonly tips: number,
    private readonly outer: number,
    private readonly inner: number,
    options: CustomShapeOptions = {},
  ) {
    super(options)
  }

  protected override describe(ctx: ShapeContext): void {
    for (let i = 0; i < this.tips * 2; i++) {
      const radius = i % 2 === 0 ? this.outer : this.inner
      const angle = Math.PI / 2 + (Math.PI * i) / this.tips
      const x = Math.cos(angle) * radius
      const y = Math.sin(angle) * radius
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    // Fill and stroke in one call. Both read the shape's own fill/stroke, because this
    // description never sets a style of its own.
    ctx.fillAndStroke()
  }
}

/** A heart, from two cubics - the case a polygon cannot approximate without looking like one. */
class Heart extends CustomShape {
  constructor(
    private readonly size: number,
    options: CustomShapeOptions = {},
  ) {
    super(options)
  }

  protected override describe(ctx: ShapeContext): void {
    const s = this.size
    ctx.moveTo(0, -s)
    ctx.bezierCurveTo(-s * 1.4, s * 0.35, -s * 0.55, s * 1.15, 0, s * 0.42)
    ctx.bezierCurveTo(s * 0.55, s * 1.15, s * 1.4, s * 0.35, 0, -s)
    ctx.closePath()
    ctx.fillAndStroke()
  }
}

/**
 * A route: a run of legs where each one carries its own colour and thickness.
 *
 * This is what style() is for. The legs are one continuous path - one shape, one object,
 * one entry in the stacking order - and the colour changes are recorded against the
 * segments rather than splitting the thing into five nodes.
 */
interface Leg {
  x: number
  y: number
  stroke: string
  strokeWidth: number
}

class Route extends CustomShape {
  constructor(
    private readonly legs: readonly Leg[],
    options: CustomShapeOptions = {},
  ) {
    super(options)
  }

  protected override describe(ctx: ShapeContext): void {
    // Round caps, because where the style changes the two runs meet end to end and each
    // gets its own cap - round ones close that seam invisibly.
    ctx.style({ lineCap: 'round', lineJoin: 'round' })
    this.legs.forEach((leg, i) => {
      if (i === 0) {
        ctx.moveTo(leg.x, leg.y)
        return
      }
      // Set BEFORE the segment is added: a style applies to everything after it, which is
      // what lets one outline change colour partway along.
      ctx.style({ stroke: leg.stroke, strokeWidth: leg.strokeWidth })
      ctx.lineTo(leg.x, leg.y)
    })
    ctx.stroke()

    // A dot at each junction, in that leg's own colour, from the same description - a
    // custom shape is not limited to one path.
    this.legs.forEach((leg, i) => {
      if (i === 0) return
      ctx.style({ fill: leg.stroke })
      ctx.beginPath()
      ctx.circle(leg.x, leg.y, leg.strokeWidth * 0.62)
      ctx.fill()
    })
  }
}

/** A gear: a toothed outer ring with a round bore, so the fill has a real hole in it. */
class Gear extends CustomShape {
  constructor(
    private readonly teeth: number,
    private readonly outer: number,
    private readonly rootRadius: number,
    private readonly bore: number,
    options: CustomShapeOptions = {},
  ) {
    super(options)
  }

  protected override describe(ctx: ShapeContext): void {
    const step = (Math.PI * 2) / this.teeth
    for (let i = 0; i < this.teeth; i++) {
      const a = i * step
      // Each tooth is a flank out, a tip arc, and a flank back to the root circle.
      ctx.lineTo(Math.cos(a) * this.rootRadius, Math.sin(a) * this.rootRadius)
      ctx.lineTo(Math.cos(a + step * 0.18) * this.outer, Math.sin(a + step * 0.18) * this.outer)
      ctx.lineTo(Math.cos(a + step * 0.38) * this.outer, Math.sin(a + step * 0.38) * this.outer)
      ctx.lineTo(Math.cos(a + step * 0.56) * this.rootRadius, Math.sin(a + step * 0.56) * this.rootRadius)
    }
    ctx.closePath()
    // A second subpath inside the first is a hole - the same nesting rule an SVG path with
    // a counter-wound inner ring gets.
    ctx.circle(0, 0, this.bore)
    ctx.fillAndStroke()
  }
}

/**
 * A sine wave as a closed band. Its outline genuinely depends on `phase`, so this is the
 * one shape here that has to be re-described - see the caption, and onFrame below.
 */
class Wave extends CustomShape {
  phase = 0

  constructor(
    private readonly span: number,
    private readonly amplitude: number,
    private readonly thickness: number,
    options: CustomShapeOptions = {},
  ) {
    super(options)
  }

  protected override describe(ctx: ShapeContext): void {
    const steps = 64
    const at = (i: number): Vector2Like => {
      const t = i / steps
      return { x: t * this.span, y: Math.sin(t * Math.PI * 3 + this.phase) * this.amplitude }
    }
    ctx.moveTo(0, at(0).y + this.thickness / 2)
    for (let i = 1; i <= steps; i++) {
      const p = at(i)
      ctx.lineTo(p.x, p.y + this.thickness / 2)
    }
    for (let i = steps; i >= 0; i--) {
      const p = at(i)
      ctx.lineTo(p.x, p.y - this.thickness / 2)
    }
    ctx.closePath()
    ctx.fill()
  }
}

// --- the scene ---------------------------------------------------------------------------

function label(x: number, y: number, text: string): Text {
  return new Text({ x, y, text, style: { fontSize: 15, color: SLATE } })
}

function caption(x: number, y: number, text: string): Text {
  return new Text({ x, y, text, style: { fontSize: 13, color: SLATE } })
}

export function buildCustomShapeScene(scene: Scene): SceneContent {
  const root = scene.root

  // --- describe() and nothing else --------------------------------------------------------
  root.addChild(
    new Star(5, 92, 40, {
      x: -430,
      y: 146,
      fill: '#ffc93d',
      stroke: '#a86e00',
      strokeWidth: 6,
      lineJoin: 'miter',
      // Never mentioned in the class, and cast from the star's real silhouette rather than
      // a box around it - the shadow bakes whatever geometry the description produced.
      shadowColor: '#00000059',
      shadowBlur: 18,
      shadowOffsetX: 8,
      shadowOffsetY: 12,
    }),
  )

  const heart = new Heart(78, { x: -215, y: 136, stroke: '#8c0f2b', strokeWidth: 5 })
  // Gradients are on Shape, so a described outline takes one the same way a Rect does.
  heart.fillPriority = 'radial-gradient'
  heart.fillRadialGradientStartPoint = { x: -20, y: 40 }
  heart.fillRadialGradientStartRadius = 4
  heart.fillRadialGradientEndPoint = { x: 0, y: 0 }
  heart.fillRadialGradientEndRadius = 110
  heart.fillRadialGradientColorStops = [
    { offset: 0, color: '#ff8fa8' },
    { offset: 1, color: CRIMSON },
  ]
  root.addChild(heart)

  root.addChild(caption(-500, 42, 'a star and a heart - one describe() each, no engine support for either'))
  root.addChild(label(-500, 20, 'click a notch between two points: the hit test uses the outline, not a box'))

  // --- one outline, several styles --------------------------------------------------------
  const route = new Route([
    { x: 0, y: 0, stroke: TEAL, strokeWidth: 14 },
    { x: 90, y: 70, stroke: TEAL, strokeWidth: 14 },
    { x: 190, y: 30, stroke: '#e6802e', strokeWidth: 22 },
    { x: 280, y: 130, stroke: '#e6802e', strokeWidth: 22 },
    { x: 350, y: 90, stroke: CRIMSON, strokeWidth: 9 },
    { x: 430, y: 168, stroke: NAVY, strokeWidth: 30 },
  ])
  route.x = 40
  route.y = 96
  root.addChild(route)

  root.addChild(caption(40, 42, 'one shape, four stroke colours and four widths'))
  root.addChild(label(40, 20, 'style() applies to what comes after it'))

  // --- holes, and everything else that comes free -----------------------------------------
  const gear = new Gear(14, 100, 74, 34, {
    x: -400,
    y: -224,
    stroke: '#2b2b33',
    strokeWidth: 4,
    shadowColor: '#00000066',
    shadowBlur: 22,
    shadowOffsetY: 14,
  })
  gear.fillPriority = 'linear-gradient'
  gear.fillLinearGradientStartPoint = { x: -100, y: 100 }
  gear.fillLinearGradientEndPoint = { x: 100, y: -100 }
  gear.fillLinearGradientColorStops = [
    { offset: 0, color: '#8fa3c4' },
    { offset: 0.5, color: '#e3e9f2' },
    { offset: 1, color: '#6d7d99' },
  ]
  root.addChild(gear)

  // A second one, smaller and turning the other way, to make the point that a transform is
  // still just a transform - the outline is described once however the node is moved.
  const pinion = new Gear(9, 58, 42, 18, {
    x: -212,
    y: -282,
    fill: '#d9a441',
    stroke: '#8a6212',
    strokeWidth: 3,
  })
  root.addChild(pinion)

  root.addChild(caption(-500, -346, 'a gear: a toothed ring with a bore through it, wearing a gradient and a shadow'))
  root.addChild(label(-500, -368, 'the bore is a second subpath inside the first'))

  // --- an outline that actually changes ---------------------------------------------------
  const wave = new Wave(430, 52, 26, { x: 40, y: -254, fill: NAVY, opacity: 0.9 })
  root.addChild(wave)

  root.addChild(caption(40, -346, 'the only one here whose outline is re-described'))
  root.addChild(label(40, -368, 'moving or recolouring never re-runs describe()'))

  root.addChild(
    new Text({
      x: -500,
      y: 344,
      text: 'Custom shapes',
      style: { fontStyle: 'bold', fontSize: 40, color: DARK },
    }),
  )
  // 56 below the title's own y, not 34: a 40px line reaches ~50 below where it is anchored,
  // so anything closer than that lands in the title's descenders.
  root.addChild(
    new Text({
      x: -500,
      y: 288,
      text: 'five classes, each one a CustomShape that draws its own contour',
      style: { fontSize: 15, color: SLATE },
    }),
  )

  let t = 0
  return {
    onFrame: (dt, speed) => {
      t += dt * speed

      // Free: a transform is applied per frame from the object record and never touches the
      // description, so these two turn for nothing at all.
      gear.rotation = t * 0.5
      pinion.rotation = -t * 0.5 * (14 / 9)

      // Not free: the wave's outline depends on its phase, so a new phase is a new outline
      // and has to be announced. That is a re-describe and a re-triangulate every frame -
      // which is why the other four say nothing and stay cached.
      wave.phase = t * 1.6
      wave.markGeometryDirty()
    },
  }
}
