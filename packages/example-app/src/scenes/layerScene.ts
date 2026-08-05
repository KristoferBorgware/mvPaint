// Layers: an optional container with one switch, and none of a group's other opinions.
//
// A layer here is not a canvas, not a render target, and not a draw-order
// boundary - the whole scene is drawn in one pass and zIndex decides what is on top, scene-
// wide. So the four sections below are each about what a layer does and does NOT do:
//
//   top left      three layers of one picture, each switching its slice off with `enabled`
//   top right     two layers interleaving by zIndex, which a stack of canvases could not do
//   bottom left   the same four blocks in a group and in a layer - click them and compare
//   bottom right  a layer's transform reaches its contents, and `enabled` never touches a
//                 shape's own `visible`

import { Circle, Group, Layer, Polyline, Rect, MSDFText, type ColorInput, type Scene } from '@mvpaint/engine'
import { CRIMSON, DARK, NAVY, SLATE, TEAL } from './palette'
import type { SceneContent } from './types'

function label(x: number, y: number, text: string): MSDFText {
  return new MSDFText({ x, y, text, style: { fontSize: 15, color: SLATE } })
}

function caption(x: number, y: number, text: string): MSDFText {
  return new MSDFText({ x, y, text, style: { fontSize: 13, color: SLATE } })
}

export function buildLayerScene(scene: Scene): SceneContent {
  const root = scene.root

  // --- three layers of one picture ------------------------------------------------------
  //
  // A schematic drawn in three passes, each its own layer. Nothing about the drawing needs a
  // layer - every shape could sit at the root and look identical - but with them, a whole
  // slice of it switches off in one assignment, and the render/pick walk turns back at the
  // layer rather than asking each of its shapes about its ancestors.
  const plate = root.addChild(new Layer({ name: 'plate' }))
  plate.addChild(
    new Rect({ x: -470, y: 280, width: 380, height: 170, fill: '#edf2f5', cornerRadius: 10 }),
  )
  plate.addChild(new Circle({ x: -370, y: 175, radius: 42, fill: '#c7dee6' }))
  plate.addChild(new Rect({ x: -230, y: 250, width: 110, height: 60, fill: '#d9e3db', cornerRadius: 6 }))

  const routes = root.addChild(new Layer({ name: 'routes' }))
  routes.addChild(
    new Polyline({
      points: [
        { x: -460, y: 140 },
        { x: -380, y: 190 },
        { x: -280, y: 165 },
        { x: -190, y: 215 },
        { x: -100, y: 200 },
      ],
      stroke: TEAL,
      strokeWidth: 5,
      lineJoin: 'round',
      lineCap: 'round',
    }),
  )
  routes.addChild(
    new Polyline({
      points: [
        { x: -410, y: 275 },
        { x: -350, y: 200 },
        { x: -330, y: 130 },
        { x: -240, y: 120 },
      ],
      stroke: '#d98c33',
      strokeWidth: 5,
      lineJoin: 'round',
      lineCap: 'round',
    }),
  )

  const pins = root.addChild(new Layer({ name: 'pins' }))
  for (const [x, y] of [
    [-380, 190],
    [-280, 165],
    [-190, 215],
  ]) {
    pins.addChild(new Circle({ x, y, radius: 9, fill: CRIMSON, stroke: '#fff', strokeWidth: 3 }))
  }

  root.addChild(caption(-470, 104, 'plate / routes / pins'))
  root.addChild(label(-470, 84, 'three layers of one picture - each switches its slice off'))

  // --- two layers, one stack ------------------------------------------------------------
  //
  // THE point of the design. `cool` is added first and `warm` second, so a stack of canvases
  // would draw all of cool behind all of warm: three teal cards, then three orange ones. Here
  // the cards interleave, because a layer contributes no ordering at all and the only thing
  // deciding depth is each card's own zIndex - exactly as if the layers were not there.
  const cool = root.addChild(new Layer({ name: 'cool' }))
  const warm = root.addChild(new Layer({ name: 'warm' }))
  const COOL: ColorInput = '#218c99'
  const WARM: ColorInput = '#e6802e'

  for (let i = 0; i < 6; i++) {
    const even = i % 2 === 0
    const host = even ? cool : warm
    host.addChild(
      new Rect({
        name: `card-${i}`,
        x: 90 + i * 58,
        y: 270,
        width: 120,
        height: 150,
        fill: even ? COOL : WARM,
        stroke: '#fff',
        strokeWidth: 3,
        cornerRadius: 8,
        // No zIndex at all: made left to right, so each card takes a higher number from the
        // counter than the one before and overlaps it. Which layer a card is in has nothing
        // to do with it, which is the point.
      }),
    )
  }

  root.addChild(caption(90, 104, 'cool layer added first, warm second'))
  root.addChild(label(90, 84, 'they alternate anyway - zIndex decides, not the layer'))

  // --- a group is a unit; a layer is not ------------------------------------------------
  //
  // Identical rows, one in each container. Click a block in the group and the whole assembly
  // is selected and framed, and a drag moves all four; click one in the layer and you get
  // that block alone. Nothing in the app treats them differently - closestGroup() and
  // outermostGroup() simply walk straight past a Layer, because a Layer is not a Group.
  const asGroup = root.addChild(new Group({ name: 'as-a-group', x: -430, y: -110 }))
  const asLayer = root.addChild(new Layer({ name: 'as-a-layer', x: -430, y: -230 }))

  for (let i = 0; i < 4; i++) {
    const shared = { y: 0, width: 62, height: 62, cornerRadius: 8 }
    asGroup.addChild(new Rect({ name: `grouped-${i}`, ...shared, x: i * 74, fill: NAVY }))
    asLayer.addChild(new Rect({ name: `layered-${i}`, ...shared, x: i * 74, fill: TEAL }))
  }

  root.addChild(caption(-130, -140, 'in a Group: click one, get all four'))
  root.addChild(caption(-130, -260, 'in a Layer: click one, get that one'))
  root.addChild(label(-470, -300, 'the same four blocks in each container - click them and compare'))

  // --- the transform reaches the contents, and `enabled` is the layer's own --------------
  //
  // The layer slides, and everything in it slides with it - it carries a transform because
  // every Node does. The blinking dot is the second point: `enabled` is a property OF THE
  // LAYER and is never written onto its children, so when the layer comes back the dot is in
  // whatever state its own `visible` is in, rather than being forced back on with the rest.
  const drifting = root.addChild(new Layer({ name: 'drifting', x: 235, y: -180 }))
  drifting.addChild(new Rect({ x: -20, y: 40, width: 250, height: 80, fill: '#e6e8ed', cornerRadius: 12 }))
  const dots: Circle[] = []
  for (let i = 0; i < 3; i++) {
    dots.push(drifting.addChild(new Circle({ x: 30 + i * 75, y: 0, radius: 22, fill: i === 1 ? CRIMSON : DARK })))
  }
  const blinker = dots[1]

  root.addChild(label(160, -300, 'the strip slides; the red dot keeps its own visible'))

  let t = 0
  return {
    onFrame: (dt, speed) => {
      t += dt * speed

      // Two layers of the schematic, on different cycles, so the picture is sometimes whole,
      // sometimes routes-only, sometimes bare plate.
      routes.enabled = Math.sin(t * 0.7) > -0.35
      pins.enabled = Math.sin(t * 1.1 + 1.6) > -0.2

      // The layer's own transform, which its contents follow without knowing anything moved.
      drifting.x = 235 + Math.sin(t * 0.9) * 45

      // The dot blinks on its own fast cycle; the layer switches on a slower one. The two do
      // not interact: when the layer returns, the dot is wherever its own cycle has it.
      blinker.visible = Math.sin(t * 4) > 0
      drifting.enabled = Math.sin(t * 0.5 + 2.2) > -0.5
    },
  }
}
