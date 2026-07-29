// Reading and rewriting an SVG document's size, as text.
//
// Rasterizing an SVG means choosing a pixel size, and the document usually implies one:
// width/height attributes, a viewBox, or both. This works out that implied size and, more
// importantly, writes a chosen one back into the markup before handing it to the browser.
//
// Writing it back matters because of how SVG scaling actually works. Changing width and
// height alone enlarges the CANVAS, not the drawing - content keeps its user-unit size and
// the extra space is simply blank. Only a viewBox maps user units onto that canvas, so a
// document without one has its original size added as a viewBox at the same time. Then
// doubling width and height genuinely doubles the picture.
//
// It is text in and text out, no DOM, so it stays testable outside a browser. The parsing
// only ever looks at the root <svg> element's attributes, which is all the size depends on.

/** A size in CSS pixels. */
export interface SvgSize {
  width: number
  height: number
}

/** A viewBox: the rectangle of user units the document maps onto its canvas. */
export interface SvgViewBox {
  x: number
  y: number
  width: number
  height: number
}

// CSS absolute length units, in pixels. Relative units (%, em, ex, rem, vw, vh) need a
// viewport or a font to resolve and cannot give an intrinsic size, so they are left out.
const UNIT_PX: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  q: 96 / 25.4 / 4,
}

/** Where the root <svg> start tag begins and ends, skipping any prologue before it. */
function findRootTag(svgText: string): { start: number; end: number } | null {
  let i = 0
  while (i < svgText.length) {
    const lt = svgText.indexOf('<', i)
    if (lt === -1) return null

    // Comments, processing instructions and the doctype can all precede the root element,
    // and a comment may contain anything at all - including the text "<svg".
    if (svgText.startsWith('<!--', lt)) {
      const close = svgText.indexOf('-->', lt)
      if (close === -1) return null
      i = close + 3
      continue
    }
    if (svgText.startsWith('<?', lt) || svgText.startsWith('<!', lt)) {
      const close = svgText.indexOf('>', lt)
      if (close === -1) return null
      i = close + 1
      continue
    }

    if (!/^<svg[\s/>]/i.test(svgText.slice(lt, lt + 5))) return null

    // Scan to the tag's own '>', ignoring any inside quoted attribute values.
    let quote = ''
    for (let j = lt + 4; j < svgText.length; j++) {
      const ch = svgText[j]
      if (quote) {
        if (ch === quote) quote = ''
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        return { start: lt, end: j + 1 }
      }
    }
    return null
  }
  return null
}

/** The root element's attributes, lowercased by name. */
function rootAttributes(svgText: string): Map<string, string> | null {
  const tag = findRootTag(svgText)
  if (!tag) return null
  const attrs = new Map<string, string>()
  const body = svgText.slice(tag.start + 4, tag.end - 1)
  const pattern = /([:\w.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = pattern.exec(body)) !== null) {
    attrs.set(m[1].toLowerCase(), m[3] ?? m[4] ?? '')
  }
  return attrs
}

/**
 * A CSS length in pixels, or null when it has no fixed size of its own - a percentage or a
 * font/viewport-relative unit, which only mean something in a context this does not have.
 */
export function parseLength(value: string | null | undefined): number | null {
  if (value == null) return null
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z%]*)\s*$/.exec(value)
  if (!m) return null
  const factor = UNIT_PX[m[2].toLowerCase()]
  if (factor === undefined) return null
  const n = parseFloat(m[1]) * factor
  return Number.isFinite(n) ? n : null
}

/** The root viewBox, or null when it is absent or malformed. */
export function svgViewBox(svgText: string): SvgViewBox | null {
  const attrs = rootAttributes(svgText)
  const raw = attrs?.get('viewbox')
  if (!raw) return null
  const parts = raw.trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const [x, y, width, height] = parts
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/**
 * The size the document asks to be drawn at, in CSS pixels, or null when it does not say.
 * Absolute width and height win; otherwise the viewBox supplies whichever is missing, using
 * its aspect ratio when only one of the two is given.
 */
export function svgIntrinsicSize(svgText: string): SvgSize | null {
  const attrs = rootAttributes(svgText)
  if (!attrs) return null
  const width = parseLength(attrs.get('width'))
  const height = parseLength(attrs.get('height'))
  if (width !== null && height !== null && width > 0 && height > 0) return { width, height }

  const box = svgViewBox(svgText)
  if (!box) return null
  const aspect = box.width / box.height
  if (width !== null && width > 0) return { width, height: width / aspect }
  if (height !== null && height > 0) return { width: height * aspect, height }
  return { width: box.width, height: box.height }
}

/** What a rasterization is allowed to say about its size. */
export interface SvgSizeOptions {
  /** Target width in pixels. Defaults to the document's own, or to height x aspect ratio. */
  width?: number
  /** Target height in pixels. Defaults to the document's own, or to width / aspect ratio. */
  height?: number
  /**
   * Multiplies the final pixel size without changing how large the image is in the scene.
   * Raise it to keep an image crisp when the camera zooms in, or to match a dense display;
   * it costs memory as the square.
   */
  scale?: number
}

/**
 * The pixel size to rasterize at: the requested size, or the document's own, with a missing
 * axis filled in from the aspect ratio, all multiplied by scale and rounded to whole pixels.
 * Throws when the document gives no size and the caller does not supply enough to derive one.
 */
export function resolveSvgPixelSize(svgText: string, options: SvgSizeOptions = {}): SvgSize {
  const scale = options.scale ?? 1
  if (!(scale > 0) || !Number.isFinite(scale)) {
    throw new Error(`svg raster: scale must be a positive number, got ${options.scale}`)
  }
  for (const [name, value] of [
    ['width', options.width],
    ['height', options.height],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`svg raster: ${name} must be a positive number, got ${value}`)
    }
  }

  const intrinsic = svgIntrinsicSize(svgText)
  let { width, height } = options

  if (width === undefined && height === undefined) {
    if (!intrinsic) {
      throw new Error(
        'svg raster: the document has no width/height or viewBox to take a size from - pass width and/or height',
      )
    }
    width = intrinsic.width
    height = intrinsic.height
  } else if (width === undefined || height === undefined) {
    if (!intrinsic) {
      throw new Error(
        'svg raster: the document has no viewBox, so the other axis cannot be derived - pass both width and height',
      )
    }
    const aspect = intrinsic.width / intrinsic.height
    if (width === undefined) width = (height as number) * aspect
    else height = width / aspect
  }

  return {
    width: Math.max(1, Math.round((width as number) * scale)),
    height: Math.max(1, Math.round((height as number) * scale)),
  }
}

/**
 * Returns the document with its root width and height set to the given pixel size, and a
 * viewBox added from its original size when it had none - without which the new width and
 * height would enlarge the canvas and leave the drawing the size it was.
 *
 * A document that has neither a viewBox nor a size is resized anyway: there is nothing to
 * preserve the scale of, and its own contents decide what that means.
 */
export function resizeSvgDocument(svgText: string, width: number, height: number): string {
  const tag = findRootTag(svgText)
  if (!tag) return svgText

  const original = svgText.slice(tag.start, tag.end)
  const selfClosing = /\/>$/.test(original)
  const hasViewBox = svgViewBox(svgText) !== null
  const intrinsic = hasViewBox ? null : svgIntrinsicSize(svgText)

  // Drop only the attributes being replaced, keeping everything else - ids, namespaces,
  // styles, and any viewBox, which is left exactly as it was because it is the mapping the
  // new size is being applied to.
  let body = original
    .slice(4, selfClosing ? -2 : -1)
    .replace(/\s+(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .trimEnd()

  body += ` width="${width}" height="${height}"`
  if (!hasViewBox && intrinsic) body += ` viewBox="0 0 ${intrinsic.width} ${intrinsic.height}"`

  return svgText.slice(0, tag.start) + `<svg${body}${selfClosing ? '/>' : '>'}` + svgText.slice(tag.end)
}
