// Load an SVG document (browser DOMParser) into a Group of Path shapes. Walks the tree
// accumulating each element's CTM and resolved paint, converts geometry elements to path data,
// flattens them, bakes the CTM into the points, and maps fill/stroke/gradient onto the reused
// Shape API. The pure helpers it composes (matrix, color, shapeToPath, gradient, css, viewBox)
// are unit-tested on their own; the DOM walk is tested through a document string.
//
// A GROUP, AND A GROUP PER <g>. A document is one assembly, and a Group is what the engine
// treats as one: it is what a Transformer can be attached to, what a drag inside it moves, and
// what outermostGroup() returns from a click on any path in it. A bare Container is none of
// those, so a document loaded into one could only ever be handled a path at a time. The
// document's own grouping is kept for the same reason - closestGroup() can then step inward
// from the whole drawing to the part that was clicked.
//
// The nested groups carry no transform. Each element's CTM is baked into its points on the way
// down, so they mark structure rather than place anything. The one transform that IS a node's
// own is the FIT (see `fit`), which sits on the returned group: a document placed that way is
// resized by writing a scale rather than by flattening its curves again.
//
// NOT LISTENING, unless the caller asks. What comes back is a picture, and what may be clicked
// is the application's decision. It matters more than it sounds: a drag looks for the nearest
// enclosing Group that is draggable and stops at the first one that is not, so a listening
// document dropped into a draggable object stands between the pointer and the object that owns
// it - the artwork swallows the drag while selection goes on working, which reads as "drag is
// broken" and says nothing about the artwork.
//
// WHAT IT COULD NOT READ IS REPORTED. Every construct the loader passes over - an element it
// does not draw, a property it does not carry, a selector it will not guess at, a reference that
// resolves to nothing - is counted onto `notes`. A Group that is missing things looks exactly
// like a Group that was always going to look like that, so without this the failure surfaces
// weeks later as "that icon is the wrong colour".

import type { Container } from '../shapes/Container'
import { Group } from '../shapes/Group'
import { Path } from '../shapes/Path'
import type { GradientStop, RGBA } from '../render/meshFormat'
import type { Contour, LineCap, LineJoin } from '../render/stroke'
import type { FillRule } from '../render/contours'
import { parseLength, type SvgViewBox } from '../image/svgSize'
import { flattenPathData } from './flattenPath'
import { elementToPathData } from './shapeToPath'
import { parseColor } from './color'
import {
  declarationsFor,
  parseInlineStyle,
  parseStylesheet,
  type CssDeclarations,
  type CssRule,
  type StyledElement,
} from './css'
import { parseAspectRatio, parseViewBox, viewBoxMatrix } from './viewBox'
import { applyPoint, multiply, parseTransform, scaleFactor, transformContours, IDENTITY, type Mat2x3 } from './matrix'
import {
  gradientToFill,
  type Bounds,
  type GradientUnits,
  type SvgGradient,
  type SvgGradientStop,
} from './gradient'

/** Containers whose children are drawn where they stand. `svg` and `switch` are their own cases. */
const CONTAINER_TAGS = new Set(['g', 'a'])
const GEOMETRY_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'])

/**
 * Elements that draw nothing where they sit, and are passed over without a note.
 *
 * Definitions and metadata (`defs`, `title`), paint servers reached by reference
 * (`linearGradient`), a `symbol` waiting for a `use`, and the modifiers a reference names rather
 * than the tree (`clipPath`, `mask`, `filter`). Skipping the ELEMENT is not the loss - a
 * reference to one is, and that is noted where the reference is read.
 */
const SILENT_TAGS = new Set([
  'defs',
  'style',
  'title',
  'desc',
  'metadata',
  'lineargradient',
  'radialgradient',
  'symbol',
  'clippath',
  'mask',
  'filter',
  'marker',
  'pattern',
])

/** Properties that name something this does not draw, noted wherever one is set. */
const UNSUPPORTED_PROPERTIES = ['clip-path', 'mask', 'filter']

interface Style {
  fill: string
  fillOpacity: number
  fillRule: FillRule
  stroke: string
  strokeWidth: number
  strokeOpacity: number
  opacity: number // cumulative (group opacities multiplied, approximating layer opacity)
  lineJoin: LineJoin
  lineCap: LineCap
  miterLimit: number
  /** Alternating on/off lengths in user units, empty for a solid outline. */
  dash: readonly number[]
  dashOffset: number
}

const ROOT_STYLE: Style = {
  fill: 'black',
  fillOpacity: 1,
  fillRule: 'nonzero',
  stroke: 'none',
  strokeWidth: 1,
  strokeOpacity: 1,
  opacity: 1,
  lineJoin: 'miter',
  lineCap: 'butt',
  miterLimit: 4,
  dash: [],
  dashOffset: 0,
}

/** What the loader passed over, and how often. See SvgDocument.notes. */
export interface SvgNote {
  kind: 'unsupported-element' | 'unsupported-property' | 'unsupported-selector' | 'unresolved-reference'
  /** What it was: 'use', 'clip-path', '.cls-1:hover', 'url(#grad-2)'. */
  detail: string
  /** How many times it came up. */
  count: number
}

/** A note log: one entry per distinct kind+detail, counting repeats. */
function noteLog(): { add: (kind: SvgNote['kind'], detail: string) => void; list: () => SvgNote[] } {
  const notes = new Map<string, SvgNote>()
  return {
    add(kind, detail) {
      const key = `${kind}|${detail}`
      const existing = notes.get(key)
      if (existing) existing.count++
      else notes.set(key, { kind, detail, count: 1 })
    },
    list: () => [...notes.values()],
  }
}

type Notes = ReturnType<typeof noteLog>

/** A document's own geometry, and everything the loader made of it. */
export interface SvgDocument {
  /** The artwork. See the file header on why it is a Group, and on `listening`. */
  root: Group
  /** The viewBox, or the width/height box, or null when the document declares neither. */
  viewBox: SvgViewBox | null
  /** `width` as declared, in user units, or null - which includes a percentage. */
  width: number | null
  /** `height` as declared, in user units, or null. */
  height: number | null
  /** `preserveAspectRatio` as declared; 'xMidYMid meet' when the document does not say. */
  preserveAspectRatio: string
  /** Everything the loader did not understand, counted. Empty means it read the whole document. */
  notes: SvgNote[]
}

// Read a property in the cascade's own order: the element's inline style, then the stylesheet,
// then the presentation attribute - which is the WEAKEST of the three (SVG 1.1 6.4), not the
// strongest. See css.ts.
type ReadProp = (prop: string) => string | null

function numProp(read: ReadProp, prop: string, fallback: number): number {
  const v = read(prop)
  if (v == null) return fallback
  const n = parseFloat(v)
  return Number.isNaN(n) ? fallback : n
}

/** A `stroke-dasharray`, or null for 'none' and for a list this cannot use. */
function parseDashArray(value: string | null): readonly number[] | null {
  if (value == null) return null
  const text = value.trim()
  if (text === '' || text === 'none') return []
  const lengths = text.split(/[\s,]+/).map((part) => parseFloat(part))
  if (lengths.some((n) => !Number.isFinite(n) || n < 0)) return null
  if (lengths.length === 0 || lengths.every((n) => n === 0)) return []
  // An odd list repeats to make the on/off pairs up, which is what the stroker expects to see.
  return lengths.length % 2 === 0 ? lengths : [...lengths, ...lengths]
}

function inheritStyle(parent: Style, read: ReadProp, notes: Notes): Style {
  const join = read('stroke-linejoin') as LineJoin | null
  const cap = read('stroke-linecap') as LineCap | null
  const rule = read('fill-rule')
  const dashText = read('stroke-dasharray')
  const dash = parseDashArray(dashText)
  if (dash === null && dashText != null) notes.add('unsupported-property', `stroke-dasharray: ${dashText.trim()}`)
  return {
    fill: read('fill') ?? parent.fill,
    fillOpacity: numProp(read, 'fill-opacity', parent.fillOpacity),
    fillRule: rule === 'evenodd' || rule === 'nonzero' ? rule : parent.fillRule,
    stroke: read('stroke') ?? parent.stroke,
    strokeWidth: numProp(read, 'stroke-width', parent.strokeWidth),
    strokeOpacity: numProp(read, 'stroke-opacity', parent.strokeOpacity),
    // opacity is not inherited, but nested opacities multiply visually.
    opacity: parent.opacity * numProp(read, 'opacity', 1),
    lineJoin: join ?? parent.lineJoin,
    lineCap: cap ?? parent.lineCap,
    miterLimit: numProp(read, 'stroke-miterlimit', parent.miterLimit),
    dash: dash ?? parent.dash,
    dashOffset: numProp(read, 'stroke-dashoffset', parent.dashOffset),
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

/** A property of a gradient stop, which carries no stylesheet of its own worth resolving. */
function stopProp(el: Element, prop: string): string | null {
  return parseInlineStyle(el.getAttribute('style'))[prop] ?? el.getAttribute(prop)
}

/**
 * The gradients an element inherits from, itself first.
 *
 * A `<linearGradient>` may name another with `href`, and takes from it every attribute it does
 * not declare and its stops if it declares none. That is how an editor writes a palette: one
 * gradient holds the colours and a dozen name it while placing themselves differently. Reading
 * only the element itself leaves each of those with no stops at all, and the shape that used it
 * unpainted.
 */
function gradientChain(el: Element, byId: Map<string, Element>): Element[] {
  const chain = [el]
  const seen = new Set<string>()
  for (let current = el; ; ) {
    const reference = localReference(current)
    if (!reference || seen.has(reference.id)) break
    seen.add(reference.id)
    const next = byId.get(reference.id)
    if (!next) break
    const tag = next.tagName.toLowerCase()
    if (tag !== 'lineargradient' && tag !== 'radialgradient') break
    chain.push(next)
    current = next
  }
  return chain
}

function parseGradientElement(el: Element, byId: Map<string, Element>): SvgGradient | null {
  const tag = el.tagName.toLowerCase()
  const chain = gradientChain(el, byId)
  // Whichever gradient in the chain declares it first, which is what inheritance means here.
  const attr = (name: string): string | null => {
    for (const link of chain) {
      const value = link.getAttribute(name)
      if (value !== null) return value
    }
    return null
  }

  const units: GradientUnits =
    attr('gradientUnits') === 'userSpaceOnUse' ? 'userSpaceOnUse' : 'objectBoundingBox'
  const transform: Mat2x3 = parseTransform(attr('gradientTransform'))

  const stops: SvgGradientStop[] = []
  for (const link of chain) {
    for (const child of Array.from(link.children)) {
      if (child.tagName.toLowerCase() !== 'stop') continue
      const offset = parseCoord(stopProp(child, 'offset'), 0)
      const color = parseColor(stopProp(child, 'stop-color')) ?? [0, 0, 0, 1]
      const stopOpacity = parseFloat(stopProp(child, 'stop-opacity') ?? '1')
      stops.push({ offset, color: withAlpha(color, Number.isNaN(stopOpacity) ? 1 : stopOpacity) })
    }
    // The nearest gradient with stops of its own supplies them all; the rest of the chain is
    // only there for the attributes.
    if (stops.length > 0) break
  }
  if (stops.length === 0) return null

  if (tag === 'lineargradient') {
    return {
      type: 'linear',
      units,
      transform,
      stops,
      x1: parseCoord(attr('x1'), 0),
      y1: parseCoord(attr('y1'), 0),
      x2: parseCoord(attr('x2'), 1),
      y2: parseCoord(attr('y2'), 0),
    }
  }
  if (tag === 'radialgradient') {
    const cx = parseCoord(attr('cx'), 0.5)
    const cy = parseCoord(attr('cy'), 0.5)
    return {
      type: 'radial',
      units,
      transform,
      stops,
      cx,
      cy,
      r: parseCoord(attr('r'), 0.5),
      fx: parseCoord(attr('fx'), cx),
      fy: parseCoord(attr('fy'), cy),
    }
  }
  return null
}

/** Every element under `root`, `root` itself first. */
function forEachElement(root: Element, visit: (el: Element) => void): void {
  visit(root)
  for (const child of Array.from(root.children)) forEachElement(child, visit)
}

/**
 * One pass over the document for everything a later reference needs: the stylesheet, the
 * gradients, and every element that carries an id.
 *
 * One walk rather than three querySelectorAll calls, because all three questions are asked of
 * the same elements and two of them - a `<style>` wherever it sits, an id on any element at all -
 * have no selector that is both correct and case-safe in an XML document.
 */
function collect(root: Element, notes: Notes): {
  rules: CssRule[]
  gradients: Map<string, SvgGradient>
  byId: Map<string, Element>
} {
  const rules: CssRule[] = []
  const gradients = new Map<string, SvgGradient>()
  const byId = new Map<string, Element>()
  const gradientElements: [string, Element][] = []

  forEachElement(root, (el) => {
    const tag = el.tagName.toLowerCase()
    const id = el.getAttribute('id')
    if (id && !byId.has(id)) byId.set(id, el)

    if (tag === 'style') {
      const type = el.getAttribute('type')
      if (type && type.trim() !== 'text/css') {
        notes.add('unsupported-selector', `<style type="${type}">`)
        return
      }
      const parsed = parseStylesheet(el.textContent ?? '', rules.length)
      rules.push(...parsed.rules)
      for (const skip of parsed.skipped) notes.add(skip.kind, skip.detail)
      return
    }
    if ((tag === 'lineargradient' || tag === 'radialgradient') && id) gradientElements.push([id, el])
  })

  // After the walk, not during it: a gradient may name one that appears later in the document.
  for (const [id, el] of gradientElements) {
    const gradient = parseGradientElement(el, byId)
    if (gradient) gradients.set(id, gradient)
  }

  return { rules, gradients, byId }
}

const URL_REF = /url\(#([^)]+)\)/

/** The id a `href`/`xlink:href` names, or null for one this cannot follow. */
function localReference(el: Element): { href: string; id: string } | null {
  const href = el.getAttribute('href') ?? el.getAttribute('xlink:href')
  if (!href) return null
  const trimmed = href.trim()
  return trimmed.startsWith('#') ? { href: trimmed, id: trimmed.slice(1) } : null
}

/**
 * Whether a <switch> child's conditions pass.
 *
 * `requiredFeatures` and `requiredExtensions` fail whenever they ask for anything at all - this
 * loader supports no named feature and no extension - and an EMPTY one passes, which is what the
 * specification says and what a document uses to mark its fallback branch.
 */
function switchConditionsPass(el: Element, systemLanguage: string): boolean {
  for (const name of ['requiredFeatures', 'requiredExtensions']) {
    const value = el.getAttribute(name)
    if (value !== null && value.trim() !== '') return false
  }
  const languages = el.getAttribute('systemLanguage')
  if (languages === null) return true
  const wanted = systemLanguage.toLowerCase().split('-')[0]
  return languages
    .split(',')
    .map((tag) => tag.trim().toLowerCase().split('-')[0])
    .includes(wanted)
}

export interface LoadSvgOptions {
  /** Curve flatness tolerance in the SVG's own user units (default 0.25). */
  tolerance?: number
  /**
   * Root CTM applied before every element transform (default identity), BAKED INTO THE POINTS.
   * The escape hatch for a caller placing the document itself; `fit` is the one to reach for
   * when the placement is "this size, in this box". SVG is y-down and so is the scene, so no Y
   * flip is wanted.
   */
  rootMatrix?: Mat2x3
  /**
   * Draw the document into a box this size, honouring `preserveAspectRatio` - including 'none',
   * which stretches to the box.
   *
   * The fit lands on the returned group's own x/y/scaleX/scaleY rather than in the geometry, so
   * a caller resizing a loaded document writes a scale instead of re-flattening its curves.
   * A document that declares neither a viewBox nor a width and height has no size of its own to
   * map from, and is left at its own scale - `viewBox` on the result is null when that happened.
   */
  fit?: { width: number; height: number }
  /**
   * Whether the pointer can reach the artwork. Default FALSE - see the file header, which is
   * about the drag this would otherwise swallow rather than about clicking a path.
   */
  listening?: boolean
  /**
   * Which language a <switch> is choosing a branch for (default 'en'). Matched on the primary
   * subtag, so 'en' takes an `en-GB` branch.
   */
  systemLanguage?: string
}

/**
 * Parse an SVG document string into a Group of Path shapes, with what the document says about
 * its own size and what the loader could not read.
 *
 *   const doc = loadSvgDocument(text, { fit: { width: 120, height: 120 } })
 *   scene.root.addChild(doc.root)
 *   if (doc.notes.length > 0) console.warn(doc.notes)
 */
export function loadSvgDocument(svgText: string, options: LoadSvgOptions = {}): SvgDocument {
  const notes = noteLog()
  const root = new Group('svg')
  root.listening = options.listening ?? false

  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const svg = doc.documentElement
  if (!svg || svg.tagName.toLowerCase() !== 'svg') {
    notes.add('unsupported-element', svg ? svg.tagName.toLowerCase() : 'no root element')
    return { root, viewBox: null, width: null, height: null, preserveAspectRatio: 'xMidYMid meet', notes: notes.list() }
  }

  const { rules, gradients, byId } = collect(svg, notes)
  const tolerance = options.tolerance ?? 0.25
  const systemLanguage = options.systemLanguage ?? 'en'

  /** The element's own place in the cascade, and the facts a selector is matched against. */
  const readerFor = (el: Element, parentFacts: StyledElement | null): { read: ReadProp; facts: StyledElement } => {
    const classAttribute = el.getAttribute('class')
    const facts: StyledElement = {
      tag: el.tagName.toLowerCase(),
      id: el.getAttribute('id'),
      classes: classAttribute ? classAttribute.trim().split(/\s+/).filter(Boolean) : [],
      parent: parentFacts,
    }
    const inline: CssDeclarations = parseInlineStyle(el.getAttribute('style'))
    const fromRules: CssDeclarations = rules.length > 0 ? declarationsFor(rules, facts) : {}
    return {
      facts,
      read: (prop) => inline[prop] ?? fromRules[prop] ?? el.getAttribute(prop),
    }
  }

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
      // A paint server that is not a gradient this reads - a pattern, a missing id - leaves the
      // shape unfilled rather than in the initial black, and says which reference it was.
      notes.add('unresolved-reference', `fill: ${ref[0]}`)
      path.filled = false
      return
    }
    const color = parseColor(style.fill)
    if (color) {
      path.fill = withAlpha(color, alpha)
    } else {
      path.filled = false // fill: none (or unresolvable)
    }
  }

  /**
   * One element into the scene.
   *
   * `guard` is the chain of `use` references being followed, so a document that references its
   * own ancestor is reported instead of recursing until the stack ends.
   */
  const walk = (
    el: Element,
    parent: Container,
    parentCtm: Mat2x3,
    parentStyle: Style,
    parentFacts: StyledElement | null,
    guard: ReadonlySet<string>,
  ): void => {
    const tag = el.tagName.toLowerCase()
    const { read, facts } = readerFor(el, parentFacts)
    if (read('display') === 'none') return

    const ctm = multiply(parentCtm, parseTransform(el.getAttribute('transform')))
    const style = inheritStyle(parentStyle, read, notes)
    for (const property of UNSUPPORTED_PROPERTIES) {
      const value = read(property)
      if (value != null && value.trim() !== 'none') notes.add('unsupported-property', property)
    }

    /** A group for whatever `build` puts under it, added only if it drew something. */
    const intoGroup = (build: (group: Group) => void): void => {
      // Built first and added afterwards, so a <g> holding nothing the loader understands - a
      // <filter>, an unresolved <use> - leaves no empty node behind to measure or click.
      const group = new Group({ name: el.getAttribute('id') ?? '' })
      build(group)
      if (group.hasChildren()) parent.addChild(group)
    }

    if (CONTAINER_TAGS.has(tag)) {
      intoGroup((group) => {
        for (const child of Array.from(el.children)) walk(child, group, ctm, style, facts, guard)
      })
      return
    }

    if (tag === 'switch') {
      // One branch, not all of them: the first child whose conditions pass, which is what a
      // <switch> means and what makes its later branches fallbacks rather than more artwork.
      intoGroup((group) => {
        for (const child of Array.from(el.children)) {
          if (!switchConditionsPass(child, systemLanguage)) continue
          walk(child, group, ctm, style, facts, guard)
          return
        }
      })
      return
    }

    if (tag === 'svg') {
      // A nested viewport: placed by x/y, and mapping its own viewBox onto the width and height
      // it declares. Without a viewBox there is nothing to map and it is a group that has moved.
      const viewBox = parseViewBox(el.getAttribute('viewBox'))
      const x = numProp(read, 'x', 0)
      const y = numProp(read, 'y', 0)
      let inner = multiply(ctm, [1, 0, 0, 1, x, y])
      if (viewBox) {
        const width = parseLength(el.getAttribute('width')) ?? viewBox.width
        const height = parseLength(el.getAttribute('height')) ?? viewBox.height
        inner = multiply(inner, viewBoxMatrix(viewBox, width, height, parseAspectRatio(el.getAttribute('preserveAspectRatio'))))
      }
      intoGroup((group) => {
        for (const child of Array.from(el.children)) walk(child, group, inner, style, facts, guard)
      })
      return
    }

    if (tag === 'use') {
      const reference = localReference(el)
      if (!reference) {
        notes.add('unresolved-reference', `use href="${el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? ''}"`)
        return
      }
      const target = byId.get(reference.id)
      if (!target) {
        notes.add('unresolved-reference', `use ${reference.href}`)
        return
      }
      if (guard.has(reference.id)) {
        notes.add('unresolved-reference', `use ${reference.href} (references itself)`)
        return
      }

      const x = numProp(read, 'x', 0)
      const y = numProp(read, 'y', 0)
      let inner = multiply(ctm, [1, 0, 0, 1, x, y])
      const targetTag = target.tagName.toLowerCase()
      const viewBox = parseViewBox(target.getAttribute('viewBox'))
      if ((targetTag === 'symbol' || targetTag === 'svg') && viewBox) {
        // The <use> supplies the viewport a symbol is drawn into; its own viewBox says what maps
        // onto it. A use that names no size draws the symbol at its own.
        const width = parseLength(el.getAttribute('width')) ?? viewBox.width
        const height = parseLength(el.getAttribute('height')) ?? viewBox.height
        inner = multiply(inner, viewBoxMatrix(viewBox, width, height, parseAspectRatio(target.getAttribute('preserveAspectRatio'))))
      }

      const deeper = new Set(guard).add(reference.id)
      intoGroup((group) => {
        if (targetTag === 'symbol' || targetTag === 'svg') {
          // The element itself is a viewport this has already applied, so its CHILDREN are what
          // is drawn - walking the element again would apply the mapping twice.
          for (const child of Array.from(target.children)) walk(child, group, inner, style, facts, deeper)
        } else {
          walk(target, group, inner, style, facts, deeper)
        }
      })
      return
    }

    if (!GEOMETRY_TAGS.has(tag)) {
      if (!SILENT_TAGS.has(tag)) notes.add('unsupported-element', tag)
      return
    }

    const d = elementToPathData(tag, read)
    if (!d) return
    const localContours = flattenPathData(d, { tolerance })
    if (localContours.length === 0) return

    const strokeColor = parseColor(style.stroke)
    const scale = scaleFactor(ctm)
    const path = new Path({
      contours: transformContours(localContours, ctm),
      fillRule: style.fillRule,
      stroke: strokeColor ? withAlpha(strokeColor, style.strokeOpacity * style.opacity) : [0, 0, 0, 0],
      strokeWidth: strokeColor ? style.strokeWidth * scale : 0,
      // The dash is a length along the outline, and the outline has been scaled into scene units.
      // Left out entirely when there is none, so a solid path allocates no list for it.
      dash: style.dash.length > 0 ? style.dash.map((length) => length * scale) : undefined,
      dashOffset: style.dashOffset * scale,
      lineJoin: style.lineJoin,
      lineCap: style.lineCap,
      miterLimit: style.miterLimit,
    })
    applyFill(path, style, localContours, ctm)
    parent.addChild(path)
  }

  const rootMatrix = options.rootMatrix ?? IDENTITY
  const rootReader = readerFor(svg, null)
  const rootStyle = inheritStyle(ROOT_STYLE, rootReader.read, notes)
  for (const child of Array.from(svg.children)) {
    walk(child, root, rootMatrix, rootStyle, rootReader.facts, new Set())
  }

  const viewBox = parseViewBox(svg.getAttribute('viewBox'))
  const width = parseLength(svg.getAttribute('width'))
  const height = parseLength(svg.getAttribute('height'))
  const preserveAspectRatio = svg.getAttribute('preserveAspectRatio')?.trim() || 'xMidYMid meet'

  // The box the document considers itself to be: its viewBox, or the size it declares.
  const box: SvgViewBox | null =
    viewBox ?? (width !== null && height !== null && width > 0 && height > 0 ? { x: 0, y: 0, width, height } : null)
  if (options.fit && box) {
    const m = viewBoxMatrix(box, options.fit.width, options.fit.height, parseAspectRatio(preserveAspectRatio))
    root.scaleX = m[0]
    root.scaleY = m[3]
    root.x = m[4]
    root.y = m[5]
  }

  return { root, viewBox: box, width, height, preserveAspectRatio, notes: notes.list() }
}
