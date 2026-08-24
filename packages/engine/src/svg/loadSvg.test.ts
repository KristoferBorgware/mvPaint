// The document walk: what a piece of SVG markup becomes.
//
// The rest of the SVG suite (svg.test.ts) exercises the pure stages the loader composes. This
// file is about the walk itself - the cascade a document's paint arrives through, the fit, the
// references, and the notes - because those are decisions made while walking a tree and cannot
// be asked of any one helper.
//
// A DOM IS BUILT HERE RATHER THAN IMPORTED. The suite runs in node with no document (see
// vitest.config.ts), and the loader needs a DOMParser. What it uses of one is four things - a
// tag name, an attribute by name, the element children, and the text inside a <style> - so the
// parser below supplies exactly those and nothing else. Bringing in a full DOM implementation
// would test that implementation; this tests the walk.

import { expect, it } from 'vitest'
import { loadSvgDocument, type SvgDocument } from './loadSvg'
import { Path } from '../shapes/Path'
import type { Node } from '../shapes/Node'
import type { MeshSink } from '../render/meshFormat'
import type { Vector2Like } from '../math/Vector2'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

// --- the smallest XML document the loader can be walked over -------------------------------

class FakeElement {
  readonly children: FakeElement[] = []
  textContent = ''
  private readonly attributes = new Map<string, string>()

  constructor(readonly tagName: string, attributes: readonly (readonly [string, string])[] = []) {
    for (const [name, value] of attributes) this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
}

const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/** Where the tag opened at `open` ends, ignoring any '>' inside a quoted attribute value. */
function endOfTag(text: string, open: number): number {
  let quote = ''
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      return i
    }
  }
  return text.length
}

function parseXml(text: string): FakeElement | null {
  const stack: FakeElement[] = []
  let root: FakeElement | null = null
  // Every open element, so textContent reads like the DOM's - the text of a whole subtree.
  const addText = (chunk: string): void => {
    for (const element of stack) element.textContent += chunk
  }

  let i = 0
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt === -1) {
      addText(text.slice(i))
      break
    }
    if (lt > i) addText(text.slice(i, lt))

    if (text.startsWith('<!--', lt)) {
      i = text.indexOf('-->', lt) + 3
      continue
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt)
      addText(text.slice(lt + 9, end))
      i = end + 3
      continue
    }
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      i = text.indexOf('>', lt) + 1
      continue
    }

    const gt = endOfTag(text, lt)
    const body = text.slice(lt + 1, gt)
    i = gt + 1
    if (body.startsWith('/')) {
      stack.pop()
      continue
    }

    const selfClosing = body.endsWith('/')
    const inner = selfClosing ? body.slice(0, -1) : body
    const name = /^[\w:.-]+/.exec(inner)?.[0]
    if (!name) continue
    const attributes: [string, string][] = []
    ATTRIBUTE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = ATTRIBUTE.exec(inner.slice(name.length))) !== null) {
      attributes.push([match[1], match[2] ?? match[3] ?? ''])
    }

    const element = new FakeElement(name, attributes)
    if (stack.length > 0) stack[stack.length - 1].children.push(element)
    else if (!root) root = element
    if (!selfClosing) stack.push(element)
  }
  return root
}

class FakeDOMParser {
  parseFromString(text: string): { documentElement: FakeElement } {
    return { documentElement: parseXml(text) ?? new FakeElement('parsererror') }
  }
}
;(globalThis as { DOMParser?: unknown }).DOMParser = FakeDOMParser

// --- reading what came back ------------------------------------------------------------------

function pathsOf(doc: SvgDocument): Path[] {
  const found: Path[] = []
  doc.root.traversePreOrder((node: Node) => {
    if (node instanceof Path) found.push(node)
  })
  return found
}

function onlyPath(doc: SvgDocument): Path {
  const paths = pathsOf(doc)
  assert(paths.length === 1, `the document loaded as one path (got ${paths.length})`)
  return paths[0]
}

const hex = (path: Path): string => {
  const fill = path.fill
  if (!path.filled || !fill) return 'none'
  return `#${[fill[0], fill[1], fill[2]].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`
}

/** The area the fill triangles cover - what says whether a ring came out solid or a hole. */
function fillArea(path: Path): number {
  const verts: Vector2Like[] = []
  let area = 0
  const sink: MeshSink = {
    vertex: (x, y, isFill) => (verts.push({ x, y, isFill } as Vector2Like), verts.length - 1),
    triangle: (i, j, k) => {
      const a = verts[i], b = verts[j], c = verts[k]
      if ((a as { isFill?: boolean }).isFill !== true) return
      area += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2
    },
  }
  path.tessellate(sink)
  return area
}

/** A one-rect document, with whatever paint the case is about. */
const rectDoc = (style: string, rect: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60">${style}<rect ${rect} width="10" height="10"/></svg>`

// --- the cascade -----------------------------------------------------------------------------

it('a class rule paints, where the initial style would have painted black', () => {
  const styled = loadSvgDocument(rectDoc('<style>.a{fill:#cad0d7}</style>', 'class="a"'))
  assert(hex(onlyPath(styled)) === '#cad0d7', 'the rule reaches the element carrying its class')

  // The control, and the reason this matters: an unresolved class is not a gap in the drawing.
  // SVG's initial fill is BLACK, so the same document without the rule is a solid silhouette.
  const bare = loadSvgDocument(rectDoc('', 'class="a"'))
  assert(hex(onlyPath(bare)) === '#000000', 'without the rule the rect draws in the initial black')
})

it('the three levels a document can say its paint at, in the order SVG gives them', () => {
  // A presentation attribute is the WEAKEST of the three (SVG 1.1 6.4), not the strongest.
  const overAttribute = loadSvgDocument(rectDoc('<style>.a{fill:red}</style>', 'class="a" fill="blue"'))
  assert(hex(onlyPath(overAttribute)) === '#ff0000', 'a rule beats a presentation attribute')

  const inline = loadSvgDocument(rectDoc('<style>.a{fill:red}</style>', 'class="a" style="fill:green"'))
  assert(hex(onlyPath(inline)) === '#008000', "and the element's own inline style beats the rule")

  const later = loadSvgDocument(rectDoc('<style>.a{fill:red}.b{fill:lime}</style>', 'class="a b"'))
  assert(hex(onlyPath(later)) === '#00ff00', 'two rules of equal specificity: the later one wins')

  const byId = loadSvgDocument(
    rectDoc('<style>rect{fill:red}.a{fill:blue}#one{fill:lime}</style>', 'id="one" class="a"'),
  )
  assert(hex(onlyPath(byId)) === '#00ff00', 'an id beats a class beats a type, whatever order they are written in')

  const descendant = loadSvgDocument(
    `<svg viewBox="0 0 60 60"><style>g .a{fill:red} .a{fill:blue}</style><g><rect class="a" width="10" height="10"/></g></svg>`,
  )
  assert(hex(onlyPath(descendant)) === '#ff0000', 'a descendant combinator is read, and counts as the more specific')
})

it('a stylesheet says what it could not use, and uses the rest of what it could', () => {
  const doc = loadSvgDocument(
    rectDoc('<style>@media print{.a{fill:red}} .a:hover{fill:blue} .a{fill:lime}</style>', 'class="a"'),
  )
  assert(hex(onlyPath(doc)) === '#00ff00', 'the rule it can read still applies')
  const details = doc.notes.filter((n) => n.kind === 'unsupported-selector').map((n) => n.detail)
  assert(details.includes('@media'), 'the at-rule is reported')
  assert(details.includes('.a:hover'), 'so is the selector it will not guess at')

  // And it is DROPPED rather than approximated: '.a:hover' applied as '.a' would paint the
  // hover colour permanently, which is the failure this exists to prevent.
  assert(!details.includes('.a'), 'the selector it did read is not reported')
})

// --- the document's own coordinate system ----------------------------------------------------

it('the document reports its own geometry, so a caller need not parse it twice', () => {
  const doc = loadSvgDocument('<svg viewBox="0 0 60 60"><rect width="10" height="10"/></svg>')
  assert(doc.viewBox !== null && doc.viewBox.width === 60 && doc.viewBox.height === 60, 'the viewBox is reported')
  assert(doc.width === null && doc.height === null, 'and a width the document does not declare is null, not a guess')
  assert(doc.preserveAspectRatio === 'xMidYMid meet', 'preserveAspectRatio reads as the default when absent')

  const sized = loadSvgDocument('<svg width="40px" height="20"><rect width="10" height="10"/></svg>')
  assert(sized.width === 40 && sized.height === 20, 'a declared size is reported in user units')
  assert(sized.viewBox?.width === 40, 'and stands in as the box when there is no viewBox')

  const neither = loadSvgDocument('<svg><rect width="10" height="10"/></svg>')
  assert(neither.viewBox === null, 'a document that declares neither says so')
})

it('a fit places the document by the returned group, not by moving its points', () => {
  const document = '<svg viewBox="0 0 60 60" preserveAspectRatio="none"><rect width="60" height="60"/></svg>'
  const stretched = loadSvgDocument(document, { fit: { width: 120, height: 240 } })
  assert(stretched.root.scaleX === 2 && stretched.root.scaleY === 4, "'none' stretches each axis to the box")
  assert(stretched.root.x === 0 && stretched.root.y === 0, 'and fills it, so there is nothing to centre')

  // The points themselves are untouched, which is what makes a resize a scale write rather than
  // a re-flatten of every curve.
  assert(onlyPath(stretched).width === 60, "the geometry is still in the document's own units")

  const letterboxed = loadSvgDocument(
    '<svg viewBox="0 0 60 60"><rect width="60" height="60"/></svg>',
    { fit: { width: 120, height: 240 } },
  )
  assert(letterboxed.root.scaleX === 2 && letterboxed.root.scaleY === 2, 'the default fits uniformly')
  assert(letterboxed.root.x === 0 && near(letterboxed.root.y, 60), 'and centres the spare axis')

  const offset = loadSvgDocument(
    '<svg viewBox="10 20 60 60" preserveAspectRatio="none"><rect width="60" height="60"/></svg>',
    { fit: { width: 60, height: 60 } },
  )
  assert(offset.root.x === -10 && offset.root.y === -20, "a viewBox that does not start at the origin brings its own offset")
})

// --- what it could not read ------------------------------------------------------------------

it('every construct the loader passes over is reported, counted', () => {
  const doc = loadSvgDocument(
    `<svg viewBox="0 0 60 60"><text x="0" y="0">hi</text><text x="0" y="8">ho</text>` +
      `<rect width="10" height="10" clip-path="url(#c)"/><use href="#nothing"/></svg>`,
  )
  const find = (kind: string, detail: string) => doc.notes.find((n) => n.kind === kind && n.detail === detail)
  assert(find('unsupported-element', 'text')?.count === 2, 'an element it does not draw, once per occurrence')
  assert(find('unsupported-property', 'clip-path') !== undefined, 'a property that names something it does not draw')
  assert(find('unresolved-reference', 'use #nothing') !== undefined, 'and a reference that resolves to nothing')

  const clean = loadSvgDocument('<svg viewBox="0 0 60 60"><rect width="10" height="10" fill="red"/></svg>')
  assert(clean.notes.length === 0, 'a document it read in full reports nothing at all')
})

it('a fill naming a paint server it cannot read leaves the shape unpainted, and says so', () => {
  const doc = loadSvgDocument(
    '<svg viewBox="0 0 60 60"><rect width="10" height="10" fill="url(#gone)"/></svg>',
  )
  assert(hex(onlyPath(doc)) === 'none', 'unfilled rather than in the initial black')
  assert(doc.notes.some((n) => n.kind === 'unresolved-reference' && n.detail === 'fill: url(#gone)'), 'and reported')
})

// --- references ------------------------------------------------------------------------------

it('<use> draws what it points at, wherever the definition sits', () => {
  const doc = loadSvgDocument(
    `<svg viewBox="0 0 60 60"><defs><rect id="box" width="10" height="10" fill="red"/></defs>` +
      `<use href="#box" x="20" y="30"/></svg>`,
  )
  const path = onlyPath(doc)
  assert(hex(path) === '#ff0000', "the definition's own paint comes with it")
  const points = path.contours[0].points
  assert(points.some((p) => near(p.x, 20) && near(p.y, 30)), 'and x/y place the copy')

  const symbol = loadSvgDocument(
    `<svg viewBox="0 0 60 60"><symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol>` +
      `<use href="#s" width="20" height="20"/></svg>`,
  )
  const scaled = onlyPath(symbol)
  assert(scaled.width === 20 && scaled.height === 20, "a symbol's viewBox maps onto the size the use asks for")

  const circular = loadSvgDocument(
    `<svg viewBox="0 0 60 60"><g id="loop"><use href="#loop"/></g></svg>`,
  )
  assert(pathsOf(circular).length === 0, 'a document that references its own ancestor draws nothing')
  assert(
    circular.notes.some((n) => n.kind === 'unresolved-reference' && n.detail.includes('references itself')),
    'and says so rather than recursing until the stack ends',
  )
})

it('a gradient takes what it does not declare from the one it names', () => {
  // How an editor writes a palette: one gradient holds the colours, and every use of it names
  // that one while placing itself. Each of those declares no stops of its own.
  const doc = loadSvgDocument(
    `<svg viewBox="0 0 60 60"><defs>` +
      `<linearGradient id="palette"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient>` +
      `<linearGradient id="here" xlink:href="#palette" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="60" y2="0"/>` +
      `</defs><rect width="60" height="60" fill="url(#here)"/></svg>`,
  )
  const path = onlyPath(doc)
  assert(path.fillPriority === 'linear-gradient', 'the fill resolves to the gradient')
  const stops = path.fillLinearGradientColorStops
  assert(stops.length === 2 && stops[0].color[0] === 1 && stops[1].color[2] === 1, 'with the stops it inherited')
  assert(near(path.fillLinearGradientEndPoint.x, 60), 'and its own placement, which it did declare')
  assert(doc.notes.length === 0, 'nothing was left unread')
})

it('<switch> draws one branch, not all of them', () => {
  const doc = loadSvgDocument(
    `<svg viewBox="0 0 60 60"><switch>` +
      `<rect requiredExtensions="http://example.com/ext" width="10" height="10" fill="red"/>` +
      `<rect systemLanguage="fr" width="10" height="10" fill="blue"/>` +
      `<rect width="10" height="10" fill="lime"/>` +
      `</switch></svg>`,
  )
  assert(hex(onlyPath(doc)) === '#00ff00', 'the first branch whose conditions pass, and only it')

  const french = loadSvgDocument(
    `<svg viewBox="0 0 60 60"><switch>` +
      `<rect systemLanguage="fr-CA" width="10" height="10" fill="blue"/>` +
      `<rect width="10" height="10" fill="lime"/>` +
      `</switch></svg>`,
    { systemLanguage: 'fr' },
  )
  assert(hex(onlyPath(french)) === '#0000ff', 'systemLanguage is matched on the primary subtag')
})

it('a nested <svg> is a viewport of its own', () => {
  const doc = loadSvgDocument(
    `<svg viewBox="0 0 60 60"><svg x="10" y="10" width="20" height="20" viewBox="0 0 10 10">` +
      `<rect width="10" height="10"/></svg></svg>`,
  )
  const points = onlyPath(doc).contours[0].points
  const xs = points.map((p) => p.x)
  assert(near(Math.min(...xs), 10) && near(Math.max(...xs), 30), 'placed by x/y and scaled by its own viewBox')
})

// --- properties the geometry carries ---------------------------------------------------------

it('fill-rule decides what a ring inside a ring fills', () => {
  // Both rings wound the SAME way, which is where the two rules genuinely differ.
  const rings = 'M0 0 L100 0 L100 100 L0 100 Z M25 25 L75 25 L75 75 L25 75 Z'
  const evenodd = loadSvgDocument(
    `<svg viewBox="0 0 100 100"><path fill-rule="evenodd" d="${rings}"/></svg>`,
  )
  assert(near(fillArea(onlyPath(evenodd)), 7500, 1e-3), 'evenodd: the inner ring is a hole')

  const nonzero = loadSvgDocument(`<svg viewBox="0 0 100 100"><path d="${rings}"/></svg>`)
  assert(near(fillArea(onlyPath(nonzero)), 10000, 1e-3), "nonzero, SVG's default: the same two rings are solid")

  const inherited = loadSvgDocument(
    `<svg viewBox="0 0 100 100"><g fill-rule="evenodd"><path d="${rings}"/></g></svg>`,
  )
  assert(near(fillArea(onlyPath(inherited)), 7500, 1e-3), 'and it inherits, like the rest of the paint')
})

it('stroke-dasharray reaches the outline, scaled with it', () => {
  const doc = loadSvgDocument(
    `<svg viewBox="0 0 60 60"><path d="M0 0 L60 0" stroke="black" stroke-dasharray="4 2" stroke-dashoffset="1"/></svg>`,
    { rootMatrix: [2, 0, 0, 2, 0, 0] },
  )
  const path = onlyPath(doc)
  assert(path.dash.length === 2 && path.dash[0] === 8 && path.dash[1] === 4, 'the pattern is in the scene units the points are')
  assert(path.dashOffset === 2, 'and so is the offset')

  const odd = loadSvgDocument(
    `<svg viewBox="0 0 60 60"><path d="M0 0 L60 0" stroke="black" stroke-dasharray="4"/></svg>`,
  )
  const repeated = onlyPath(odd).dash
  assert(repeated.length === 2 && repeated[0] === 4 && repeated[1] === 4, 'an odd-length list repeats to make its on/off pairs up')

  const solid = loadSvgDocument(
    `<svg viewBox="0 0 60 60"><path d="M0 0 L60 0" stroke="black" stroke-dasharray="none"/></svg>`,
  )
  assert(onlyPath(solid).dash.length === 0, "and 'none' is a solid outline")
})

it('display:none is not drawn', () => {
  const doc = loadSvgDocument(
    `<svg viewBox="0 0 60 60"><g display="none"><rect width="10" height="10"/></g>` +
      `<rect width="10" height="10" fill="red"/></svg>`,
  )
  assert(hex(onlyPath(doc)) === '#ff0000', 'the hidden subtree contributes nothing, and leaves no empty group')
})

// --- what comes back -------------------------------------------------------------------------

it('a loaded document is inert to input unless the caller asks otherwise', () => {
  const doc = loadSvgDocument('<svg viewBox="0 0 60 60"><rect width="10" height="10"/></svg>')
  assert(doc.root.listening === false, 'the artwork does not listen')

  const pickable = loadSvgDocument('<svg viewBox="0 0 60 60"><rect width="10" height="10"/></svg>', {
    listening: true,
  })
  assert(pickable.root.listening === true, 'and says so when a caller wants the paths themselves picked')
})

it('markup that is not an SVG document comes back empty rather than half-read', () => {
  const doc = loadSvgDocument('<html><body>not svg</body></html>')
  assert(pathsOf(doc).length === 0 && doc.viewBox === null, 'nothing is drawn')
  assert(doc.notes.some((n) => n.kind === 'unsupported-element'), 'and the root it found is reported')
})
