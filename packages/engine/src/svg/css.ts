// The stylesheet an SVG document carries in its <style> elements, and which of its rules apply
// to an element.
//
// A document may say its paint three ways, and they are not equal:
//
//   <rect fill="red"/>                 a PRESENTATION ATTRIBUTE, the weakest of the three
//   <style>.a{fill:red}</style>        a CSS RULE, which beats every presentation attribute
//   <rect style="fill:red"/>           the element's own inline style, which beats both
//
// The middle one is what an SVG editor emits when a drawing shares a palette - one class per
// colour, one rule per class - and it is why the cascade order matters more than it looks. SVG
// 1.1 6.4 defines a presentation attribute as an author rule of specificity 0 at the start of
// the stylesheet, so ANY rule in a <style> block outranks it. Ordering the two the intuitive way
// round paints such a document in the initial fill, which is black rather than nothing.
//
// SELECTORS: type (`rect`), class (`.a`), id (`#a`), the universal `*`, any of those compounded
// (`rect.a#b`), joined by descendant (` `) or child (`>`) combinators, and grouped with commas.
// That is every selector this library of 80,609 documents contains, and every one an editor is
// known to write. Anything else - a pseudo-class, an attribute selector, a sibling combinator -
// is DROPPED RATHER THAN APPROXIMATED, and reported: applying `.a:hover` as `.a` paints a
// hover colour permanently, which is worse than not painting it.
//
// It is text in and declarations out, no DOM, so what an element IS arrives as StyledElement -
// a tag, an id, a class list and a parent - and the caller says how it reads those off whatever
// it holds.

/** A property table, as `fill` -> `#cad0d7`. Property names are lowercased; values are not. */
export type CssDeclarations = Record<string, string>

/** What a selector is matched against: one element, and the chain it hangs from. */
export interface StyledElement {
  /** Lowercased tag name. */
  tag: string
  id: string | null
  /** The `class` attribute, split on whitespace. */
  classes: readonly string[]
  parent: StyledElement | null
}

/** What a stylesheet could not be read as - see SvgNote, which this is reported through. */
export interface CssSkip {
  kind: 'unsupported-selector' | 'unsupported-property'
  detail: string
}

/** One `tag#id.class.class` step of a selector. */
interface Compound {
  tag: string | null
  id: string | null
  classes: string[]
}

/**
 * A compiled rule. `steps` runs RIGHTMOST FIRST - the element itself, then what must be above
 * it - because that is the order matching walks them in.
 */
export interface CssRule {
  /** As written, for reporting. */
  selector: string
  steps: { combinator: 'descendant' | 'child'; compound: Compound }[]
  /** ids * 10000 + classes * 100 + types, the CSS cascade's own ordering. */
  specificity: number
  /** Position in the stylesheet; what breaks a tie in specificity. */
  order: number
  declarations: CssDeclarations
}

/** Comments can sit anywhere, including inside a selector, so they go first. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * One compound - `rect#a.b.c` or `*` - or null for anything this does not read.
 *
 * Written as a scanner rather than one regular expression so that an unsupported selector is
 * recognised by the character that makes it one (`:`, `[`, `+`, `~`) rather than by failing to
 * match and leaving nobody able to say why.
 */
function parseCompound(text: string): Compound | null {
  const compound: Compound = { tag: null, id: null, classes: [] }
  let i = 0
  let read = false
  while (i < text.length) {
    const ch = text[i]
    if (ch === '*') {
      i++
      read = true
      continue
    }
    if (ch === '.' || ch === '#') {
      const name = /^[-\w\u00a0-\uffff]+/.exec(text.slice(i + 1))
      if (!name) return null
      if (ch === '.') compound.classes.push(name[0])
      else compound.id = name[0]
      i += 1 + name[0].length
      read = true
      continue
    }
    const tag = /^[-\w\u00a0-\uffff]+/.exec(text.slice(i))
    if (!tag || compound.tag !== null) return null
    compound.tag = tag[0].toLowerCase()
    i += tag[0].length
    read = true
  }
  return read ? compound : null
}

/** A whole selector into its steps, rightmost first, or null when part of it is not read. */
function parseSelector(text: string): CssRule['steps'] | null {
  const parts = text.trim().split(/\s*(>)\s*|\s+/).filter((part) => part !== undefined && part !== '')
  if (parts.length === 0) return null

  const steps: CssRule['steps'] = []
  let combinator: 'descendant' | 'child' = 'descendant'
  // Left to right, pushing each compound onto the front, so the list comes out rightmost first
  // and each step carries the combinator that links it to the step on its right.
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '>') {
      if (steps.length === 0) return null
      steps[0].combinator = 'child'
      continue
    }
    const compound = parseCompound(parts[i])
    if (!compound) return null
    steps.unshift({ combinator, compound })
    combinator = 'descendant'
  }
  // The rightmost step is the element itself; nothing links it to anything.
  steps[0].combinator = 'descendant'
  return steps
}

function specificityOf(steps: CssRule['steps']): number {
  let ids = 0
  let classes = 0
  let types = 0
  for (const step of steps) {
    if (step.compound.id) ids++
    classes += step.compound.classes.length
    if (step.compound.tag) types++
  }
  return ids * 10000 + classes * 100 + types
}

/**
 * The declarations of one `{ ... }` body.
 *
 * `!important` is dropped and the declaration kept at ordinary weight. The flag only decides
 * which of two rules that both set a property wins, and a document that sets the same property
 * twice is rare; a document whose only rule for a property carries the flag is not, and dropping
 * that declaration would paint the element in the initial black instead.
 */
function parseDeclarations(body: string, skipped: CssSkip[]): CssDeclarations {
  const declarations: CssDeclarations = {}
  for (const piece of body.split(';')) {
    const colon = piece.indexOf(':')
    if (colon === -1) continue
    const property = piece.slice(0, colon).trim().toLowerCase()
    let value = piece.slice(colon + 1).trim()
    if (!property || !value) continue
    if (property.startsWith('--')) {
      skipped.push({ kind: 'unsupported-property', detail: property })
      continue
    }
    if (/\bvar\s*\(/.test(value)) {
      skipped.push({ kind: 'unsupported-property', detail: `${property}: var()` })
      continue
    }
    if (/!\s*important\s*$/.test(value)) {
      skipped.push({ kind: 'unsupported-property', detail: '!important' })
      value = value.replace(/!\s*important\s*$/, '').trim()
    }
    declarations[property] = value
  }
  return declarations
}

/** Where the block opened at `open` closes, or the end of the text. */
function endOfBlock(css: string, open: number): number {
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return i
  }
  return css.length
}

/**
 * Every rule in a stylesheet, in document order.
 *
 * At-rules are skipped whole - `@media` narrows to a viewport this has none of, `@import` is a
 * fetch, `@font-face` is a typeface the engine loads its own way - and each is reported. A
 * selector that is not read is reported and dropped; the rest of its rule group still applies,
 * so `.a, .b:hover { fill: red }` still paints `.a`.
 */
export function parseStylesheet(css: string, order = 0): { rules: CssRule[]; skipped: CssSkip[] } {
  const text = stripComments(css)
  const rules: CssRule[] = []
  const skipped: CssSkip[] = []
  let i = 0
  let next = order

  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++
    if (i >= text.length) break

    if (text[i] === '@') {
      const name = /^@[-\w]+/.exec(text.slice(i))?.[0] ?? '@'
      const semicolon = text.indexOf(';', i)
      const brace = text.indexOf('{', i)
      skipped.push({ kind: 'unsupported-selector', detail: name })
      if (brace === -1 || (semicolon !== -1 && semicolon < brace)) {
        i = semicolon === -1 ? text.length : semicolon + 1
      } else {
        i = endOfBlock(text, brace) + 1
      }
      continue
    }

    const brace = text.indexOf('{', i)
    if (brace === -1) break
    const close = endOfBlock(text, brace)
    const prelude = text.slice(i, brace)
    const declarations = parseDeclarations(text.slice(brace + 1, close), skipped)
    i = close + 1
    if (Object.keys(declarations).length === 0) continue

    for (const one of prelude.split(',')) {
      const selector = one.trim()
      if (!selector) continue
      const steps = parseSelector(selector)
      if (!steps) {
        skipped.push({ kind: 'unsupported-selector', detail: selector })
        continue
      }
      rules.push({ selector, steps, specificity: specificityOf(steps), order: next++, declarations })
    }
  }
  return { rules, skipped }
}

function matchesCompound(compound: Compound, element: StyledElement): boolean {
  if (compound.tag !== null && compound.tag !== element.tag) return false
  if (compound.id !== null && compound.id !== element.id) return false
  return compound.classes.every((name) => element.classes.includes(name))
}

/**
 * Whether the steps from `index` on match `element` and its ancestors.
 *
 * A descendant step tries every ancestor rather than the nearest match, and recurses so that a
 * failure further up sends it back to try the next one - `a b c` against a chain where the first
 * `b` found leads nowhere but a higher one does still matches, as CSS says it must.
 */
function matchesFrom(steps: CssRule['steps'], index: number, element: StyledElement | null): boolean {
  if (index >= steps.length) return true
  if (!element) return false
  if (!matchesCompound(steps[index].compound, element)) return false
  if (index + 1 >= steps.length) return true

  if (steps[index + 1].combinator === 'child') {
    return matchesFrom(steps, index + 1, element.parent)
  }
  for (let up = element.parent; up !== null; up = up.parent) {
    if (matchesFrom(steps, index + 1, up)) return true
  }
  return false
}

export function matches(rule: CssRule, element: StyledElement): boolean {
  return matchesFrom(rule.steps, 0, element)
}

/**
 * The declarations that reach one element, already resolved: every matching rule applied
 * weakest first, so what comes back is one property table where the winner has already won.
 *
 * Weakest first is by specificity, then by position in the stylesheet - the ordinary cascade,
 * with the two levels a document can also say a property at (the presentation attribute below
 * this and the inline style above it) applied by the caller around it.
 */
export function declarationsFor(rules: readonly CssRule[], element: StyledElement): CssDeclarations {
  const applying = rules.filter((rule) => matches(rule, element))
  if (applying.length === 0) return {}
  applying.sort((a, b) => a.specificity - b.specificity || a.order - b.order)
  const declarations: CssDeclarations = {}
  for (const rule of applying) Object.assign(declarations, rule.declarations)
  return declarations
}

/** An inline `style="fill:red;stroke:none"` as its declarations. */
export function parseInlineStyle(style: string | null | undefined): CssDeclarations {
  if (!style) return {}
  return parseDeclarations(style, [])
}
