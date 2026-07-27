// Mesh-lane basics: gradient fills (linear and radial), stroking with joins and caps, and
// per-frame animation. The two rects spin about their own centres, driven by the app's
// rotation-speed control.

import { Circle, Polyline, Rect, type Scene } from '@mvpaint/engine'
import type { SceneContent } from './types'

export function buildShapesScene(scene: Scene): SceneContent {
  const spins = new Map<Rect, number>()

  // Two rects side by side, filled + stroked, spinning about their centers. Sized in
  // pixel-equivalent world units.
  const left = scene.root.addChild(
    new Rect({
      name: 'rect-left',
      x: -110,
      y: 0,
      width: 160,
      height: 160,
      fill: [0.9, 0.28, 0.24, 1],
      stroke: [0.5, 0.1, 0.08, 1],
      strokeWidth: 6,
    }),
  )
  // Linear gradient across the rect's own diagonal, in its local (pre-transform)
  // space - it moves and rotates with the rect.
  left.fillPriority = 'linear-gradient'
  left.fillLinearGradientStartPoint = { x: -80, y: -80 }
  left.fillLinearGradientEndPoint = { x: 80, y: 80 }
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
