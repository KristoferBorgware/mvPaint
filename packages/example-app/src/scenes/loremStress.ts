// Shared content for the two font-rendering stress tests (msdfStressScene, vectorTextStressScene):
// deterministic "lorem ipsum" pages with randomized per-run styling, plus the 2x2 page-grid
// layout both scenes place them into. Nothing here is GPU- or implementation-specific - it
// only returns TextRun[]s and world-space positions, which Text and VectorText both accept -
// so the two scenes can build byte-identical content and differ only in which shape class
// they hand it to.
//
// The randomness is seeded and fixed, not reseeded per call: the whole point of putting these
// two scenes side by side is that the SAME word gets the SAME style in both, so a difference
// on screen is the rendering technique, never a coincidence of which scene rolled which dice.
// loremStressLayout() therefore takes no seed argument at all - hardcoding it here is what
// makes "call this from two files" the only way to reach it, rather than "remember to pass the
// same seed in both places."
//
// Each paragraph is its own node in the scene (its own pick target, its own object in either
// lane), not one node per page with embedded line breaks - which is why this module also
// stacks them: every paragraph is measured with the shared shaper BEFORE either scene builds a
// single Text or VectorText, using msdfFontProvider() (no device needed - see FontAtlas.ts), so
// each one's y-offset is its actual wrapped height, not a guess. The same measurement also
// sizes the page background, which is why a page's height is computed here rather than fixed.

import { layoutText, msdfFontProvider, Rect, Text, type Container, type RGBA, type TextRun, type TextRunStyle } from '@mvpaint/engine'
import { CRIMSON, DARK, HIGHLIGHT, NAVY, SLATE, TEAL } from './palette'

// --- page grid ------------------------------------------------------------------------

export const PAGE_COUNT = 4
export const PAGE_WIDTH = 460
export const PAGE_GAP = 60
export const PAGE_PADDING = 24
/** Body copy size, in world px - fixed rather than randomized, so wrapping stays predictable. */
export const FONT_SIZE = 15
/** Words per page - about as much running text as a printed page holds at this size. */
export const WORDS_PER_PAGE = 300
/** Line height multiplier for every paragraph - must match between measuring and drawing. */
export const PARAGRAPH_LINE_HEIGHT = 1.25
/** Gap between one paragraph's bottom and the next one's top. */
const PARAGRAPH_GAP = 26
/** Space at the top of a page reserved for its "Page N" caption, before the body starts. */
const HEADER_HEIGHT = 40
// The page background is sized from the MSDF measurement below; VectorText's real font
// metrics agree with the MSDF atlas's to within about 1%, close enough over a whole page that
// this margin (plus PARAGRAPH_GAP's slack between paragraphs) absorbs the drift either way.
const SAFETY_MARGIN = 48

export const BODY_MAX_WIDTH = PAGE_WIDTH - PAGE_PADDING * 2

const GRID_COLS = 2
const GRID_ROWS = 2

/** One paragraph's runs, ready for either Text or VectorText's `runs` option, plus where its
 * top sits relative to the page's body-start point (0 = first paragraph; more negative =
 * further down the page, matching this scene's y-up space). */
export interface LoremParagraph {
  runs: TextRun[]
  y: number
}

export interface LoremPage {
  paragraphs: LoremParagraph[]
}

export interface LoremLayout {
  pages: LoremPage[]
  /** The measured height every page's background is drawn at - see the file header. */
  pageHeight: number
  /** The top-left corner of page `index` (0-based, row-major), in world space. */
  pageOrigin: (index: number) => { x: number; y: number }
  /** The whole grid's bounds, for framing a title above it or a note below it. */
  gridTop: number
  gridBottom: number
}

// --- deterministic "random" -------------------------------------------------------------

// mulberry32: a small, fast, seeded PRNG - not cryptographic, just needs to be the same
// sequence every time, which Math.random() cannot promise.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fixed so loremStressLayout() is reproducible without a caller having to supply anything. */
const SEED = 0x6c6f7265 // 'lore'

// The classic lorem ipsum word list - words are drawn from this at random rather than the
// text being reproduced verbatim, so every page differs while still reading as "lorem ipsum".
const LOREM_WORDS =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(
    ' ',
  )

// Body text for one page, split into separate paragraph strings (no embedded line breaks -
// a paragraph break ends the current string and starts a new one) - built word-by-word so
// sentence length and paragraph breaks are randomized the same way the styling is (same rng,
// same draw order).
function loremParagraphs(rng: () => number, wordCount: number): string[] {
  const paragraphs: string[] = []
  let current = ''
  let sinceSentence = 0
  let sentenceLength = 6 + Math.floor(rng() * 10)
  let capitalizeNext = true
  for (let i = 0; i < wordCount; i++) {
    let word = LOREM_WORDS[Math.floor(rng() * LOREM_WORDS.length)]
    if (capitalizeNext) {
      word = word.charAt(0).toUpperCase() + word.slice(1)
      capitalizeNext = false
    }
    current += word
    sinceSentence++
    if (sinceSentence >= sentenceLength) {
      current += '.'
      // Roughly one paragraph break every ~5-6 sentences.
      if (rng() < 0.18) {
        paragraphs.push(current)
        current = ''
      } else {
        current += ' '
      }
      capitalizeNext = true
      sinceSentence = 0
      sentenceLength = 6 + Math.floor(rng() * 10)
    } else {
      if (rng() < 0.12) current += ','
      current += ' '
    }
  }
  if (current.trim().length > 0) paragraphs.push(current.trim())
  return paragraphs
}

// Each token is a word plus whatever whitespace follows it - splitting this way means a run
// boundary can never fall inside a word, without having to special-case punctuation.
function tokenize(text: string): string[] {
  return text.match(/\S+\s*/g) ?? []
}

const ACCENT_COLORS: readonly RGBA[] = [NAVY, TEAL, CRIMSON, SLATE]

// One run's style: mostly plain body text, with bold/italic, an accent colour, a decoration
// or a bit of tracking thrown in often enough that a page reads as "richly, randomly styled"
// rather than "occasionally styled".
function randomStyle(rng: () => number): TextRunStyle {
  const style: TextRunStyle = { fontSize: FONT_SIZE, color: DARK }

  const weight = rng()
  if (weight < 0.12) style.fontStyle = 'bold'
  else if (weight < 0.2) style.fontStyle = 'italic'
  else if (weight < 0.24) style.fontStyle = 'bold-italic'

  if (rng() < 0.35) style.color = ACCENT_COLORS[Math.floor(rng() * ACCENT_COLORS.length)]
  if (rng() < 0.08) style.underline = true
  if (rng() < 0.05) style.strikethrough = true
  if (rng() < 0.05) style.highlight = HIGHLIGHT
  if (rng() < 0.06) style.letterSpacing = 0.5 + rng() * 1.5

  return style
}

// A paragraph's tokens, chunked 3-8 words at a time, each chunk with its own randomized style.
function paragraphRuns(rng: () => number, text: string): TextRun[] {
  const tokens = tokenize(text)
  const runs: TextRun[] = []
  let i = 0
  while (i < tokens.length) {
    const n = Math.min(tokens.length - i, 3 + Math.floor(rng() * 6))
    runs.push({ text: tokens.slice(i, i + n).join(''), style: randomStyle(rng) })
    i += n
  }
  return runs
}

// --- layout: generate, measure, and cache (computed once, reused by both scenes) -------

let cachedLayout: LoremLayout | null = null

/**
 * `PAGE_COUNT` pages of styled lorem ipsum, laid out in a 2x2 grid, each page split into
 * separately-positioned paragraphs. Deterministic and memoized: every call returns the
 * identical layout - see the file header for why that's the point rather than a limitation.
 */
export function loremStressLayout(): LoremLayout {
  if (!cachedLayout) cachedLayout = computeLayout()
  return cachedLayout
}

function computeLayout(): LoremLayout {
  const rng = mulberry32(SEED)
  const provider = msdfFontProvider()

  let tallestBody = 0
  const pages: LoremPage[] = []
  for (let p = 0; p < PAGE_COUNT; p++) {
    const texts = loremParagraphs(rng, WORDS_PER_PAGE)
    let y = 0
    const paragraphs: LoremParagraph[] = texts.map((text) => {
      const runs = paragraphRuns(rng, text)
      const paragraph: LoremParagraph = { runs, y }
      const shaped = layoutText(runs, { maxWidth: BODY_MAX_WIDTH, lineHeight: PARAGRAPH_LINE_HEIGHT }, provider)
      y -= shaped.height + PARAGRAPH_GAP
      return paragraph
    })
    // Back out the trailing gap after the last paragraph - it isn't part of the body.
    tallestBody = Math.max(tallestBody, -y - PARAGRAPH_GAP)
    pages.push({ paragraphs })
  }

  const pageHeight = Math.ceil(HEADER_HEIGHT + tallestBody + PAGE_PADDING + SAFETY_MARGIN)
  const totalWidth = GRID_COLS * PAGE_WIDTH + (GRID_COLS - 1) * PAGE_GAP
  const totalHeight = GRID_ROWS * pageHeight + (GRID_ROWS - 1) * PAGE_GAP

  const pageOrigin = (index: number): { x: number; y: number } => {
    const col = index % GRID_COLS
    const row = Math.floor(index / GRID_COLS)
    return {
      x: -totalWidth / 2 + col * (PAGE_WIDTH + PAGE_GAP),
      y: totalHeight / 2 - row * (pageHeight + PAGE_GAP),
    }
  }

  return { pages, pageHeight, pageOrigin, gridTop: totalHeight / 2, gridBottom: -totalHeight / 2 }
}

// --- shared page chrome ------------------------------------------------------------------

/**
 * The paper background and "Page N" caption for page `index` - decorative, and identical
 * between the two scenes, so a difference in the actual body text is never a difference in
 * the surrounding chrome. Returns where the first paragraph's top should sit (inside the
 * padding, below the caption); each later paragraph adds its own `y` from the layout to this
 * same point.
 */
export function addPageFrame(root: Container, index: number, layout: LoremLayout): { x: number; y: number } {
  const origin = layout.pageOrigin(index)

  const background = new Rect({
    name: `lorem-page-bg-${index}`,
    x: origin.x + PAGE_WIDTH / 2,
    y: origin.y - layout.pageHeight / 2,
    width: PAGE_WIDTH,
    height: layout.pageHeight,
    fill: [0.99, 0.99, 1, 1],
    stroke: SLATE,
    strokeWidth: 1.5,
  })
  // Decorative paper, not content - clicking it shouldn't compete with the text on top of it.
  background.pickable = false
  root.addChild(background)

  root.addChild(
    new Text({
      name: `lorem-page-label-${index}`,
      x: origin.x + PAGE_PADDING,
      y: origin.y - PAGE_PADDING - 14,
      text: `Page ${index + 1}`,
      style: { fontStyle: 'bold', fontSize: 13, color: SLATE },
    }),
  )

  return { x: origin.x + PAGE_PADDING, y: origin.y - PAGE_PADDING - HEADER_HEIGHT }
}
