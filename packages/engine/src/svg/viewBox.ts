// The document's own coordinate system: what `viewBox` and `preserveAspectRatio` mean, and the
// matrix that maps one onto a box of a chosen size.
//
// An SVG's geometry is written in USER UNITS, and the document decides separately how those map
// onto whatever it is drawn into. A caller that wants an icon 120 px across therefore needs two
// things the geometry does not carry - the rectangle of user units the document considers itself
// to be, and what to do when that rectangle's aspect ratio is not the target's.
//
// Text in and numbers out, so a caller with the attribute values in hand can work out a fit
// without a DOM. image/svgSize.ts answers the neighbouring question - what size a document asks
// to be RASTERIZED at - from the markup as text, and the viewBox rectangle is the same shape
// there, so the type is shared rather than declared twice.

import type { SvgViewBox } from '../image/svgSize'
import { IDENTITY, type Mat2x3 } from './matrix'

/** Where a fitted viewBox sits in its box, or 'none' to stretch it to the whole of one. */
export type SvgAlign =
  | 'none'
  | 'xMinYMin'
  | 'xMidYMin'
  | 'xMaxYMin'
  | 'xMinYMid'
  | 'xMidYMid'
  | 'xMaxYMid'
  | 'xMinYMax'
  | 'xMidYMax'
  | 'xMaxYMax'

/**
 * A `preserveAspectRatio`, parsed. 'meet' fits the whole document inside the box and leaves the
 * spare axis blank; 'slice' covers the box and lets the document run past it.
 */
export interface SvgAspectRatio {
  align: SvgAlign
  scaling: 'meet' | 'slice'
}

/** What preserveAspectRatio means when the document does not say. */
export const DEFAULT_ASPECT_RATIO: SvgAspectRatio = Object.freeze({ align: 'xMidYMid', scaling: 'meet' })

const ALIGNMENTS = new Set<string>([
  'none',
  'xMinYMin',
  'xMidYMin',
  'xMaxYMin',
  'xMinYMid',
  'xMidYMid',
  'xMaxYMid',
  'xMinYMax',
  'xMidYMax',
  'xMaxYMax',
])

/**
 * A `viewBox` attribute value, or null when it is absent or says nothing usable.
 *
 * A zero or negative width or height disables rendering in SVG, and here it would make a fit
 * divide by it, so it is read as no viewBox at all.
 */
export function parseViewBox(value: string | null | undefined): SvgViewBox | null {
  if (!value) return null
  const parts = value.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const [x, y, width, height] = parts
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/**
 * A `preserveAspectRatio` attribute value. Anything unreadable, including the absent case, is
 * the default - which is what the attribute itself falls back to, so a typo behaves as a
 * document with no attribute rather than as no fit at all.
 *
 * The optional leading `defer` is accepted and ignored: it speaks for a <use> of an image, which
 * this loader does not draw.
 */
export function parseAspectRatio(value: string | null | undefined): SvgAspectRatio {
  if (!value) return DEFAULT_ASPECT_RATIO
  const words = value.trim().split(/\s+/).filter((word) => word !== 'defer')
  const align = words[0]
  if (!align || !ALIGNMENTS.has(align)) return DEFAULT_ASPECT_RATIO
  return { align: align as SvgAlign, scaling: words[1] === 'slice' ? 'slice' : 'meet' }
}

/**
 * The matrix that puts `viewBox` into a `width` x `height` box the way `aspect` asks for.
 *
 * 'none' scales each axis to the box independently - the stretch. Every other alignment scales
 * both axes by one factor, the smaller of the two under 'meet' and the larger under 'slice', and
 * then places the result by the Min/Mid/Max halves of the name.
 *
 * Translation and scale only, so a caller can hand the result to a node's own x/y/scaleX/scaleY
 * rather than baking it into geometry - which is what keeps resizing a loaded document a scale
 * write instead of a re-flatten.
 */
export function viewBoxMatrix(
  viewBox: SvgViewBox,
  width: number,
  height: number,
  aspect: SvgAspectRatio = DEFAULT_ASPECT_RATIO,
): Mat2x3 {
  if (!(viewBox.width > 0) || !(viewBox.height > 0)) return IDENTITY
  let scaleX = width / viewBox.width
  let scaleY = height / viewBox.height
  if (aspect.align !== 'none') {
    const uniform = aspect.scaling === 'slice' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY)
    scaleX = uniform
    scaleY = uniform
  }

  let tx = -viewBox.x * scaleX
  let ty = -viewBox.y * scaleY
  const spareX = width - viewBox.width * scaleX
  const spareY = height - viewBox.height * scaleY
  if (aspect.align.includes('xMid')) tx += spareX / 2
  else if (aspect.align.includes('xMax')) tx += spareX
  if (aspect.align.includes('YMid')) ty += spareY / 2
  else if (aspect.align.includes('YMax')) ty += spareY

  return [scaleX, 0, 0, scaleY, tx, ty]
}
