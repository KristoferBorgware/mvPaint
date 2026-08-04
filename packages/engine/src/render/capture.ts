// The backend-neutral half of a screenshot: what camera to draw through, how many pixels to
// draw into, and how to turn the bytes that come back into a canvas.
//
// Both render paths need all of this and none of it touches an API, so it lives here rather
// than twice. What each path implements for itself is only the part that is genuinely its own:
// getting a frame into an offscreen target and reading it back.

import { Camera2D } from '../camera/Camera2D'
import { parseColor, type RGBA } from './color'
import type { CaptureOptions } from '../systems/SceneRendererHandle'

/** Everything a render path needs to take one capture, with every default already resolved. */
export interface CapturePlan {
  /** The camera to draw through. Built here; the caller never supplies or attaches one. */
  camera: Camera2D
  /** The output size in pixels - the region's world size times the pixel ratio. */
  pixelWidth: number
  pixelHeight: number
  /**
   * The size to hand the camera when asking for a view-projection. This is the region in WORLD
   * units, NOT the pixel size, because Camera2D is sized in CSS pixels at zoom 1: giving it the
   * pixel size as well as a zoom would apply the ratio twice and capture a quarter of the
   * region at 2x. The pixel ratio belongs to the target's resolution and nowhere else.
   */
  viewWidth: number
  viewHeight: number
  /** Straight-alpha RGBA in 0..1 to clear with. Transparent unless asked otherwise. */
  background: readonly [number, number, number, number]
}

/**
 * The three things a capture's draw differs from a live frame's in - which camera, what view
 * size that camera covers, and what to clear to. Both render paths take exactly this, so the
 * two never drift on what a capture is allowed to change.
 */
export interface CaptureView {
  camera: Camera2D
  viewWidth: number
  viewHeight: number
  background: readonly [number, number, number, number]
}

const TRANSPARENT: RGBA = [0, 0, 0, 0]

/** The largest capture either backend will attempt, per side. See resolveCapture. */
export const MAX_CAPTURE_PIXELS = 8192

/**
 * Turns a caller's region into the camera and pixel size to draw it with, filling in every
 * default from what is currently on screen - so `toCanvas()` with no arguments means "what I
 * am looking at, at the size I am looking at it".
 *
 * `live` is the camera the scene is being drawn through and `viewport` its CSS size, which
 * together are the only thing a default can be derived from.
 */
export function resolveCapture(
  options: CaptureOptions,
  live: Camera2D,
  viewport: { width: number; height: number },
): CapturePlan {
  const pixelRatio = positive(options.pixelRatio, 1)

  // The region defaults to what the live camera shows, which is its own size divided by its
  // zoom - a camera zoomed to 2 covering an 800px viewport is looking at 400 world units.
  const width = positive(options.width, viewport.width / live.zoom)
  const height = positive(options.height, viewport.height / live.zoom)
  const x = options.x ?? live.x
  const y = options.y ?? live.y

  // Clamped rather than trusted. A texture bigger than the device allows fails deep inside the
  // backend with a message about attachments, which is a poor way to learn that a pixelRatio of
  // 50 was a typo; the aspect is preserved so the answer is still the picture that was asked
  // for, only smaller.
  const wanted = Math.max(width * pixelRatio, height * pixelRatio)
  const fit = wanted > MAX_CAPTURE_PIXELS ? MAX_CAPTURE_PIXELS / wanted : 1

  return {
    // zoom 1: the region's world size IS the view size (see viewWidth), and the pixel ratio is
    // expressed by the target's resolution instead. Rotation turns about the region's centre,
    // like any other camera rotation.
    camera: new Camera2D({ x, y, zoom: 1, rotation: options.rotation ?? 0 }),
    pixelWidth: Math.max(1, Math.round(width * pixelRatio * fit)),
    pixelHeight: Math.max(1, Math.round(height * pixelRatio * fit)),
    viewWidth: width,
    viewHeight: height,
    background: options.background ? parseColor(options.background) : TRANSPARENT,
  }
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Straight RGBA8 rows, top row first, into a canvas.
 *
 * Both backends land here with the same bytes, having each undone their own idea of which way
 * up a render target is (see each path's capture code) - so the flip, when one is needed, has
 * already happened by now and this is only ever the same short function.
 */
export function pixelsToCanvas(pixels: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Capture failed: could not get a 2D context to assemble the image in.')
  // The cast is TypeScript's, not the runtime's: lib.dom types ImageData's first parameter as
  // an ArrayBuffer-backed view, and a Uint8ClampedArray is only structurally that once its
  // buffer is known not to be shared - which it never is here, every one of these is allocated
  // a few lines up from a readback.
  context.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0)
  return canvas
}

/**
 * The row stride WebGPU demands of a texture-to-buffer copy: a multiple of 256 bytes.
 *
 * Only the WebGPU path copies through a buffer, but the arithmetic is pure and the unpadding
 * below is the sort of off-by-one that is worth a test rather than a careful read.
 */
export function paddedBytesPerRow(width: number, bytesPerPixel = 4): number {
  const unpadded = width * bytesPerPixel
  return Math.ceil(unpadded / 256) * 256
}

/** Drops each row's copy padding, leaving tightly packed RGBA8 rows. */
export function unpadRows(padded: Uint8Array, width: number, height: number, bytesPerRow: number): Uint8ClampedArray {
  const rowBytes = width * 4
  const out = new Uint8ClampedArray(rowBytes * height)
  for (let row = 0; row < height; row++) {
    out.set(padded.subarray(row * bytesPerRow, row * bytesPerRow + rowBytes), row * rowBytes)
  }
  return out
}

/**
 * Reverses row order in place-ish, for a backend whose first row is the BOTTOM of the picture.
 *
 * GL's readPixels reads from the lower-left corner up, while an ImageData's first row is its
 * top - so the WebGL path flips and the WebGPU path, whose NDC +Y already lands on the first
 * texel row, does not. This is the one place that difference is allowed to exist.
 */
export function flipRows(pixels: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const rowBytes = width * 4
  const out = new Uint8ClampedArray(pixels.length)
  for (let row = 0; row < height; row++) {
    const from = (height - 1 - row) * rowBytes
    out.set(pixels.subarray(from, from + rowBytes), row * rowBytes)
  }
  return out
}

/**
 * A Blob as a data URL.
 *
 * toDataURL() goes through toBlob() rather than calling canvas.toDataURL() directly so that
 * both spellings encode through exactly the same path - the quality argument in particular is
 * honoured identically, which it would not be if one route were synchronous and the other not.
 */
export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Capture failed: could not read the encoded image.'))
    reader.readAsDataURL(blob)
  })
}

/** Encodes a captured canvas, shared by toDataURL and toBlob. */
export function encodeCanvas(canvas: HTMLCanvasElement, mimeType = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(`Capture failed: the browser could not encode ${mimeType}.`))),
      mimeType,
      quality,
    )
  })
}
