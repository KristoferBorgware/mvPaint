// Images: a textured quad per node, drawn through the image lane. Shows what an Image can
// say about which part of its picture appears and how - cropping a sprite out of a sheet,
// covering a frame of a different shape, tiling with a repeating or mirrored wrap, flipping,
// tinting, and nearest-neighbour filtering for pixel art - plus that an image casts a shadow
// and interleaves with ordinary shapes and text by zIndex rather than by lane.
//
// The textures are drawn here with a 2D canvas and uploaded as raw pixels, so the scene
// carries no asset and doubles as the worked example of ImageTexture.fromPixels(). It goes
// through getImageData() rather than handing the canvas straight to fromSource() because
// Chromium will not copy from a canvas that was never in the document. A real application
// would more often reach for ImageTexture.load(url).

import { Circle, Image, ImageTexture, Rect, Text, type Scene } from '@mvpaint/engine'
import { DARK } from './palette'
import type { SceneContent } from './types'

/** A checkerboard with a coloured border, so cropping and tiling are both easy to read. */
function checkerPixels(size: number, squares: number): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  const step = size / squares
  for (let y = 0; y < squares; y++) {
    for (let x = 0; x < squares; x++) {
      const even = (x + y) % 2 === 0
      ctx.fillStyle = even ? '#2f6fb5' : '#e8eef5'
      ctx.fillRect(x * step, y * step, step, step)
    }
  }
  // A border makes a tile's edge obvious, which is the whole point of the wrap examples.
  ctx.strokeStyle = '#e8443f'
  ctx.lineWidth = Math.max(2, size / 32)
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, size - ctx.lineWidth, size - ctx.lineWidth)
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

/** Four distinct frames in a row, for the crop/sprite-sheet example. */
function spriteStripPixels(frameSize: number, frames: number): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = frameSize * frames
  canvas.height = frameSize
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  const colors = ['#e8443f', '#f0a830', '#3fa85c', '#7a53c1']
  for (let i = 0; i < frames; i++) {
    ctx.fillStyle = colors[i % colors.length]
    ctx.fillRect(i * frameSize, 0, frameSize, frameSize)
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${frameSize * 0.6}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(i + 1), i * frameSize + frameSize / 2, frameSize / 2)
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

/** A tiny, deliberately blocky sprite, to show off nearest-neighbour filtering. */
function pixelArtPixels(): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = 8
  canvas.height = 8
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  const rows = [
    '..1111..',
    '.111111.',
    '11122111',
    '11122111',
    '11111111',
    '11333311',
    '.113311.',
    '..1111..',
  ]
  const palette: Record<string, string> = { '1': '#f0a830', '2': '#2f2f2f', '3': '#e8443f' }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const key = rows[y][x]
      if (key === '.') continue
      ctx.fillStyle = palette[key]
      ctx.fillRect(x, y, 1, 1)
    }
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

function label(x: number, y: number, text: string): Text {
  return new Text({ x, y, text, style: { fontStyle: 'bold', fontSize: 15, color: DARK } })
}

export function buildImageScene(scene: Scene, device: GPUDevice): SceneContent {
  const root = scene.root
  const toTexture = (data: ImageData, label: string) =>
    ImageTexture.fromPixels(device, data.data, data.width, data.height, undefined, label)
  const checker = toTexture(checkerPixels(256, 8), 'checker')
  const strip = toTexture(spriteStripPixels(64, 4), 'sprites')
  const pixels = toTexture(pixelArtPixels(), 'pixel-art')

  // Row 1: the picture as it is, then two ways of meeting a frame it does not fit.
  root.addChild(label(-520, 250, 'as-is'))
  root.addChild(new Image({ name: 'image-plain', texture: checker, x: -450, y: 160, width: 140, height: 140 }))

  root.addChild(label(-330, 250, "fill (stretched)"))
  root.addChild(new Image({ name: 'image-fill', texture: checker, x: -250, y: 160, width: 200, height: 110, fit: 'fill' }))

  root.addChild(label(-90, 250, 'cover (trimmed)'))
  root.addChild(new Image({ name: 'image-cover', texture: checker, x: -10, y: 160, width: 200, height: 110, fit: 'cover' }))

  // A shadow, cast from the quad - see Image's header for why it is the quad and not the alpha.
  root.addChild(label(180, 250, 'shadow'))
  root.addChild(
    new Image({
      name: 'image-shadow',
      texture: checker,
      x: 260,
      y: 160,
      width: 140,
      height: 140,
      rotation: 0.12,
      shadowColor: [0, 0, 0, 0.45],
      shadowBlur: 18,
      shadowOffsetX: 10,
      shadowOffsetY: 12,
    }),
  )

  // Row 2: cropping one frame out of a sheet.
  root.addChild(label(-520, 60, 'crop: sprite sheet'))
  for (let i = 0; i < 4; i++) {
    root.addChild(
      new Image({
        name: `image-sprite-${i + 1}`,
        texture: strip,
        x: -470 + i * 90,
        y: -20,
        width: 76,
        height: 76,
        crop: { x: i * 64, y: 0, width: 64, height: 64 },
      }),
    )
  }

  // Row 2 continued: tiling, which needs a repeating wrap to show more than one tile.
  root.addChild(label(-60, 60, 'tile 3x3, wrap repeat'))
  root.addChild(
    new Image({
      name: 'image-tiled',
      texture: checker,
      x: 30,
      y: -20,
      width: 180,
      height: 180,
      tileX: 3,
      tileY: 3,
      wrapX: 'repeat',
      wrapY: 'repeat',
    }),
  )

  root.addChild(label(160, 60, 'tile 3x3, wrap mirror'))
  root.addChild(
    new Image({
      name: 'image-mirrored',
      texture: checker,
      x: 250,
      y: -20,
      width: 180,
      height: 180,
      tileX: 3,
      tileY: 3,
      wrapX: 'mirror',
      wrapY: 'mirror',
    }),
  )

  // Row 3: flipping, tinting, and filtering.
  root.addChild(label(-520, -150, 'flipX'))
  root.addChild(
    new Image({ name: 'image-flipped', texture: strip, x: -450, y: -230, width: 120, height: 120, crop: { x: 0, y: 0, width: 64, height: 64 }, flipX: true }),
  )

  root.addChild(label(-330, -150, 'tint + fade'))
  root.addChild(
    new Image({ name: 'image-tinted', texture: checker, x: -250, y: -230, width: 120, height: 120, tint: [1, 0.6, 0.3, 0.75] }),
  )

  root.addChild(label(-140, -150, 'nearest (pixel art)'))
  root.addChild(new Image({ name: 'image-nearest', texture: pixels, x: -50, y: -230, width: 120, height: 120, filter: 'nearest' }))

  root.addChild(label(60, -150, 'linear (same 8x8)'))
  root.addChild(new Image({ name: 'image-linear', texture: pixels, x: 150, y: -230, width: 120, height: 120, filter: 'linear' }))

  // An image is an ordinary scene node: it stacks with shapes and text by zIndex, and a
  // higher one wins whichever lane drew it.
  root.addChild(label(280, -150, 'zIndex vs shapes'))
  root.addChild(new Rect({ name: 'image-z-rect', x: 350, y: -230, width: 130, height: 130, fill: [0.18, 0.65, 0.36, 1], zIndex: 1 }))
  root.addChild(new Image({ name: 'image-z-under', texture: strip, x: 390, y: -200, width: 100, height: 100, crop: { x: 128, y: 0, width: 64, height: 64 }, zIndex: 0 }))
  root.addChild(new Circle({ name: 'image-z-circle', x: 420, y: -270, radius: 34, fill: [0.9, 0.3, 0.5, 0.9], zIndex: 2 }))

  // A spinning image, to show that a transform never rebuilds the lane's geometry.
  const spinner = root.addChild(
    new Image({ name: 'image-spinning', texture: strip, x: 470, y: 160, width: 110, height: 110, crop: { x: 64, y: 0, width: 64, height: 64 } }),
  )
  root.addChild(label(400, 250, 'spinning'))

  return {
    onFrame: (dt, speed) => {
      spinner.rotation += dt * speed
    },
  }
}
