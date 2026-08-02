// Text on a path: a curve decides where each glyph sits and which way it faces.
//
// Covers the badge case a circle is usually wanted for (a run across the top and another
// along the bottom, both reading the right way up), an arc, a curve taken straight from SVG
// path data, what happens when the text is longer than the curve, decorations bending with
// the glyphs, and the same curve driving outline text through the mesh lane instead - the
// path is a shaping option, so it applies to both text implementations equally.
//
// The circles and arcs are drawn as ordinary Polylines underneath, so what the text is
// following is visible rather than implied.

import {
  Circle,
  Path,
  Text,
  VectorText,
  arcPath,
  circlePath,
  flattenPathData,
  loadDefaultVectorFonts,
  TextPathGeometry,
  type Point2,
  type Scene,
  type TextPathOptions,
  type VectorFonts,
} from '@mvpaint/engine'
import { CRIMSON, DARK, HIGHLIGHT, NAVY, SLATE, TEAL } from './palette'
import type { SceneContent } from './types'

let fonts: VectorFonts | null = null

/** The outline fonts, for the one node that draws its curved text through the mesh lane. */
export async function prepareTextPathScene(): Promise<void> {
  fonts = await loadDefaultVectorFonts()
}

/** Walks a curve end to end so it can be drawn as the polyline it already is. */
function outline(path: TextPathGeometry, step = 4): Point2[] {
  const points: Point2[] = []
  for (let d = 0; d <= path.length; d += step) {
    const p = path.sampleAt(d)
    if (p) points.push({ x: p.x, y: p.y })
  }
  return points
}

/** The curve itself, drawn faintly so it is clear what the glyphs are standing on. */
function guide(path: TextPathGeometry, name: string): Path {
  return new Path({
    name,
    contours: [{ points: outline(path), closed: path.closed }],
    filled: false,
    stroke: '#9ea8b8e6',
    strokeWidth: 1.5,
  })
}

function label(x: number, y: number, text: string): Text {
  return new Text({ x, y, text, style: { fontSize: 15, color: SLATE } })
}

export function buildTextPathScene(scene: Scene): SceneContent {
  const root = scene.root

  // --- a badge: one run over the top, one under the bottom, both upright ---
  //
  // The top run rides the default clockwise circle, which stands glyphs on the outside. The
  // bottom run uses a counter-clockwise circle starting at the bottom, so it too reads left
  // to right with its letters the right way up - the same trick a real badge uses, and the
  // reason the direction of the curve is a property of the curve rather than of the text.
  const badgeCenter = { x: -390, y: 190 }
  const badgeRadius = 132
  const topRing = circlePath(badgeRadius, { center: badgeCenter })
  const bottomRing = circlePath(badgeRadius, { center: badgeCenter, startAngle: -Math.PI / 2, clockwise: false })

  root.addChild(guide(topRing, 'tp-badge-guide'))
  // Negative puts it behind everything: shapes that say nothing take their zIndex from a
  // counter that only ever counts up from zero.
  root.addChild(new Circle({ name: 'tp-badge-disc', x: badgeCenter.x, y: badgeCenter.y, radius: badgeRadius - 34, fill: '#f0f2f7', zIndex: -1 }))
  root.addChild(
    new Text({
      name: 'tp-badge-top',
      text: 'MVPAINT ENGINE',
      style: { fontStyle: 'bold', fontSize: 26, color: NAVY, letterSpacing: 2 },
      textPath: { path: topRing, align: 'center' },
    }),
  )
  root.addChild(
    new Text({
      name: 'tp-badge-bottom',
      text: 'WEBGPU 2D',
      style: { fontStyle: 'bold', fontSize: 22, color: CRIMSON, letterSpacing: 3 },
      // `offset` runs along the curve's LEFT normal, which is the direction the glyphs stand
      // in - outward on the clockwise top ring, inward on this counter-clockwise one. So a
      // negative offset here pushes the baseline outward, to where the ascenders then reach
      // back in to the ring: both runs end up occupying the same band around it.
      textPath: { path: bottomRing, align: 'center', offset: -20 },
    }),
  )
  root.addChild(label(badgeCenter.x - 60, badgeCenter.y - 175, 'circle, top and bottom'))

  // --- an arc: an open curve, so the text has ends to run off ---
  const archCenter = { x: -40, y: 150 }
  const arch = arcPath(150, Math.PI * 0.92, -Math.PI * 0.84, { center: archCenter })
  root.addChild(guide(arch, 'tp-arch-guide'))
  root.addChild(
    new Text({
      name: 'tp-arch',
      text: 'along an arc',
      style: { fontSize: 34, color: TEAL },
      textPath: { path: arch, align: 'center', startOffset: arch.length / 2, offset: 10 },
    }),
  )
  root.addChild(label(archCenter.x - 60, archCenter.y - 40, 'arc, centred on it'))

  // --- more text than curve: what does not fit is dropped at the end ---
  const shortArc = arcPath(120, Math.PI, -Math.PI / 2, { center: { x: 300, y: 120 } })
  root.addChild(guide(shortArc, 'tp-clip-guide'))
  root.addChild(
    new Text({
      name: 'tp-clipped',
      text: 'this sentence is far longer than the curve it was given',
      style: { fontSize: 22, color: DARK },
      textPath: { path: shortArc, offset: 6 },
    }),
  )
  root.addChild(label(200, 10, 'text longer than its curve is cut off'))

  // --- an arbitrary curve, straight out of SVG path data ---
  //
  // Anything an SVG path can describe can carry text: flattenPathData turns the data into
  // contours, which is exactly what the curve is built from.
  const wave = TextPathGeometry.fromContours(flattenPathData('M -470 -80 C -330 40, -190 -190, -40 -70 S 210 60, 360 -60'))
  root.addChild(guide(wave, 'tp-wave-guide'))
  root.addChild(
    new Text({
      name: 'tp-wave',
      text: 'a curve taken straight from SVG path data',
      style: { fontSize: 26, color: NAVY },
      textPath: { path: wave, startOffset: 12, offset: 8 },
    }),
  )
  root.addChild(label(-470, -130, 'any SVG path'))

  // --- decorations bend too ---
  //
  // An underline or a highlight is one long rectangle on a straight baseline and cannot
  // curve, so on a path it becomes a row of short ones that each follow their own part of it.
  const ringCenter = { x: -330, y: -320 }
  const decorated = circlePath(115, { center: ringCenter })
  root.addChild(guide(decorated, 'tp-decor-guide'))
  root.addChild(
    new Text({
      name: 'tp-decorated',
      runs: [
        { text: 'underlined ', style: { fontSize: 21, color: NAVY, underline: true } },
        { text: 'and highlighted', style: { fontSize: 21, color: DARK, highlight: HIGHLIGHT } },
      ],
      textPath: { path: decorated, align: 'center', offset: 6 },
    }),
  )
  root.addChild(label(ringCenter.x - 70, ringCenter.y - 150, 'rules and highlights follow it'))

  // --- two lines become two rings ---
  //
  // The first baseline lands on the curve and the rest keep their distance from it, so the
  // leading survives the mapping instead of every line collapsing onto the same curve.
  const ringsCenter = { x: 20, y: -320 }
  const rings = circlePath(120, { center: ringsCenter })
  root.addChild(guide(rings, 'tp-rings-guide'))
  root.addChild(
    new Text({
      name: 'tp-two-lines',
      text: 'first line\nsecond line',
      style: { fontSize: 19, color: TEAL },
      align: 'center',
      textPath: { path: rings, align: 'center', offset: 4 },
    }),
  )
  root.addChild(label(ringsCenter.x - 55, ringsCenter.y - 150, 'two lines, two rings'))

  // --- the same curve, drawn as outlines through the mesh lane ---
  //
  // The path is a shaping option, so it costs VectorText nothing to support: both text
  // implementations run the same shaper and read the same quads.
  const outlineCenter = { x: 370, y: -320 }
  const outlineRing = circlePath(118, { center: outlineCenter })
  root.addChild(guide(outlineRing, 'tp-outline-guide'))
  if (fonts) {
    root.addChild(
      new VectorText({
        fonts,
        name: 'tp-outline-text',
        text: 'OUTLINE GLYPHS',
        style: { fontStyle: 'bold', fontSize: 22, color: CRIMSON, strokeColor: NAVY, strokeWidth: 1.2, letterSpacing: 1 },
        textPath: { path: outlineRing, align: 'center', offset: 6 },
      }),
    )
  }
  root.addChild(label(outlineCenter.x - 60, outlineCenter.y - 150, 'the same, as outlines'))

  // --- animation: sliding the text along its curve, which re-shapes each frame ---
  const marqueeRing = circlePath(150, { center: { x: 370, y: 190 } })
  root.addChild(guide(marqueeRing, 'tp-marquee-guide'))
  const marquee = root.addChild(
    new Text({
      name: 'tp-marquee',
      text: 'travelling around the curve  .  ',
      style: { fontSize: 20, color: DARK },
      textPath: { path: marqueeRing, offset: 8 },
    }),
  )
  root.addChild(label(300, 10, 'startOffset animated'))

  let travelled = 0
  return {
    onFrame: (dt, speed) => {
      travelled += dt * speed * 60
      // A closed curve wraps, so the offset can grow without bound and never runs out.
      marquee.textPath = { ...(marquee.textPath as TextPathOptions), startOffset: travelled }
      marquee.markDirty()
    },
  }
}
