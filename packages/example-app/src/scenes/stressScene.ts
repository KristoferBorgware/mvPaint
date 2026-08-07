// Stress test: over a thousand independently shadowed shapes, all drifting.
//
// This is the scene that justifies the shadow atlas. Every shadow here has its own baked
// silhouette (the blur radius varies per shape, so they cannot share one), yet the whole
// field draws in a single call and re-bakes nothing while it animates - the drift only
// moves the quads. Zoom out to bring the whole grid on screen; the culling still applies,
// so what you see is what is actually being drawn.
//
// At this size the silhouettes no longer fit a 4096-texel atlas, so loading the scene also
// exercises the grow-and-repack path a couple of times over - which is worth having a scene
// for, since that path is otherwise hard to reach by hand.

import { Circle, Rect, MSDFText, type Scene } from '@mvpaint/engine'
import { DARK, SLATE } from './palette'
import type { SceneContent } from './types'

const COLUMNS = 48
const ROWS = 28
const SPACING = 78

export function buildStressScene(scene: Scene): SceneContent {
  const root = scene.root
  const movers: { node: Circle | Rect; baseX: number; baseY: number; phase: number }[] = []

  const originX = (-(COLUMNS - 1) * SPACING) / 2
  const originY = -((ROWS - 1) * SPACING) / 2

  for (let i = 0; i < COLUMNS * ROWS; i++) {
    const col = i % COLUMNS
    const row = Math.floor(i / COLUMNS)
    const baseX = originX + col * SPACING
    const baseY = originY + row * SPACING
    const hue = (col / COLUMNS) * 0.6 + 0.15
    const shared = {
      x: baseX,
      y: baseY,
      fill: [hue, 0.45 + 0.3 * (row / ROWS), 0.9 - 0.4 * (col / COLUMNS), 1] as [number, number, number, number],
      // Varying the blur per shape is the point: each needs its own atlas slot, so this is
      // genuinely N cached textures rather than one reused everywhere.
      shadowOffsetX: 5,
      shadowOffsetY: 8,
      shadowBlur: 6 + (i % 6) * 5,
      shadowOpacity: 0.45,
    }
    const node =
      i % 2 === 0
        ? root.addChild(new Circle({ name: `stress-${i}`, radius: 22, ...shared }))
        : // Pivoted at its middle so the squares sit on the same centres as the circles
          // they alternate with, and orbit the same way - a Rect's own origin is its
          // top-left corner.
          root.addChild(new Rect({ name: `stress-${i}`, width: 40, height: 40, offsetX: 20, offsetY: 20, ...shared }))
    movers.push({ node, baseX, baseY, phase: (i % 17) * 0.37 })
  }

  root.addChild(
    new MSDFText({
      name: 'stress-title',
      x: originX,
      // The top row does not stop at originY: every shape carries its own radius and drifts
      // another 12 on top of that, so the heading starts above all three.
      y: originY - 106,
      text: `${COLUMNS * ROWS} shadows, one draw call`,
      style: { fontStyle: 'bold', fontSize: 34, color: DARK },
    }),
  )
  root.addChild(
    new MSDFText({
      name: 'stress-note',
      x: originX,
      y: originY - 62,
      text: 'Each has its own baked silhouette; the drift re-bakes none of them.',
      style: { fontSize: 18, color: SLATE },
    }),
  )

  let t = 0
  return {
    onFrame: (dt, speed) => {
      if (speed <= 0) return
      t += dt * speed
      for (const m of movers) {
        m.node.x = m.baseX + Math.cos(t + m.phase) * 12
        m.node.y = m.baseY - Math.sin(t * 0.8 + m.phase) * 12
      }
    },
  }
}
