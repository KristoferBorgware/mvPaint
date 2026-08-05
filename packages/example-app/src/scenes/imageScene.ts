// Images: a textured quad per node, drawn through the image lane. Shows what an Image can
// say about which part of its picture appears and how - cropping a sprite out of a sheet,
// covering a frame of a different shape, tiling with a repeating or mirrored wrap, flipping,
// tinting, and nearest-neighbour filtering for pixel art - plus that an image casts a shadow
// and interleaves with ordinary shapes and text by zIndex rather than by lane.
//
// The textures are drawn here with a 2D canvas and uploaded as raw pixels, so the scene
// carries no asset and doubles as the worked example of images.fromPixels(). It goes
// through getImageData() rather than handing the canvas straight to fromSource() because
// Chromium will not copy from a canvas that was never in the document. A real application
// would more often reach for images.load(url).
//
// The last row comes from an inline SVG through images.fromSvg() instead, at two
// different pixel sizes, since choosing that size is the one decision rasterizing a document
// forces on you.

import { Circle, Image, Rect, MSDFText, type ImageTexture, type Scene, type SceneResources } from '@mvpaint/engine'
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

// An SVG source, inline. Everything it needs is in the document because the browser
// rasterizes an <img>-loaded SVG without fetching anything external - no webfonts, no linked
// images. It carries a viewBox and no width/height, which is the common shape for an icon and
// the case where the target size is entirely the caller's to pick.
const BADGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f0a830"/>
      <stop offset="1" stop-color="#e8443f"/>
    </linearGradient>
  </defs>
  <circle cx="32" cy="32" r="30" fill="url(#g)"/>
  <path d="M32 12 L38 26 L53 27 L41 36 L45 51 L32 42 L19 51 L23 36 L11 27 L26 26 Z" fill="#ffffff"/>
  <circle cx="32" cy="32" r="30" fill="none" stroke="#2f2f2f" stroke-width="3"/>
</svg>`

// Rasterized once and reused across scene rebuilds: fromSvg is asynchronous, so it happens in
// prepare() rather than in build(), and re-rasterizing the same document on every switch back
// would be wasted work. The two scales are the point of the pair - same document, same size on
// screen, different numbers of pixels behind it.
let svgTextures: { coarse: ImageTexture; fine: ImageTexture } | null = null

export async function prepareImageScene({ images }: SceneResources): Promise<void> {
  if (svgTextures) return
  const [coarse, fine] = await Promise.all([
    images.fromSvg(BADGE_SVG, { width: 24, height: 24, label: 'badge-24' }),
    images.fromSvg(BADGE_SVG, { width: 128, height: 128, scale: 2, label: 'badge-256' }),
  ])
  svgTextures = { coarse, fine }
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

function label(x: number, y: number, text: string): MSDFText {
  return new MSDFText({ x, y, text, style: { fontStyle: 'bold', fontSize: 15, color: DARK } })
}

export function buildImageScene(scene: Scene, { images }: SceneResources): SceneContent {
  const root = scene.root
  const toTexture = (data: ImageData, label: string) =>
    images.fromPixels(data.data, data.width, data.height, label)
  const checker = toTexture(checkerPixels(256, 8), 'checker')
  const strip = toTexture(spriteStripPixels(64, 4), 'sprites')
  const pixels = toTexture(pixelArtPixels(), 'pixel-art')

  // Row 1: the picture as it is, then two ways of meeting a frame it does not fit.
  root.addChild(label(-520, 250, 'as-is'))
  root.addChild(new Image({ name: 'image-plain', texture: checker, x: -520, y: 230, width: 140, height: 140 }))

  root.addChild(label(-330, 250, "fill (stretched)"))
  root.addChild(new Image({ name: 'image-fill', texture: checker, x: -350, y: 215, width: 200, height: 110, fit: 'fill' }))

  root.addChild(label(-90, 250, 'cover (trimmed)'))
  root.addChild(new Image({ name: 'image-cover', texture: checker, x: -110, y: 215, width: 200, height: 110, fit: 'cover' }))

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
      // Pivoted at its middle so it leans in place; a Rect or Image turns about its
      // top-left corner otherwise.
      offsetX: 70,
      offsetY: -70,
      rotation: 0.12,
      shadowColor: '#00000073',
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
        x: -508 + i * 90,
        y: 18,
        width: 76,
        height: 76,
        crop: { x: i * 64, y: 0, width: 64, height: 64 },
      }),
    )
  }

  // Row 2 continued: tiling, which needs a repeating wrap to show more than one tile.
  root.addChild(label(-60, 74, 'tile 3x3, wrap repeat'))
  root.addChild(
    new Image({
      name: 'image-tiled',
      texture: checker,
      x: -60,
      y: 50,
      width: 180,
      height: 180,
      tileX: 3,
      tileY: 3,
      wrapX: 'repeat',
      wrapY: 'repeat',
    }),
  )

  root.addChild(label(160, 74, 'tile 3x3, wrap mirror'))
  root.addChild(
    new Image({
      name: 'image-mirrored',
      texture: checker,
      x: 160,
      y: 50,
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
    new Image({ name: 'image-flipped', texture: strip, x: -510, y: -170, width: 120, height: 120, crop: { x: 0, y: 0, width: 64, height: 64 }, flipX: true }),
  )

  root.addChild(label(-330, -150, 'tint + fade'))
  root.addChild(
    new Image({ name: 'image-tinted', texture: checker, x: -310, y: -170, width: 120, height: 120, tint: '#ff994cbf' }),
  )

  root.addChild(label(-140, -150, 'nearest (pixel art)'))
  root.addChild(new Image({ name: 'image-nearest', texture: pixels, x: -110, y: -170, width: 120, height: 120, filter: 'nearest' }))

  root.addChild(label(60, -150, 'linear (same 8x8)'))
  root.addChild(new Image({ name: 'image-linear', texture: pixels, x: 90, y: -170, width: 120, height: 120, filter: 'linear' }))

  // An image is an ordinary scene node: it stacks with shapes and text like anything else,
  // and whichever is in front wins regardless of which lane drew it. Made back to front -
  // image, then rect over it, then circle over both - so the stack is just the order these
  // three lines are in.
  root.addChild(label(280, -126, 'stacking vs shapes'))
  root.addChild(new Image({ name: 'image-z-under', texture: strip, x: 340, y: -150, width: 100, height: 100, crop: { x: 128, y: 0, width: 64, height: 64 } }))
  root.addChild(new Rect({ name: 'image-z-rect', x: 285, y: -165, width: 130, height: 130, fill: '#2ea65c' }))
  root.addChild(new Circle({ name: 'image-z-circle', x: 420, y: -270, radius: 34, fill: '#e64c80e6' }))

  // Row 4: an SVG as the source. Both quads are the same size on screen and come from the
  // same document; only the pixel size they were rasterized at differs, which is the whole
  // trade of this route. Vectors would be sharp at any zoom - loadSvgDocument does that -
  // but each one costs geometry, whereas these are a quad apiece however complex the artwork.
  if (svgTextures) {
    root.addChild(label(-520, -340, 'svg rasterized at 24px'))
    root.addChild(new Image({ name: 'image-svg-coarse', texture: svgTextures.coarse, x: -515, y: -355, width: 130, height: 130 }))

    root.addChild(label(-330, -340, 'svg rasterized at 256px'))
    root.addChild(new Image({ name: 'image-svg-fine', texture: svgTextures.fine, x: -315, y: -355, width: 130, height: 130 }))

    // Nothing about the source makes it a special kind of image: it tiles, tints and casts a
    // shadow like any other texture.
    root.addChild(label(-140, -340, 'svg tiled 2x2'))
    root.addChild(
      new Image({
        name: 'image-svg-tiled',
        texture: svgTextures.fine,
        x: -115,
        y: -355,
        width: 130,
        height: 130,
        tileX: 2,
        tileY: 2,
        wrapX: 'repeat',
        wrapY: 'repeat',
      }),
    )

    root.addChild(label(60, -322, 'svg with a shadow'))
    root.addChild(
      new Image({
        name: 'image-svg-shadow',
        texture: svgTextures.fine,
        x: 150,
        y: -420,
        width: 130,
        height: 130,
        offsetX: 65,
        offsetY: -65,
        rotation: -0.15,
        shadowColor: '#00000073',
        shadowBlur: 16,
        shadowOffsetX: 8,
        shadowOffsetY: 10,
      }),
    )
  }

  // A spinning image, to show that a transform never rebuilds the lane's geometry.
  const spinner = root.addChild(
    new Image({ name: 'image-spinning', texture: strip, x: 470, y: 160, width: 110, height: 110, offsetX: 55, offsetY: -55, crop: { x: 64, y: 0, width: 64, height: 64 } }),
  )
  root.addChild(label(400, 250, 'spinning'))

  return {
    onFrame: (dt, speed) => {
      spinner.rotation += dt * speed
    },
    // The three textures this build made, and only those: the SVG pair above is memoized
    // across builds (see prepare) and handed out again next time, so destroying it here
    // would leave the next load drawing from a released texture.
    dispose: () => {
      checker.destroy()
      strip.destroy()
      pixels.destroy()
    },
  }
}
