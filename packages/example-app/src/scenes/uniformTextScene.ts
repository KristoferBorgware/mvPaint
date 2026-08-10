// UniformMSDFText and UniformVectorText: one style for the whole string, in node attributes.
//
// What the scene is showing is that every label below is driven by an ATTRIBUTE ON THE NODE - a
// `fill`, a `fontSize`, a `textDecoration` - and not by a run style object. On a plain MSDFText
// the first of those does nothing at all, which is why the second column prints the two side by
// side: same string, same assignments, one of them listening.
//
// The animated label is the demonstration that matters most. An attribute written every frame
// re-shapes the node, so this is a live surface rather than a constructor convenience.

import {
  MSDFText,
  Rect,
  UniformMSDFText,
  UniformVectorText,
  type FontProvider,
  type Scene,
  type SceneResources,
} from '@mvpaint/engine'
import { INTER, loadVectorFonts } from '../fonts'
import { CRIMSON, DARK, NAVY, SLATE, TEAL } from './palette'
import type { SceneContent } from './types'

let ready = false

/** The outline atlases, for the two nodes drawn through the mesh lane. */
export async function prepareUniformTextScene(): Promise<void> {
  await loadVectorFonts()
  ready = true
}

function caption(x: number, y: number, text: string, maxWidth?: number): MSDFText {
  return new MSDFText({ x, y, text, maxWidth, lineHeight: 1.3, style: { fontSize: 14, color: SLATE } })
}

function heading(x: number, y: number, text: string): MSDFText {
  return new MSDFText({ x, y, text, style: { fontStyle: 'bold', fontSize: 20, color: DARK } })
}

export function buildUniformTextScene(scene: Scene, resources: SceneResources): SceneContent {
  const root = scene.root
  // What an MSDF node measures against - see SceneResources.msdfFonts. Every node here is the
  // default family, so one provider serves them all.
  const provider: FontProvider = resources.msdfFonts.resolveFamily(undefined)

  // --- one attribute per label ---------------------------------------------------------------
  root.addChild(heading(-560, -320, 'Every attribute on the node'))
  root.addChild(
    caption(-560, -292, 'each of these is a property assignment after construction - no run style anywhere', 480),
  )

  const attributes: { name: string; apply: (label: UniformMSDFText) => void }[] = [
    { name: 'fill', apply: (label) => { label.fill = CRIMSON } },
    { name: 'fontSize', apply: (label) => { label.fontSize = 34 } },
    { name: 'fontStyle', apply: (label) => { label.fontStyle = 'italic bold' } },
    { name: 'textDecoration', apply: (label) => { label.textDecoration = 'underline' } },
    { name: 'letterSpacing', apply: (label) => { label.letterSpacing = 6 } },
    { name: 'stroke', apply: (label) => { label.stroke = NAVY; label.strokeWidth = 1 } },
  ]
  attributes.forEach((attribute, i) => {
    const label = new UniformMSDFText({
      name: `uniform-${attribute.name}`,
      x: -560,
      y: -244 + i * 48,
      text: attribute.name,
      fontSize: 26,
    })
    attribute.apply(label)
    root.addChild(label)
  })

  // --- the same string, styled both ways -------------------------------------------------------
  //
  // The lower one is a plain MSDFText given the SAME assignment. It does nothing there - a text
  // lane paints from the run, and `Shape.fill` is not part of that - which is exactly the
  // mismatch this class removes.
  //
  // It also prints a warning to the console, on purpose. Assigning a fill that goes nowhere is
  // what the warning exists to catch, so a scene demonstrating the mismatch demonstrates the
  // warning with it - the console line here is part of the exhibit, not a fault in it.
  root.addChild(heading(-40, -320, 'Against a plain MSDFText'))
  root.addChild(caption(-40, -292, 'both told fill = crimson; only one of them is listening', 420))

  const listening = new UniformMSDFText({ name: 'uniform-vs', x: -40, y: -244, text: 'UniformMSDFText', fontSize: 30 })
  listening.fill = CRIMSON
  root.addChild(listening)

  const plain = new MSDFText({ name: 'plain-vs', x: -40, y: -196, text: 'MSDFText', style: { fontSize: 30, color: DARK } })
  plain.fill = CRIMSON
  root.addChild(plain)
  root.addChild(caption(-40, -150, 'the second one kept its run colour, because that is where its colour lives', 420))

  // --- padding, drawn at the size the node reports ----------------------------------------------
  //
  // A plate behind each label, sized from getTextWidth/getTextHeight rather than from a guess, so
  // padding is visible as the gap it makes: the block grows, the glyphs move in from its corner.
  root.addChild(heading(-560, 30, 'padding grows the block'))
  root.addChild(caption(-560, 58, 'each plate is drawn at the size its label measures - getTextWidth() and getTextHeight()', 480))

  ;[0, 10, 24].forEach((padding, i) => {
    const label = new UniformMSDFText({
      name: `uniform-padded-${padding}`,
      x: -560 + i * 175,
      y: 104,
      text: `padding ${padding}`,
      fontSize: 18,
      padding,
    })
    root.addChild(
      new Rect({
        name: `uniform-plate-${padding}`,
        x: label.x,
        y: label.y,
        width: label.getTextWidth(provider),
        height: label.getTextHeight(provider),
        fill: '#dfe5ee',
        cornerRadius: 4,
        zIndex: -1,
      }),
    )
    root.addChild(label)
  })

  // --- measuring a string the node is not currently drawing --------------------------------------
  const sizer = new UniformMSDFText({ name: 'uniform-sizer', x: -560, y: 180, text: 'measureSize', fontSize: 18 })
  root.addChild(sizer)
  const measured = sizer.measureSize('a much longer string than this one', provider)
  root.addChild(
    caption(-560, 210, `measureSize('a much longer string than this one') = ${Math.round(measured.width)} x ${Math.round(measured.height)} - without disturbing the node`, 480),
  )

  // --- the outline class --------------------------------------------------------------------------
  root.addChild(heading(-560, 268, 'The same attributes, drawn as outlines'))
  root.addChild(
    caption(-560, 296, 'UniformVectorText tessellates real contours through the mesh lane, so it is picked per glyph and casts a real blurred shadow', 480),
  )

  if (ready) {
    const outlined = new UniformVectorText({
      fontFamily: INTER,
      name: 'uniform-outline',
      x: -560,
      y: 336,
      text: 'outlines',
      fontSize: 54,
      fontStyle: 'bold',
      fill: TEAL,
    })
    outlined.stroke = NAVY
    outlined.strokeWidth = 1.5
    outlined.shadowColor = 'rgba(0,0,0,0.35)'
    outlined.shadowBlur = 10
    outlined.shadowOffsetY = 5
    root.addChild(outlined)
    // It holds its own fonts, so measuring needs nothing passed in.
    root.addChild(caption(-560, 410, `getTextWidth() = ${Math.round(outlined.getTextWidth())} - measured with no provider, since the outlines are on the node`, 480))
  }

  // --- animation: an attribute written every frame --------------------------------------------------
  root.addChild(heading(-40, 30, 'Written every frame'))
  root.addChild(caption(-40, 58, 'fontSize and letterSpacing animate; each assignment rebuilds the run and re-shapes', 420))

  const pulsing = root.addChild(
    new UniformMSDFText({ name: 'uniform-pulse', x: -40, y: 104, text: 'live', fontSize: 30, fill: NAVY }),
  )

  let elapsed = 0
  return {
    onFrame: (dt, speed) => {
      elapsed += dt * speed
      pulsing.fontSize = 30 + Math.sin(elapsed * 2) * 14
      pulsing.letterSpacing = 3 + Math.sin(elapsed * 1.3) * 3
    },
  }
}
