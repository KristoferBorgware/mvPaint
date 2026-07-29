// Self-test for the image lane's pure half: the corner texture coordinates an Image samples,
// from its crop, fit, tiling and flipping (image/imageUv.ts). No GPU, no DOM - the texture
// upload and the batcher need a device and are covered in the browser instead. Run with:
//   npx tsx src/image/selfTest.ts

import { imageUvRect } from './imageUv'

let count = 0
function assert(cond: boolean, msg: string): void {
  count++
  if (!cond) throw new Error(`[image] self-test FAILED: ${msg}`)
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
const rect = (r: { u0: number; v0: number; u1: number; v1: number }) =>
  `${r.u0.toFixed(3)},${r.v0.toFixed(3)} -> ${r.u1.toFixed(3)},${r.v1.toFixed(3)}`

// --- the whole image by default ---
{
  const uv = imageUvRect({ textureWidth: 200, textureHeight: 100, quadWidth: 200, quadHeight: 100 })
  assert(rect(uv) === '0.000,0.000 -> 1.000,1.000', 'with nothing set, the quad samples the whole image')

  // A quad of a different shape still samples all of it - 'fill' stretches, by definition.
  const stretched = imageUvRect({ textureWidth: 200, textureHeight: 100, quadWidth: 50, quadHeight: 400 })
  assert(rect(stretched) === '0.000,0.000 -> 1.000,1.000', "'fill' samples everything whatever the quad's shape")
}

// --- crop: a rectangle of the source, in pixels ---
{
  const uv = imageUvRect({
    textureWidth: 200,
    textureHeight: 100,
    quadWidth: 100,
    quadHeight: 50,
    crop: { x: 50, y: 25, width: 100, height: 50 },
  })
  assert(rect(uv) === '0.250,0.250 -> 0.750,0.750', 'a crop becomes the matching fraction of the image')

  // The sprite-sheet case: four frames across, take the third.
  const frame = imageUvRect({
    textureWidth: 400,
    textureHeight: 100,
    quadWidth: 100,
    quadHeight: 100,
    crop: { x: 200, y: 0, width: 100, height: 100 },
  })
  assert(rect(frame) === '0.500,0.000 -> 0.750,1.000', 'one frame out of a strip is a quarter of the width')
}

// --- fit: 'cover' trims the axis with too much image, about the centre ---
{
  // A wide image in a square quad: the sides go, the full height stays.
  const wide = imageUvRect({ textureWidth: 200, textureHeight: 100, quadWidth: 100, quadHeight: 100, fit: 'cover' })
  assert(near(wide.v0, 0) && near(wide.v1, 1), 'covering a square with a wide image keeps its full height')
  assert(near(wide.u0, 0.25) && near(wide.u1, 0.75), 'and takes the middle half of its width')
  assert(near(wide.u0 + wide.u1, 1), 'trimmed evenly, so what shows is centred')

  // A tall image in a square quad: the reverse.
  const tall = imageUvRect({ textureWidth: 100, textureHeight: 200, quadWidth: 100, quadHeight: 100, fit: 'cover' })
  assert(near(tall.u0, 0) && near(tall.u1, 1), 'covering a square with a tall image keeps its full width')
  assert(near(tall.v0, 0.25) && near(tall.v1, 0.75), 'and takes the middle half of its height')

  // Matching aspects need no trim at all.
  const same = imageUvRect({ textureWidth: 200, textureHeight: 100, quadWidth: 400, quadHeight: 200, fit: 'cover' })
  assert(rect(same) === '0.000,0.000 -> 1.000,1.000', 'an image already the quad shape is not trimmed')

  // 'cover' composes with a crop: it trims the CROPPED rectangle, not the whole image.
  const cropped = imageUvRect({
    textureWidth: 400,
    textureHeight: 400,
    quadWidth: 100,
    quadHeight: 100,
    crop: { x: 0, y: 0, width: 400, height: 200 },
    fit: 'cover',
  })
  assert(near(cropped.v0, 0) && near(cropped.v1, 0.5), 'the crop still bounds what cover can show')
  assert(near(cropped.u0, 0.25) && near(cropped.u1, 0.75), 'and cover trims within it')
}

// --- tiling runs the coordinates past 1, which the wrap mode then resolves ---
{
  const uv = imageUvRect({ textureWidth: 64, textureHeight: 64, quadWidth: 256, quadHeight: 256, tileX: 4, tileY: 4 })
  assert(rect(uv) === '0.000,0.000 -> 4.000,4.000', 'tiling scales the span, leaving the anchored corner put')

  // Tiling a crop repeats just that part - one sprite as a pattern.
  const tiledCrop = imageUvRect({
    textureWidth: 100,
    textureHeight: 100,
    quadWidth: 200,
    quadHeight: 100,
    crop: { x: 50, y: 0, width: 50, height: 100 },
    tileX: 2,
  })
  assert(near(tiledCrop.u0, 0.5) && near(tiledCrop.u1, 1.5), 'a tiled crop repeats from where the crop starts')

  const perAxis = imageUvRect({ textureWidth: 10, textureHeight: 10, quadWidth: 30, quadHeight: 10, tileX: 3 })
  assert(near(perAxis.u1, 3) && near(perAxis.v1, 1), 'the axes tile independently')
}

// --- flipping mirrors the result, last ---
{
  const x = imageUvRect({ textureWidth: 10, textureHeight: 10, quadWidth: 10, quadHeight: 10, flipX: true })
  assert(rect(x) === '1.000,0.000 -> 0.000,1.000', 'flipX swaps the horizontal coordinates')

  const y = imageUvRect({ textureWidth: 10, textureHeight: 10, quadWidth: 10, quadHeight: 10, flipY: true })
  assert(rect(y) === '0.000,1.000 -> 1.000,0.000', 'flipY swaps the vertical ones')

  const both = imageUvRect({ textureWidth: 10, textureHeight: 10, quadWidth: 10, quadHeight: 10, flipX: true, flipY: true })
  assert(rect(both) === '1.000,1.000 -> 0.000,0.000', 'and both together turn it around')

  // Applied after everything else, so it mirrors what is actually visible.
  const flippedCrop = imageUvRect({
    textureWidth: 100,
    textureHeight: 100,
    quadWidth: 50,
    quadHeight: 100,
    crop: { x: 0, y: 0, width: 50, height: 100 },
    flipX: true,
  })
  assert(near(flippedCrop.u0, 0.5) && near(flippedCrop.u1, 0), 'flipping a crop mirrors the crop, not the whole image')
}

// --- a source with no area cannot produce coordinates, and must not produce NaN ---
{
  for (const [w, h] of [
    [0, 100],
    [100, 0],
    [0, 0],
    [-10, 10],
  ]) {
    const uv = imageUvRect({ textureWidth: w, textureHeight: h, quadWidth: 10, quadHeight: 10 })
    assert(rect(uv) === '0.000,0.000 -> 1.000,1.000', `a ${w}x${h} source falls back to the unit square`)
    assert(
      Number.isFinite(uv.u0) && Number.isFinite(uv.v0) && Number.isFinite(uv.u1) && Number.isFinite(uv.v1),
      `a ${w}x${h} source produces no NaN`,
    )
  }

  // A zero-area QUAD is legitimate (a collapsed node) and must not divide by zero either.
  const collapsed = imageUvRect({ textureWidth: 100, textureHeight: 100, quadWidth: 0, quadHeight: 0, fit: 'cover' })
  assert(Number.isFinite(collapsed.u0) && Number.isFinite(collapsed.u1), 'a zero-area quad produces no NaN under cover')
}

console.log(`[image] self-test passed (${count} assertions)`)
