// Mesh-lane basics: gradient fills (linear and radial), stroking with joins and caps, and
// per-frame animation. The two rects spin about their own centres, driven by the app's
// rotation-speed control.

import { Circle, Polyline, Rect, type Scene } from '@mvpaint/engine'
import type { SceneContent } from './types'

export function buildShapesScene(scene: Scene): SceneContent {
  const spins = new Map<Rect, number>()

  // Two rects side by side, filled + stroked, spinning about their centers. Sized in
  // pixel-equivalent world units.
  //
  // A Rect's origin is its top-left corner, so it would otherwise turn about that corner
  // and swing across the scene; offsetX/offsetY move the pivot back to the middle, which is
  // what "spinning about their centers" needs. It also means x/y still name the centre.
  const left = scene.root.addChild(
    new Rect({
      name: 'rect-left',
      x: -110,
      y: 0,
      width: 160,
      height: 160,
      offsetX: 80,
      offsetY: -80,
      fill: [0.9, 0.28, 0.24, 1],
      stroke: [0.5, 0.1, 0.08, 1],
      strokeWidth: 6,
    }),
  )
  // Linear gradient across the rect's own diagonal, in its local (pre-transform)
  // space - it moves and rotates with the rect.
  left.fillPriority = 'linear-gradient'
  // Local space runs [0, width] x [-height, 0], so the diagonal is bottom-left to top-right.
  left.fillLinearGradientStartPoint = { x: 0, y: -160 }
  left.fillLinearGradientEndPoint = { x: 160, y: 0 }
  left.fillLinearGradientColorStops = [
    { offset: 0, color: [1, 0.9, 0.3, 1] },
    { offset: 1, color: [0.9, 0.1, 0.2, 1] },
  ]
  const right = scene.root.addChild(
    new Rect({
      name: 'rect-right',
      x: 120,
      y: 0,
      width: 200,
      height: 130,
      offsetX: 100,
      offsetY: -65,
      fill: [0.2, 0.45, 0.9, 1],
      stroke: [0.08, 0.18, 0.5, 1],
      strokeWidth: 6,
    }),
  )
  spins.set(left, 1)
  spins.set(right, -1.4)

  // A circle centered between the rects, drawn last so it layers on top (painter order).
  const circle = scene.root.addChild(
    new Circle({
      name: 'circle',
      x: 0,
      y: 0,
      radius: 90,
      fill: [0.2, 0.72, 0.36, 1],
      stroke: [0.1, 0.4, 0.2, 1],
      strokeWidth: 6,
    }),
  )
  // Radial gradient from the circle's own center out to its own radius, in local
  // space - a concentric center-to-edge fade.
  circle.fillPriority = 'radial-gradient'
  circle.fillRadialGradientStartPoint = { x: 0, y: 0 }
  circle.fillRadialGradientStartRadius = 0
  circle.fillRadialGradientEndPoint = { x: 0, y: 0 }
  circle.fillRadialGradientEndRadius = 90
  circle.fillRadialGradientColorStops = [
    { offset: 0, color: [0.9, 1, 0.6, 1] },
    { offset: 1, color: [0.1, 0.5, 0.2, 1] },
  ]

  // An open zigzag polyline below the shapes, demonstrating the general contour
  // stroker on a non-rectangular, non-circular path: round join + round caps
  // (Canvas2D-style lineJoin/lineCap, both configurable per-instance).
  scene.root.addChild(
    new Polyline({
      name: 'zigzag',
      points: [
        { x: -180, y: -180 },
        { x: -90, y: -120 },
        { x: 0, y: -180 },
        { x: 90, y: -120 },
        { x: 180, y: -180 },
      ],
      stroke: [0.55, 0.35, 0.85, 1],
      strokeWidth: 14,
      lineJoin: 'round',
      lineCap: 'round',
    }),
  )

  // A row of rounded rects below the zigzag: one radius for all four corners, a per-corner
  // set, a radius far too large for the box (scaled down to a stadium rather than clipped),
  // and one stroked, where the outline follows the arcs instead of turning square corners.
  //
  // Rounding is geometry, so these are set at construction; changing one afterwards needs a
  // markGeometryDirty() the way Circle.radius does.
  const roundedRow: { x: number; cornerRadius: number | [number, number, number, number]; stroked?: boolean }[] = [
    { x: -300, cornerRadius: 16 },
    { x: -150, cornerRadius: [45, 0, 45, 0] },
    { x: 0, cornerRadius: 999 },
    { x: 150, cornerRadius: 22, stroked: true },
  ]
  for (const [i, spec] of roundedRow.entries()) {
    scene.root.addChild(
      new Rect({
        name: `rounded-${i}`,
        x: spec.x,
        y: -230,
        width: 130,
        height: 90,
        cornerRadius: spec.cornerRadius,
        fill: [0.16, 0.55, 0.62, 1],
        stroke: [0.95, 0.75, 0.3, 1],
        strokeWidth: spec.stroked ? 8 : 0,
        lineJoin: 'round',
      }),
    )
  }

  // The spin lives here rather than in the canvas: a scene owns its own animation state,
  // so switching away from it discards the accumulator along with the shapes.
  let angle = 0
  return {
    onFrame: (dt, speed) => {
      if (speed <= 0) return
      angle += dt * speed
      for (const [rect, spinScale] of spins) rect.rotation = angle * spinScale
    },
  }
}
