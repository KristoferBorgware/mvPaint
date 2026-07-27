// Shadow showcase. Every shadow here is baked into the shared shadow atlas once and drawn
// as a single textured quad, so the whole scene costs one extra draw call however many
// shadows it contains.
//
// The bottom row walks the parameters one at a time; the overlapping cards above exist to
// show STACKING, which is the part a flattened shadow layer cannot do: each card's shadow
// falls on the card behind it and is hidden by the card in front, resolved per-pixel by the
// depth test rather than by draw order.

import { Circle, Polyline, Rect, Text, type Scene } from '@mvpaint/engine'
import { DARK, SLATE } from './palette'
import type { SceneContent } from './types'

const CARD_FILL: [number, number, number, number][] = [
  [0.96, 0.42, 0.35, 1],
  [0.35, 0.68, 0.94, 1],
  [0.45, 0.82, 0.55, 1],
]

function label(scene: Scene, x: number, y: number, text: string): void {
  scene.root.addChild(
    new Text({ name: `label-${text}`, x, y, text, style: { fontSize: 20, color: SLATE } }),
  )
}

export function buildShadowScene(scene: Scene): SceneContent {
  const root = scene.root

  scene.root.addChild(
    new Text({
      name: 'shadow-title',
      x: -430,
      y: 330,
      text: 'Shadows',
      style: { fontStyle: 'bold', fontSize: 44, color: DARK },
    }),
  )

  // --- overlapping cards: each shadow lands on the card behind it -----------------------
  CARD_FILL.forEach((fill, i) => {
    root.addChild(
      new Rect({
        name: `card-${i}`,
        x: -260 + i * 130,
        y: 140 - i * 40,
        width: 260,
        height: 180,
        fill,
        // Later cards sit in front, so their shadows fall on the earlier ones.
        zIndex: i,
        shadowOffsetX: 10,
        shadowOffsetY: 18,
        shadowBlur: 28,
        shadowOpacity: 0.45,
      }),
    )
  })
  label(scene, -430, 260, 'Overlapping: each shadow falls on the card behind it')

  // --- one parameter at a time ----------------------------------------------------------
  const y = -140
  label(scene, -430, y + 120, 'Offset only, then blur, then spread, then fill-only')

  root.addChild(
    new Rect({
      name: 'shadow-offset-only',
      x: -350,
      y,
      width: 130,
      height: 130,
      fill: [0.85, 0.85, 0.88, 1],
      // No blur: a hard, offset copy - what canvas gives you with shadowBlur left at 0.
      shadowOffsetX: 12,
      shadowOffsetY: 14,
      shadowOpacity: 0.55,
    }),
  )

  root.addChild(
    new Rect({
      name: 'shadow-blur',
      x: -160,
      y,
      width: 130,
      height: 130,
      fill: [0.85, 0.85, 0.88, 1],
      // shadowBlur is the canvas blur radius: a Gaussian of sigma = blur/2.
      shadowOffsetX: 12,
      shadowOffsetY: 14,
      shadowBlur: 30,
      shadowOpacity: 0.55,
    }),
  )

  root.addChild(
    new Circle({
      name: 'shadow-spread',
      x: 40,
      y,
      radius: 65,
      fill: [0.85, 0.85, 0.88, 1],
      // spread grows the silhouette before the blur softens it - CSS box-shadow's spread,
      // which the canvas model has no equivalent for.
      shadowOffsetY: 10,
      shadowBlur: 20,
      shadowSpread: 14,
      shadowOpacity: 0.5,
    }),
  )

  // A thick stroke with shadowForStrokeEnabled off: the shadow is cast from the fill
  // outline alone, so the heavy ring doesn't fatten it.
  root.addChild(
    new Circle({
      name: 'shadow-fill-only',
      x: 240,
      y,
      radius: 55,
      fill: [0.85, 0.85, 0.88, 1],
      stroke: [0.25, 0.25, 0.3, 1],
      strokeWidth: 20,
      shadowOffsetY: 14,
      shadowBlur: 18,
      shadowOpacity: 0.55,
      shadowForStrokeEnabled: false,
    }),
  )

  // A stroked-only shape still casts from its stroke, since that is all the geometry there
  // is - a good check that the silhouette follows the geometry rather than the fill flag.
  root.addChild(
    new Polyline({
      name: 'shadow-polyline',
      points: [
        { x: 360, y: y - 60 },
        { x: 420, y: y + 40 },
        { x: 480, y: y - 40 },
        { x: 540, y: y + 60 },
      ],
      closed: false,
      stroke: [0.45, 0.3, 0.75, 1],
      strokeWidth: 16,
      lineJoin: 'round',
      lineCap: 'round',
      shadowOffsetX: 6,
      shadowOffsetY: 12,
      shadowBlur: 16,
      shadowOpacity: 0.5,
    }),
  )

  return {}
}
