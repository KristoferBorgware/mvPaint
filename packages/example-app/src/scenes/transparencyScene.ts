// Transparency across the render lanes: what you can see through, and what you cannot.
//
// Every lane blends straight alpha, so a translucent thing over another thing in the SAME
// lane composites correctly - the top row shows that for the mesh, text and image lanes in
// turn. The middle row is the interesting one: the same two objects, in two different
// lanes, stacked both ways round by zIndex. Each pair is a mirror image of the other, so
// anything that differs between the two halves is the lanes' doing rather than the shapes'.
//
// WHAT TO LOOK FOR. In every cell the BACK object is opaque and the FRONT one is
// translucent, so the back object should show through, tinted - in all twelve cells, both
// ways round, with no cell behaving differently from its mirror.
//
// What would break it is a translucent fragment writing depth: alpha blending and the depth
// test know nothing about each other, so a fragment at alpha 0.4 is still a fragment, and a
// pipeline that writes depth writes it. Whatever sat behind it would then be rejected
// outright and vanish inside the overlap rather than showing through. That is what the
// renderer's two passes are for - translucent objects are drawn last, furthest first,
// testing depth but never writing it (see the engine's webgpu/SceneRenderer).
//
// The bottom row is shadows, which are on the receiving end of the same question: a shadow
// never writes depth either, but it is still tested against what the opaque pass wrote.

import { Circle, Image, Rect, MSDFText, type Scene, type SceneResources } from '@mvpaint/engine'
import { NAVY, SLATE } from './palette'
import type { SceneContent } from './types'

/** How see-through the front object in every pair is. Low enough that a back object hiding
 * behind it is unmistakable rather than a subtle shift. */
const FRONT_ALPHA = 0.4

function label(x: number, y: number, text: string, color = SLATE): MSDFText {
  return new MSDFText({ x, y, text, style: { fontSize: 14, color } })
}

function heading(x: number, y: number, text: string): MSDFText {
  return new MSDFText({ x, y, text, style: { fontSize: 17, fontStyle: 'bold', color: NAVY } })
}

/** A solid checkerboard - opaque everywhere, so it works as a BACK object. */
function checkerPixels(size: number, squares: number): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  const step = size / squares
  for (let y = 0; y < squares; y++) {
    for (let x = 0; x < squares; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#2f6fb5' : '#e8eef5'
      ctx.fillRect(x * step, y * step, step, step)
    }
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

/**
 * A checkerboard whose pale squares are FULLY transparent rather than pale - holes, not
 * light patches. Used for the last cell: an alpha-0 texel is still a fragment, and whether
 * it writes depth is a different question from whether it draws any colour.
 */
function holedCheckerPixels(size: number, squares: number): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.clearRect(0, 0, size, size)
  const step = size / squares
  for (let y = 0; y < squares; y++) {
    for (let x = 0; x < squares; x++) {
      if ((x + y) % 2 !== 0) continue
      ctx.fillStyle = '#2f6fb5'
      ctx.fillRect(x * step, y * step, step, step)
    }
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

const CELL_W = 150
const CELL_H = 100

export function buildTransparencyScene(scene: Scene, resources?: SceneResources): SceneContent {
  const root = scene.root
  if (!resources) return {}
  const { images } = resources

  const checker = images.fromPixels(checkerPixels(256, 8).data, 256, 256, 'transparency-checker')
  const holed = images.fromPixels(holedCheckerPixels(256, 8).data, 256, 256, 'transparency-holes')

  // --- row 1: within one lane, which is the control ------------------------------------
  //
  // Three overlapping translucent objects of the SAME kind, made back to front - which is
  // all the stacking any of these rows needs, since an unset zIndex takes the next number
  // from the counter and each object therefore lands in front of the one before it. A lane
  // packs its shapes back-to-front, so every overlap is a real blend. If any of these three
  // cells looks wrong, nothing below it means anything.
  const rowY = 330
  root.addChild(heading(-540, rowY + 40, 'One lane at a time - every overlap should blend'))

  for (let i = 0; i < 3; i++) {
    root.addChild(
      new Circle({
        name: `mesh-blend-${i}`,
        x: -470 + i * 46,
        y: rowY - 60 + (i % 2) * 30,
        radius: 46,
        fill: [i === 0 ? 0.9 : 0.1, i === 1 ? 0.75 : 0.15, i === 2 ? 0.9 : 0.2, 0.55],
      }),
    )
  }
  // rowY - 180, not -160: the image cells hang 110 below their own y, so a caption any higher
  // than this sits inside the pictures it is naming.
  root.addChild(label(-500, rowY - 180, 'mesh lane'))

  for (let i = 0; i < 3; i++) {
    root.addChild(
      new MSDFText({
        name: `text-blend-${i}`,
        x: -230 + i * 30,
        y: rowY - 30 - i * 26,
        text: 'BLEND',
        style: { fontSize: 46, fontStyle: 'bold', color: [i === 0 ? 0.9 : 0.15, i === 1 ? 0.7 : 0.2, i === 2 ? 0.9 : 0.25, 0.55] },
      }),
    )
  }
  root.addChild(label(-230, rowY - 180, 'text lane'))

  for (let i = 0; i < 3; i++) {
    root.addChild(
      new Image({
        name: `image-blend-${i}`,
        texture: checker,
        x: 60 + i * 50,
        y: rowY - 60 + (i % 2) * 30,
        width: 110,
        height: 110,
        tint: [i === 0 ? 1 : 0.4, i === 1 ? 1 : 0.4, i === 2 ? 1 : 0.5, 0.55],
      }),
    )
  }
  root.addChild(label(60, rowY - 180, 'image lane'))

  // --- row 2: the same two objects in two lanes, stacked both ways ----------------------
  //
  // Each pair gets two cells that are exact mirrors: same two objects, same overlap, only
  // the ORDER THEY ARE MADE IN swapped, so whichever was behind is now in front. In both cells the
  // FRONT object is the translucent one and the BACK object is opaque, so in both cells the
  // back object should show through. If one half of a pair looks different from the other,
  // that difference is the lane order, because nothing else about them differs - and the
  // point of the pairing is that it should not.
  const midY = 20
  root.addChild(heading(-540, midY + 100, 'Across two lanes - in every cell the back object should show through'))

  type LaneKind = 'mesh' | 'text' | 'image'

  /**
   * One object of the given lane, placed so that two of them at the same centre overlap
   * across roughly half their area. `alpha` is the whole point: the front object of a pair
   * gets FRONT_ALPHA, the back one is opaque.
   */
  const makeObject = (kind: LaneKind, name: string, cx: number, cy: number, alpha: number) => {
    const rgb: [number, number, number] = alpha < 1 ? [0.13, 0.33, 0.78] : [0.87, 0.35, 0.16]
    if (kind === 'mesh') {
      return new Circle({ name, x: cx, y: cy, radius: 56, fill: [...rgb, alpha] })
    }
    if (kind === 'text') {
      return new MSDFText({
        name,
        x: cx - 72,
        y: cy + 24,
        text: 'ABC',
        style: { fontSize: 54, fontStyle: 'bold', color: [...rgb, alpha] },
      })
    }
    return new Image({
      name,
      texture: checker,
      x: cx - CELL_W / 2,
      y: cy + CELL_H / 2,
      width: CELL_W,
      height: CELL_H,
      tint: [1, 1, 1, alpha],
    })
  }

  /**
   * Which pass an object of this kind ends up in. Only the mesh lane can prove itself
   * opaque, so an opaque mesh shape is the one thing here drawn first, batched, and writing
   * depth; everything else waits for the translucent pass. Both cells of a pair should look
   * the same however this falls out, which is what the pairing is testing.
   */
  const passOf = (kind: LaneKind, alpha: number) => (kind === 'mesh' && alpha >= 1 ? 'opaque' : 'translucent')

  /** Two objects at one centre: `back` opaque and behind, `front` translucent and over it. */
  const cell = (id: string, cx: number, cy: number, back: LaneKind, front: LaneKind) => {
    // Made back first, so the front one takes the higher number and lands over it.
    root.addChild(makeObject(back, `pair-${id}-back-${back}`, cx - 26, cy + 20, 1))
    root.addChild(makeObject(front, `pair-${id}-front-${front}`, cx + 26, cy - 20, FRONT_ALPHA))
    root.addChild(label(cx - 96, cy - 96, `${front} over ${back}`, NAVY))
    // Two words, not a sentence: the cells are 180 apart, and the fuller wording this used to
    // carry ran ~230 wide and reached into the next cell's caption.
    root.addChild(label(cx - 96, cy - 116, `back: ${passOf(back, 1)} pass`))
  }

  ;([
    ['mesh', 'image'],
    ['text', 'image'],
    ['mesh', 'text'],
  ] as [LaneKind, LaneKind][]).forEach(([a, b], i) => {
    const cx = -400 + i * 380
    // The pair both ways round. Whichever is in front is the translucent one.
    cell(`${i}a`, cx, midY, a, b)
    cell(`${i}b`, cx + 180, midY, b, a)
  })

  // --- row 3: shadows, which never write depth but are still tested against it ----------
  //
  // A shadow is merged into the translucent pass half a depth step behind the shape casting
  // it, so it lands on whatever is below and its own caster paints over it.
  const lowY = -236
  root.addChild(heading(-540, lowY + 96, 'Shadows'))

  // A shadow cast by one shape, with a translucent panel laid over where it falls.
  root.addChild(
    new Circle({
      name: 'shadow-caster',
      x: -430,
      y: lowY,
      radius: 46,
      fill: '#339973',
      shadowColor: '#0000008c',
      shadowBlur: 26,
      shadowOffsetX: 26,
      shadowOffsetY: 26,
    }),
  )
  root.addChild(
    new Rect({
      name: 'shadow-over-panel',
      x: -380,
      y: lowY - 10,
      width: 150,
      height: 90,
      fill: [0.95, 0.75, 0.2, FRONT_ALPHA],
    }),
  )
  root.addChild(label(-470, lowY - 116, 'a shadow under a translucent panel'))

  // The same shadow, but the thing laid over it is an image with real holes in it. An
  // alpha-0 texel still produces a fragment; whether it writes depth decides whether the
  // shadow survives inside the holes.
  root.addChild(
    new Circle({
      name: 'shadow-caster-holes',
      x: -110,
      y: lowY,
      radius: 46,
      fill: '#339973',
      shadowColor: '#0000008c',
      shadowBlur: 26,
      shadowOffsetX: 26,
      shadowOffsetY: 26,
    }),
  )
  root.addChild(
    new Image({
      name: 'shadow-over-holes',
      texture: holed,
      x: -60,
      y: lowY - 10,
      width: 150,
      height: 90,
    }),
  )
  root.addChild(label(-150, lowY - 116, 'and under an image with transparent holes'))

  // Two shadows overlapping each other, which is the case the shadow lane is built for:
  // it draws last and never writes depth, so shadows accumulate rather than clip.
  for (let i = 0; i < 3; i++) {
    root.addChild(
      new Circle({
        name: `shadow-stack-${i}`,
        x: 240 + i * 54,
        y: lowY + (i % 2) * 26,
        radius: 40,
        fill: [0.35 + i * 0.2, 0.4, 0.75, 0.6],
        shadowColor: '#00000080',
        shadowBlur: 22,
        shadowOffsetX: 18,
        shadowOffsetY: 18,
      }),
    )
  }
  root.addChild(label(220, lowY - 116, 'translucent shapes, each casting its own shadow'))

  // Both textures are built per load and belong to this scene alone - a switch away is the
  // last anything sees of them, so this is where they go back to the GPU.
  return {
    dispose: () => {
      checker.destroy()
      holed.destroy()
    },
  }
}
