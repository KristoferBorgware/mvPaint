// Load an SVG document (browser DOMParser) into a Group of Path shapes. Walks the tree
// accumulating each element's CTM and inherited paint, converts geometry elements to path
// data, flattens them, bakes the CTM into the points, and maps fill/stroke/gradient onto
// the reused Shape API. The pure helpers it composes (matrix, color, shapeToPath, gradient)
// are unit-tested; this DOM glue is exercised in the browser.
//
// A GROUP, AND A GROUP PER <g>. A document is one assembly, and a Group is what the engine
// treats as one: it is what a Transformer can be attached to, what a drag inside it moves, and
// what outermostGroup() returns from a click on any path in it. A bare Container is none of
// those, so a document loaded into one could only ever be handled a path at a time. The
// document's own grouping is kept for the same reason - closestGroup() can then step inward
// from the whole drawing to the part that was clicked.
//
// The nested groups carry no transform. Each element's CTM is baked into its points on the way
// down, so they mark structure rather than place anything.

import type { Container } from '../shapes/Container'
import { Group } from '../shapes/Group'
import { Path } from '../shapes/Path'
import type { GradientStop, RGBA } from '../render/meshFormat'
import type { Contour, LineCap, LineJoin } from '../render/stroke'
import { flattenPathData } from './flattenPath'
import { elementToPathData } from './shapeToPath'
import { parseColor } from './color'
import { applyPoint, multiply, parseTransform, scaleFactor, transformContours, IDENTITY, type Mat2x3 } from './matrix'
import {
  gradientToFill,
  type Bounds,
  type GradientUnits,
  type SvgGradient,
  type SvgGradientStop,
} from './gradient'

const CONTAINER_TAGS = new Set(['svg', 'g', 'a', 'switch'])
const GEOMETRY_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'])

interface Style {
  fill: string
  fillOpacity: number
  stroke: string
  strokeWidth: number
  strokeOpacity: number
  opacity: number // cumulative (group opacities multiplied, approximating layer opacity)
  lineJoin: LineJoin
  lineCap: LineCap
  miterLimit: number
}

const ROOT_STYLE: Style = {
  fill: 'black',
  fillOpacity: 1,
  stroke: 'none',
  strokeWidth: 1,
  strokeOpacity: 1,
  opacity: 1,
  lineJoin: 'miter',
  lineCap: 'butt',
  miterLimit: 4,
}

// Read a presentation property, preferring an inline `style` declaration over the attribute.
function readProp(el: Element, prop: string): string | null {
  const style = el.getAttribute('style')
  if (style) {
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(style)
    if (m) return m[1].trim()
  }
  return el.getAttribute(prop)
}

function numProp(el: Element, prop: string, fallback: number): number {
  const v = readProp(el, prop)
  if (v == null) return fallback
  const n = parseFloat(v)
  return Number.isNaN(n) ? fallback : n
}

function inheritStyle(parent: Style, el: Element): Style {
  const join = readProp(el, 'stroke-linejoin') as LineJoin | null
  const cap = readProp(el, 'stroke-linecap') as LineCap | null
  return {
    fill: readProp(el, 'fill') ?? parent.fill,
    fillOpacity: numProp(el, 'fill-opacity', parent.fillOpacity),
    stroke: readProp(el, 'stroke') ?? parent.stroke,
    strokeWidth: numProp(el, 'stroke-width', parent.strokeWidth),
    strokeOpacity: numProp(el, 'stroke-opacity', parent.strokeOpacity),
    // opacity is not inherited, but nested opacities multiply visually.
    opacity: parent.opacity * numProp(el, 'opacity', 1),
    lineJoin: join ?? parent.lineJoin,
    lineCap: cap ?? parent.lineCap,
    miterLimit: numProp(el, 'stroke-miterlimit', parent.miterLimit),
  }
}

function withAlpha(color: RGBA, alpha: number): RGBA {
  return [color[0], color[1], color[2], color[3] * alpha]
}

function boundsOf(contours: readonly Contour[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const c of contours) {
    for (const p of c.points) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function parseCoord(v: string | null, fallback: number): number {
  if (v == null) return fallback
  if (v.endsWith('%')) return parseFloat(v) / 100
  const n = parseFloat(v)
  return Number.isNaN(n) ? fallback : n
}

function parseGradientElement(el: Element): SvgGradient | null {
  const tag = el.tagName.toLowerCase()
  const units: GradientUnits =
    el.getAttribute('gradientUnits') === 'userSpaceOnUse' ? 'userSpaceOnUse' : 'objectBoundingBox'
  const transform: Mat2x3 = parseTransform(el.getAttribute('gradientTransform'))

  const stops: SvgGradientStop[] = []
  for (const child of Array.from(el.children)) {
    if (child.tagName.toLowerCase() !== 'stop') continue
    const offset = parseCoord(readProp(child, 'offset'), 0)
    const color = parseColor(readProp(child, 'stop-color')) ?? [0, 0, 0, 1]
    const stopOpacity = numProp(child, 'stop-opacity', 1)
    stops.push({ offset, color: withAlpha(color, stopOpacity) })
  }
  if (stops.length === 0) return null

  if (tag === 'lineargradient') {
    return {
      type: 'linear',
      units,
      transform,
      stops,
      x1: parseCoord(el.getAttribute('x1'), 0),
      y1: parseCoord(el.getAttribute('y1'), 0),
      x2: parseCoord(el.getAttribute('x2'), 1),
      y2: parseCoord(el.getAttribute('y2'), 0),
    }
  }
  if (tag === 'radialgradient') {
    const cx = parseCoord(el.getAttribute('cx'), 0.5)
    const cy = parseCoord(el.getAttribute('cy'), 0.5)
    return {
      type: 'radial',
      units,
      transform,
      stops,
      cx,
      cy,
      r: parseCoord(el.getAttribute('r'), 0.5),
      fx: parseCoord(el.getAttribute('fx'), cx),
      fy: parseCoord(el.getAttribute('fy'), cy),
    }
  }
  return null
}

function collectGradients(root: Element): Map<string, SvgGradient> {
  const map = new Map<string, SvgGradient>()
  for (const el of Array.from(root.querySelectorAll('linearGradient, radialGradient'))) {
    const id = el.getAttribute('id')
    if (!id) continue
    const g = parseGradientElement(el)
    if (g) map.set(id, g)
  }
  return map
}

const URL_REF = /url\(#([^)]+)\)/

export interface LoadSvgOptions {
  /** Curve flatness tolerance in the SVG's own user units (default 0.25). */
  tolerance?: number
  /**
   * Root CTM applied before every element transform (default identity). Use it to place
   * the document in the scene. SVG is y-down and so is the scene, so no Y flip is wanted.
   */
  rootMatrix?: Mat2x3
}

/** Parse an SVG document string into a Group of Path shapes. */
export function loadSvgDocument(svgText: string, options: LoadSvgOptions = {}): Group {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const svg = doc.documentElement
  const root = new Group('svg')
  if (!svg || svg.tagName.toLowerCase() !== 'svg') return root

  const gradients = collectGradients(svg)
  const tolerance = options.tolerance ?? 0.25

  const applyFill = (path: Path, style: Style, localContours: Contour[], ctm: Mat2x3): void => {
    const alpha = style.fillOpacity * style.opacity
    const ref = URL_REF.exec(style.fill)
    if (ref) {
      const g = gradients.get(ref[1])
      if (g) {
        const fill = gradientToFill(g, boundsOf(localContours))
        path.fillLinearGradientColorStops = [] // reset defaults
        path.fillRadialGradientColorStops = []
        const bakeStops = (stops: GradientStop[]) =>
          stops.map((s) => ({ offset: s.offset, color: withAlpha(s.color, alpha) }))
        if (fill.fillPriority === 'linear-gradient') {
          path.fillPriority = 'linear-gradient'
          path.fillLinearGradientStartPoint = applyPoint(ctm, fill.start.x, fill.start.y)
          path.fillLinearGradientEndPoint = applyPoint(ctm, fill.end.x, fill.end.y)
          path.fillLinearGradientColorStops = bakeStops(fill.stops)
        } else {
          path.fillPriority = 'radial-gradient'
          path.fillRadialGradientStartPoint = applyPoint(ctm, fill.start.x, fill.start.y)
          path.fillRadialGradientStartRadius = fill.startRadius * scaleFactor(ctm)
          path.fillRadialGradientEndPoint = applyPoint(ctm, fill.end.x, fill.end.y)
          path.fillRadialGradientEndRadius = fill.endRadius * scaleFactor(ctm)
          path.fillRadialGradientColorStops = bakeStops(fill.stops)
        }
        return
      }
    }
    const color = parseColor(style.fill)
    if (color) {
      path.fill = withAlpha(color, alpha)
    } else {
      path.filled = false // fill: none (or unresolvable)
    }
  }

  const walk = (el: Element, parent: Container, parentCtm: Mat2x3, parentStyle: Style): void => {
    const tag = el.tagName.toLowerCase()
    const ctm = multiply(parentCtm, parseTransform(el.getAttribute('transform')))
    const style = inheritStyle(parentStyle, el)

    if (CONTAINER_TAGS.has(tag)) {
      // Built first and added only if it drew something, so a <g> holding nothing the loader
      // understands - a <filter>, a <use> - leaves no empty node behind to measure or click.
      const group = new Group({ name: el.getAttribute('id') ?? '' })
      for (const child of Array.from(el.children)) walk(child, group, ctm, style)
      if (group.hasChildren()) parent.addChild(group)
      return
    }
    if (!GEOMETRY_TAGS.has(tag)) return

    const d = elementToPathData(tag, (name) => el.getAttribute(name))
    if (!d) return
    const localContours = flattenPathData(d, { tolerance })
    if (localContours.length === 0) return

    const strokeColor = parseColor(style.stroke)
    const path = new Path({
      contours: transformContours(localContours, ctm),
      stroke: strokeColor ? withAlpha(strokeColor, style.strokeOpacity * style.opacity) : [0, 0, 0, 0],
      strokeWidth: strokeColor ? style.strokeWidth * scaleFactor(ctm) : 0,
      lineJoin: style.lineJoin,
      lineCap: style.lineCap,
      miterLimit: style.miterLimit,
    })
    applyFill(path, style, localContours, ctm)
    parent.addChild(path)
  }

  const rootMatrix = options.rootMatrix ?? IDENTITY
  for (const child of Array.from(svg.children)) walk(child, root, rootMatrix, ROOT_STYLE)
  return root
}
