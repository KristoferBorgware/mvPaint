// Polyline: what a list of points can be asked to mean.
//
// The list itself is the least of it. A Polyline reads its points four ways, and each section
// below is one of them:
//
//   - as corners, joined by straight lines - the plain reading, and the one every other section
//     is measured against;
//   - as a path to be SMOOTHED THROUGH (`tension`), which fits a Catmull-Rom spline that still
//     lands exactly on every point it was given;
//   - as control points to be FOLLOWED (`bezier`), where only every third point is on the curve
//     and the two between are handles pulling it;
//   - and as a ring (`closed`), which gives the shape an interior: fill triangles to paint, and
//     somewhere inside to click.
//
// The last section is about what a polyline then knows about itself. It is not sized - width and
// height are the extent of the curve it draws, not a pair of numbers it was handed - and it can
// be walked: getLength() measures the drawn outline and getPointAtLength() gives back the point
// that far along it, which is what carries the marker round the bottom-right curve.
//
// Every curve here is flattened into line segments before it reaches the stroker. Nothing
// downstream of a shape knows what a curve is, which is why `tension` and `bezier` and a hand-
// authored zig-zag all draw through exactly the same code.

import {
  Circle,
  MSDFText,
  Polyline,
  Rect,
  type Scene,
  type Vector2Like,
} from '@mvpaint/engine'
import { CRIMSON, DARK, NAVY, SLATE, TEAL, withAlpha } from './palette'
import type { SceneContent } from './types'

function label(x: number, y: number, text: string): MSDFText {
  return new MSDFText({ x, y, text, style: { fontSize: 15, color: SLATE } })
}

function caption(x: number, y: number, text: string, color = SLATE): MSDFText {
  return new MSDFText({ x, y, text, style: { fontSize: 13, color } })
}

function heading(x: number, y: number, text: string): MSDFText {
  return new MSDFText({ x, y, text, style: { fontSize: 17, fontStyle: 'bold', color: DARK } })
}

/** A small disc on a point the curve was built from, so it can be seen being passed through. */
function marker(point: Vector2Like, radius: number, color: string): Circle {
  return new Circle({ x: point.x, y: point.y, radius, fill: color })
}

/** `count` points evenly round a circle, starting at the top. */
function ring(cx: number, cy: number, radius: number, count: number): Vector2Like[] {
  const points: Vector2Like[] = []
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 - Math.PI / 2
    points.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius })
  }
  return points
}

/**
 * The five points every curve in the first section is drawn through, written flat. A point list
 * takes either form - `[x, y, x, y, ...]` or `[{ x, y }, ...]` - and reads back as objects
 * whichever way it went in. Every other list in this file is written the other way.
 */
const WAVE = [-510, -126, -395, -126, -280, -196, -165, -196, -50, -126]

/** The tensions drawn over each other, and the colour each is drawn in. */
const TENSIONS: readonly { tension: number; color: string; width: number; text: string }[] = [
  { tension: 0, color: SLATE, width: 2, text: 'tension: 0   the list as written' },
  { tension: 0.5, color: NAVY, width: 3, text: 'tension: 0.5   pulled toward a curve' },
  { tension: 1, color: TEAL, width: 3, text: 'tension: 1   the uniform spline' },
  { tension: 1.5, color: CRIMSON, width: 3, text: 'tension: 1.5   past it, and overshooting' },
]

/**
 * Seven points, read as two cubics: (0) start, (1)(2) handles, (3) the join, (4)(5) handles,
 * (6) end. Only 0, 3 and 6 are on the curve.
 */
const BEZIER: Vector2Like[] = [
  { x: 70, y: -80 },
  { x: 70, y: -200 },
  { x: 240, y: -200 },
  { x: 240, y: -80 },
  { x: 240, y: 40 },
  { x: 410, y: 40 },
  { x: 410, y: -80 },
]
const BEZIER_ANCHORS = new Set([0, 3, 6])

/** The curve the last section measures and walks along. */
const MEASURED: Vector2Like[] = [
  { x: 70, y: 250 },
  { x: 160, y: 160 },
  { x: 260, y: 270 },
  { x: 360, y: 170 },
  { x: 450, y: 250 },
]

export function buildPolylineScene(scene: Scene): SceneContent {
  const root = scene.root

  root.addChild(
    new MSDFText({ x: -520, y: -340, text: 'Polylines', style: { fontStyle: 'bold', fontSize: 40, color: DARK } }),
  )
  root.addChild(
    label(-520, -284, 'a list of points, read four ways - as corners, as a path to smooth through, as control points to follow, and as a ring'),
  )

  // --- tension: a curve through the points ---------------------------------------------------
  //
  // Four curves over one point set, so the family can be read at a glance. Each is a Catmull-Rom
  // spline flattened into segments, and each still lands exactly on every point it was drawn
  // through - the discs underneath are on the curve, not near it. Above 1 the spline leans
  // further into each turn than the points do, which is the overshoot on the crimson line.
  root.addChild(heading(-520, -262, 'tension: a curve through the points'))
  root.addChild(caption(-520, -236, 'points: [-510, -126, -395, -126, ...] - written flat here, and read back as objects'))

  TENSIONS.forEach(({ tension, color, width }, i) => {
    root.addChild(
      new Polyline({
        name: `tension-${i}`,
        points: WAVE,
        tension,
        stroke: color,
        strokeWidth: width,
        lineJoin: 'round',
        lineCap: 'round',
      }),
    )
  })
  for (let i = 0; i + 1 < WAVE.length; i += 2) {
    root.addChild(marker({ x: WAVE[i], y: WAVE[i + 1] }, 4, DARK))
  }
  TENSIONS.forEach(({ color, text }, i) => {
    root.addChild(caption(-520, -84 + i * 21, text, color))
  })

  // --- closed: a ring with an interior --------------------------------------------------------
  //
  // `closed` joins the last point to the first, and that is what gives the shape an inside: it
  // tessellates fill triangles like any other closed shape, so the fill paints and a click in the
  // middle hits it. An open polyline has no interior and emits none, whatever its fill says.
  //
  // Smoothing wraps round the seam as well - the neighbours a closed spline leans on are found by
  // wrapping the list, so the join is no more of a corner than any other point.
  root.addChild(heading(-520, 20, 'closed: a ring, and an inside to click'))
  root.addChild(caption(-520, 44, 'the same seven points - a heptagon, the spline through it, and the same again with tension animated'))

  const heptagon = ring(-420, 160, 66, 7)
  root.addChild(
    new Polyline({
      name: 'ring-plain',
      points: heptagon,
      closed: true,
      fill: withAlpha(TEAL, 0.18),
      stroke: TEAL,
      strokeWidth: 3,
      lineJoin: 'round',
    }),
  )
  root.addChild(
    new Polyline({
      name: 'ring-smooth',
      points: ring(-250, 160, 66, 7),
      closed: true,
      tension: 1,
      fill: withAlpha(NAVY, 0.18),
      stroke: NAVY,
      strokeWidth: 3,
    }),
  )
  const breathing = root.addChild(
    new Polyline({
      name: 'ring-breathing',
      points: ring(-80, 160, 66, 7),
      closed: true,
      tension: 1,
      fill: withAlpha(CRIMSON, 0.18),
      stroke: CRIMSON,
      strokeWidth: 3,
    }),
  )
  root.addChild(caption(-520, 252, 'closed: true'))
  root.addChild(caption(-320, 252, 'closed: true, tension: 1'))
  root.addChild(caption(-125, 252, 'tension animated'))
  root.addChild(caption(-520, 288, 'each is filled, so each is clickable in the middle rather than only along its outline'))

  // --- bezier: control points to follow --------------------------------------------------------
  //
  // The other reading of a list. Where tension smooths THROUGH every point, bezier follows a
  // start point and then groups of three - two handles and an end - so four of these seven are
  // never touched by the curve. The faint line joining them is the control net, drawn as an
  // ordinary polyline over the same points, which is the clearest way to see what the handles do.
  root.addChild(heading(70, -248, 'bezier: control points to follow'))
  root.addChild(caption(70, -224, 'a start point, then groups of three - two handles and an end'))

  root.addChild(
    new Polyline({
      name: 'bezier-net',
      points: BEZIER,
      stroke: SLATE,
      strokeWidth: 1,
      dash: [6, 5],
    }),
  )
  root.addChild(
    new Polyline({
      name: 'bezier-curve',
      points: BEZIER,
      bezier: true,
      stroke: TEAL,
      strokeWidth: 4,
      lineCap: 'round',
    }),
  )
  BEZIER.forEach((point, i) => {
    const anchor = BEZIER_ANCHORS.has(i)
    root.addChild(marker(point, anchor ? 5 : 3.5, anchor ? DARK : CRIMSON))
  })
  root.addChild(caption(70, 72, 'dark discs are on the curve; crimson ones pull it and are not', DARK))

  // --- what a polyline knows about itself --------------------------------------------------
  //
  // It is not sized. width and height report the extent of the curve it draws - so they answer
  // for the flattened spline, not for the five points it was built from - and the hairline box is
  // drawn from exactly those two numbers. Assigning either would pin it; nothing here does.
  //
  // getLength() measures the same outline segment by segment, and getPointAtLength() walks it, so
  // the disc is placed by asking the shape rather than by re-deriving the curve alongside it.
  root.addChild(heading(70, 96, 'measured, not sized - and walkable'))

  const measured = root.addChild(
    new Polyline({
      name: 'measured-curve',
      points: MEASURED,
      tension: 1,
      stroke: NAVY,
      strokeWidth: 4,
      lineCap: 'round',
    }),
  )
  const outline = measured.outline()
  const minX = Math.min(...outline.map((p) => p.x))
  const minY = Math.min(...outline.map((p) => p.y))
  root.addChild(
    new Rect({
      name: 'measured-box',
      x: minX,
      y: minY,
      width: measured.width,
      height: measured.height,
      fill: [0, 0, 0, 0],
      stroke: CRIMSON,
      strokeWidth: 1,
      strokeScaleEnabled: false,
    }),
  )
  const length = measured.getLength()
  root.addChild(
    caption(70, 122, `width ${measured.width.toFixed(1)} x height ${measured.height.toFixed(1)}, from the curve rather than the points`),
  )
  root.addChild(caption(70, 288, `getLength() ${length.toFixed(1)} - the disc is placed by getPointAtLength()`))

  const traveller = root.addChild(new Circle({ name: 'traveller', radius: 8, fill: CRIMSON }))

  let t = 0
  return {
    onFrame: (dt, speed) => {
      t += dt * speed
      // Modulo the length, so the disc runs the curve and starts again rather than stopping at
      // the far end where getPointAtLength() clamps.
      const at = measured.getPointAtLength((t * 110) % length)
      if (at) {
        traveller.x = at.x
        traveller.y = at.y
      }
      // A tension is geometry, so this is a re-tessellation per frame - the same as an animated
      // dash offset, and for the same reason.
      breathing.tension = 0.8 + Math.sin(t * 0.9) * 0.8
    },
  }
}
