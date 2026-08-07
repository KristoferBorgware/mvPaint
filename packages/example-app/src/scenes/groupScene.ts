// Groups: containers that place themselves, and are sized by what they hold.
//
// Every assembly here is a Group. Click any part of one and the whole thing is selected and
// framed - the frame fits the group's contents, because that is all a group's extent ever
// is. Drag any part and the assembly moves together, with the parts' own x/y untouched.
//
// Covers the group transform reaching its contents (position, rotation, scale), nesting,
// visibility governing a whole subtree, a group whose extent changes as its contents do,
// and the one case where a group is deliberately NOT the thing you grab.

import { Circle, Group, Rect, MSDFText, type ColorInput, type Scene } from '@mvpaint/engine'
import { CRIMSON, DARK, HIGHLIGHT, NAVY, SLATE, TEAL, withAlpha } from './palette'
import type { SceneContent } from './types'

// `maxWidth` is what keeps the bottom row's three captions apart: each is anchored under its
// own assembly, and left to run on one line the first two are wider than the gap to the next
// anchor and reach into the column beside them. Wrapping each inside its own column is the
// placement that survives the caption text changing.
function label(x: number, y: number, text: string, maxWidth?: number): MSDFText {
  return new MSDFText({ x, y, text, maxWidth, lineHeight: 1.25, style: { fontSize: 15, color: SLATE } })
}

/** A little robot: a body, a head, two eyes and two legs, built around its own origin. */
function robot(fill: ColorInput): Group {
  const g = new Group()
  g.addChild(new Rect({ x: -35, y: -20, width: 70, height: 60, fill, cornerRadius: 10 }))
  g.addChild(new Rect({ x: -22, y: -74, width: 44, height: 34, fill: NAVY, cornerRadius: 8 }))
  g.addChild(new Circle({ x: -10, y: -58, radius: 5, fill: '#fff' }))
  g.addChild(new Circle({ x: 10, y: -58, radius: 5, fill: '#fff' }))
  g.addChild(new Rect({ x: -26, y: 40, width: 16, height: 40, fill: DARK, cornerRadius: 5 }))
  g.addChild(new Rect({ x: 10, y: 40, width: 16, height: 40, fill: DARK, cornerRadius: 5 }))
  return g
}

export function buildGroupScene(scene: Scene): SceneContent {
  const root = scene.root

  // --- the group's transform reaches everything inside it -------------------------------
  //
  // Three copies of the same assembly, differing only in what their GROUP is set to. Not one
  // child knows it has been moved, turned or scaled: the group's matrix sits between theirs
  // and the world, which is the whole of what a group does.
  const plain = root.addChild(robot('#3d9eb2'))
  plain.name = 'robot-plain'
  plain.x = -420
  plain.y = -210

  const turned = root.addChild(robot('#d97333'))
  turned.name = 'robot-turned'
  turned.x = -220
  turned.y = -210
  turned.rotation = 20

  const shrunk = root.addChild(robot('#7359bf'))
  shrunk.name = 'robot-small'
  shrunk.x = -40
  shrunk.y = -210
  shrunk.scaleX = 0.6
  shrunk.scaleY = 0.6

  root.addChild(label(-470, -100, 'one assembly, three group transforms - click any part to take the whole'))

  // --- nesting: a group of groups -------------------------------------------------------
  //
  // The pair is a group holding two robot groups. Turning the OUTER one turns both, about
  // the pair's origin rather than each robot's - which is exactly what nesting buys.
  const pair = root.addChild(new Group({ name: 'pair', x: 300, y: -230, rotation: -10 }))
  const left = pair.addChild(robot('#33a666'))
  left.name = 'pair-left'
  left.x = -70
  const right = pair.addChild(robot('#bf4c73'))
  right.name = 'pair-right'
  right.x = 70
  right.scaleX = -1 // facing back the other way
  root.addChild(label(170, -100, 'a group of groups - the outer one turns both'))

  // --- sized by its contents ------------------------------------------------------------
  //
  // Nothing here sets a size. The group's extent is the union of what it holds, so the
  // outline below is drawn from group.bounds() every frame and simply follows along as the
  // orbiting shape swings out and back.
  const orbitGroup = root.addChild(new Group({ name: 'orbiting', x: -300, y: 180 }))
  orbitGroup.addChild(new Rect({ x: -60, y: -40, width: 120, height: 80, fill: TEAL, cornerRadius: 12 }))
  const satellite = orbitGroup.addChild(new Circle({ name: 'satellite', radius: 26, fill: CRIMSON }))

  // The patch showing that extent is a child of the SCENE, not of the group - a group that
  // measured its own outline would grow to contain it, and then grow again next frame.
  //
  // It is a UNIT quad that is only ever moved and scaled, never resized by its width and
  // height: those are baked into geometry, so resizing one every frame would repack the
  // whole mesh lane (see ARCHITECTURE.md). Driving it through the transform costs nothing.
  const extent = root.addChild(
    // Negative, which is how you say "behind everything": the counter every other shape
    // takes its zIndex from only ever counts up from zero.
    new Rect({ name: 'orbit-extent', width: 1, height: 1, fill: withAlpha(HIGHLIGHT, 0.18), zIndex: -2 }),
  )
  root.addChild(label(-470, 300, 'the tinted patch is group.bounds() - a group is only ever as big as what it holds', 440))

  // --- visibility governs the whole subtree ---------------------------------------------
  const blinking = root.addChild(new Group({ name: 'blinking', x: 120, y: 180 }))
  blinking.addChild(new Rect({ x: -70, y: -60, width: 140, height: 120, fill: NAVY, cornerRadius: 16 }))
  blinking.addChild(new Circle({ x: -30, y: 0, radius: 18, fill: '#fff' }))
  blinking.addChild(new Circle({ x: 30, y: 0, radius: 18, fill: '#fff' }))
  blinking.addChild(new Rect({ x: -40, y: 40, width: 80, height: 14, fill: CRIMSON, cornerRadius: 7 }))
  root.addChild(label(40, 300, 'group.visible = false hides everything inside it', 230))

  // --- a group that is not what you grab ------------------------------------------------
  //
  // draggable = false on the group means its parts are handles on themselves again: press a
  // block here and only that block moves. The group still frames and transforms as a unit -
  // this governs the drag, nothing else.
  const loose = root.addChild(new Group({ name: 'loose-parts', x: 400, y: 180, draggable: false }))
  for (let i = 0; i < 4; i++) {
    loose.addChild(
      new Rect({
        name: `loose-${i}`,
        x: -90 + i * 50,
        y: -30,
        width: 40,
        height: 60,
        fill: '#8c8c99',
        cornerRadius: 6,
      }),
    )
  }
  root.addChild(label(300, 300, 'draggable: false - the parts move on their own again', 250))

  let t = 0
  return {
    // The one group deliberately left undraggable - see the comment where it is built.
    keepDragOptOut: [loose],
    onFrame: (dt, speed) => {
      t += dt * speed

      // The satellite orbits, so the group's extent changes every frame with nothing told
      // to recompute anything.
      satellite.x = Math.cos(t) * 150
      satellite.y = -Math.sin(t) * 110 - 80

      // Re-fit the patch to whatever the group currently measures. bounds() is in the
      // group's own space, so the group's position is added to place it in the world. A
      // unit rect spans [0,1] x [0,1], so its origin goes to the box's top-left corner.
      const b = orbitGroup.bounds()
      if (b.valid()) {
        extent.x = orbitGroup.x + b.min.x
        extent.y = orbitGroup.y + b.min.y
        extent.scaleX = b.max.x - b.min.x
        extent.scaleY = b.max.y - b.min.y
      }

      // One group's visibility, toggled on a slow cycle - the whole subtree goes with it.
      blinking.visible = Math.sin(t * 1.5) > -0.4
    },
  }
}
