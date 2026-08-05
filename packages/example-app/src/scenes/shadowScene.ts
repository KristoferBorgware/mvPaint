// Shadow showcase. Every shadow here is baked into the shared shadow atlas once and drawn
// as a single textured quad, so the whole scene costs one extra draw call however many
// shadows it contains.
//
// The bottom row walks the parameters one at a time; the overlapping cards above exist to
// show STACKING, which is the part a flattened shadow layer cannot do: each card's shadow
// falls on the card behind it and is hidden by the card in front, resolved per-pixel by the
// depth test rather than by draw order.

import { Circle, Polyline, Rect, MSDFText, type ColorInput, type Scene } from '@mvpaint/engine'
import { DARK, SLATE } from './palette'
import type { SceneContent } from './types'

const CARD_FILL: ColorInput[] = [
  '#f56b59',
  '#59adf0',
  '#73d18c',
]

function label(scene: Scene, x: number, y: number, text: string): void {
  scene.root.addChild(
    new MSDFText({ name: `label-${text}`, x, y, text, style: { fontSize: 20, color: SLATE } }),
  )
}

export function buildShadowScene(scene: Scene): SceneContent {
  const root = scene.root

  scene.root.addChild(
    new MSDFText({
      name: 'shadow-title',
      x: -430,
      y: 330,
      text: 'Shadows',
      style: { fontStyle: 'bold', fontSize: 44, color: DARK },
    }),
  )

  // --- overlapping cards: each shadow lands on the card behind it -----------------------
  //
  // Made RIGHT TO LEFT, so the leftmost card is the one in front. That direction is the whole
  // reason this row shows anything: these shadows are cast down and to the right, and each
  // card's neighbour in that direction is the next one along - so the shadow only has
  // somewhere to land if the caster is the card IN FRONT. Built left to right, every shadow
  // would fall behind the card that comes next and be covered by it, and the row would look
  // like three cards with one shadow at the end.
  for (let i = CARD_FILL.length - 1; i >= 0; i--) {
    root.addChild(
      new Rect({
        name: `card-${i}`,
        // A Rect's position is its top-left corner, so the card hangs down and right of it.
        x: -390 + i * 130,
        y: 230 - i * 40,
        width: 260,
        height: 180,
        fill: CARD_FILL[i],
        shadowOffsetX: 10,
        shadowOffsetY: 18,
        shadowBlur: 28,
        shadowOpacity: 0.45,
      }),
    )
  }
  label(scene, -430, 260, 'Overlapping: each shadow falls on the card behind it')

  // --- one parameter at a time ----------------------------------------------------------
  const y = -140
  label(scene, -430, y + 106, 'Offset only, then blur, then spread, then fill-only')

  root.addChild(
    new Rect({
      name: 'shadow-offset-only',
      x: -415,
      y: y + 65,
      width: 130,
      height: 130,
      fill: '#d9d9e0',
      // No blur: a hard, offset copy - what canvas gives you with shadowBlur left at 0.
      shadowOffsetX: 12,
      shadowOffsetY: 14,
      shadowOpacity: 0.55,
    }),
  )

  root.addChild(
    new Rect({
      name: 'shadow-blur',
      x: -225,
      y: y + 65,
      width: 130,
      height: 130,
      fill: '#d9d9e0',
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
      fill: '#d9d9e0',
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
      fill: '#d9d9e0',
      stroke: '#40404c',
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
      stroke: '#734cbf',
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
