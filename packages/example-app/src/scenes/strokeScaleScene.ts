// Two readings of what a stroke width means, side by side under the same transforms.
//
// Left of each pair is the default: a stroke is a local-space measurement like every other
// coordinate, so scaling the node scales the outline with it and the whole shape zooms as one
// picture. Right is `strokeScaleEnabled: false`, where the outline holds the width it was
// given whatever the node does - a keyline, a selection frame, a hairline on a drawing.
//
// Every pair below is the SAME shape with the same strokeWidth, differing in that one flag,
// so any difference between the halves is the flag's doing.
//
// The bottom right is the case that decides how this had to be implemented. A 4:1 stretch
// does not thicken a diagonal by 4 or by 1 but by something between, and by a different amount
// for every direction around the shape - so a fixed-width stroke cannot be had by dividing the
// width by a number. The ribbon is built through the transform instead, which gets every
// direction right at once.

import { Circle, Group, Path, Rect, Text, type Scene } from '@mvpaint/engine'
import { CRIMSON, DARK, NAVY, SLATE, TEAL } from './palette'
import type { SceneContent } from './types'

function label(x: number, y: number, text: string): Text {
  return new Text({ x, y, text, style: { fontSize: 15, color: SLATE } })
}

function caption(x: number, y: number, text: string): Text {
  return new Text({ x, y, text, style: { fontSize: 13, color: SLATE } })
}

/** A star, centred on its own origin - corners sharp enough to show what a join does. */
function star(fixed: boolean): Path {
  const points = Array.from({ length: 10 }, (_, i) => {
    const radius = i % 2 === 0 ? 46 : 20
    const angle = Math.PI / 2 + (Math.PI * i) / 5
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
  })
  return new Path({
    contours: [{ points, closed: true }],
    fill: '#ffd75e',
    stroke: '#8a5a00',
    strokeWidth: 4,
    lineJoin: 'round',
    strokeScaleEnabled: !fixed,
  })
}

/** A circle as a path, so the 4:1 stretch below has an outline running in every direction. */
function ring(fixed: boolean): Path {
  const points = Array.from({ length: 48 }, (_, i) => {
    const a = (i / 48) * Math.PI * 2
    return { x: Math.cos(a) * 34, y: Math.sin(a) * 34 }
  })
  return new Path({
    contours: [{ points, closed: true }],
    fill: '#d6ece9',
    stroke: TEAL,
    strokeWidth: 4,
    strokeScaleEnabled: !fixed,
  })
}

export function buildStrokeScaleScene(scene: Scene): SceneContent {
  const root = scene.root

  root.addChild(
    new Text({ x: -520, y: 340, text: 'Stroke and scale', style: { fontStyle: 'bold', fontSize: 40, color: DARK } }),
  )
  root.addChild(label(-520, 306, 'each pair is one shape twice, differing only in strokeScaleEnabled'))

  // --- growing and shrinking --------------------------------------------------------------
  //
  // The same star at three sizes. Left of each pair the outline grows with the shape; right of
  // it the outline is the same 4 units wide in all three, which is what a keyline means.
  const SCALES = [0.6, 1.15, 1.7]
  SCALES.forEach((scale, i) => {
    const centre = -400 + i * 360
    for (const fixed of [false, true]) {
      const node = star(fixed)
      node.x = centre + (fixed ? 90 : -90)
      node.y = 185
      node.scaleX = scale
      node.scaleY = scale
      root.addChild(node)
    }
    root.addChild(caption(centre - 14, 74, `${scale}x`))
  })

  root.addChild(label(-520, 40, 'the same star at three scales - the left half of each pair scales its outline, the right half keeps it'))

  // --- inside a scaled group ----------------------------------------------------------------
  //
  // Neither of these was scaled itself; their parent was. A keyline that only compensated for
  // its own scaleX would be wrong here by exactly the group's, which is why what is measured
  // is the WORLD transform.
  const nested = root.addChild(new Group({ name: 'zoomed', x: -330, y: -40, scaleX: 2.2, scaleY: 2.2 }))
  nested.addChild(
    new Rect({ x: -70, y: 26, width: 52, height: 52, fill: '#dbe4f0', stroke: NAVY, strokeWidth: 3, cornerRadius: 6 }),
  )
  nested.addChild(
    new Rect({
      x: 18,
      y: 26,
      width: 52,
      height: 52,
      fill: '#dbe4f0',
      stroke: NAVY,
      strokeWidth: 3,
      cornerRadius: 6,
      strokeScaleEnabled: false,
    }),
  )
  root.addChild(caption(-90, -30, 'group scaled 2.2x'))
  root.addChild(label(-520, -130, 'neither of these was scaled - their group was, and the right one still holds 3'))

  // --- a live resize -------------------------------------------------------------------------
  //
  // The one that costs something. A shape whose stroke must not follow its scale has geometry
  // that depends on that scale, so a scale that changes every frame is a re-tessellation every
  // frame - the only case here where the flag is not free.
  const breathing = [false, true].map((fixed) => {
    const circle = new Circle({
      x: -400 + (fixed ? 160 : 0),
      y: -250,
      radius: 46,
      fill: '#f2d9e0',
      stroke: CRIMSON,
      strokeWidth: 5,
      strokeScaleEnabled: !fixed,
    })
    return root.addChild(circle)
  })
  root.addChild(caption(-520, -350, 'animated: the right outline is re-tessellated every frame - the only case here that is not free'))

  // --- the case a single number cannot fix ---------------------------------------------------
  //
  // Stretched 4:1. On the left the outline is thick across the stretch and thin along it; on
  // the right it is even the whole way round, which is only possible because the ribbon is
  // built through the transform rather than scaled by a factor.
  ;[false, true].forEach((fixed, i) => {
    const stretched = ring(fixed)
    stretched.x = 90 + i * 300
    stretched.y = -250
    stretched.scaleX = 4
    root.addChild(stretched)
  })
  root.addChild(caption(60, -350, 'stretched 4:1 - even the whole way round only on the right'))

  let t = 0
  return {
    onFrame: (dt, speed) => {
      t += dt * speed
      const scale = 1 + Math.sin(t * 1.1) * 0.55
      for (const node of breathing) {
        node.scaleX = scale
        node.scaleY = scale
      }
    },
  }
}
