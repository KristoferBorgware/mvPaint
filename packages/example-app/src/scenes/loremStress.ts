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
// buildLoremPages() therefore takes no seed argument at all - hardcoding it here is what makes
// "call this from two files" the only way to reach it, rather than "remember to pass the same
// seed in both places."

import { Rect, Text, type Container, type RGBA, type TextRun, type TextRunStyle } from '@mvpaint/engine'
import { CRIMSON, DARK, HIGHLIGHT, NAVY, SLATE, TEAL } from './palette'

// --- page grid, shared so both scenes draw identically positioned paper -------------------

export const PAGE_COUNT = 4
export const PAGE_WIDTH = 460
// Measured, not guessed: 300 words at FONT_SIZE wrapped to PAGE_WIDTH - 2*PAGE_PADDING run
// 41-45 lines and 930-1020 units tall (worst case across the four pages' actual random
// styling, since bold/italic runs and letterSpacing shift line breaks slightly per page).
// 1120 leaves headroom for both, plus the page label above the body copy.
export const PAGE_HEIGHT = 1120
export const PAGE_GAP = 60
export const PAGE_PADDING = 24
/** Body copy size, in world px - fixed rather than randomized, so page height stays predictable. */
export const FONT_SIZE = 15
/** Words per page - about as much running text as a printed page holds at this size. */
export const WORDS_PER_PAGE = 300

const GRID_COLS = 2
const GRID_ROWS = 2
const TOTAL_WIDTH = GRID_COLS * PAGE_WIDTH + (GRID_COLS - 1) * PAGE_GAP
const TOTAL_HEIGHT = GRID_ROWS * PAGE_HEIGHT + (GRID_ROWS - 1) * PAGE_GAP

/** The top-left corner of page `index` (0-based, row-major), in world space. */
export function pageOrigin(index: number): { x: number; y: number } {
  const col = index % GRID_COLS
  const row = Math.floor(index / GRID_COLS)
  return {
    x: -TOTAL_WIDTH / 2 + col * (PAGE_WIDTH + PAGE_GAP),
    y: TOTAL_HEIGHT / 2 - row * (PAGE_HEIGHT + PAGE_GAP),
  }
}

/** The whole grid's bounds, for framing a title above it or a note below it. */
export const GRID_BOUNDS = { width: TOTAL_WIDTH, height: TOTAL_HEIGHT, top: TOTAL_HEIGHT / 2, bottom: -TOTAL_HEIGHT / 2 }

// --- deterministic "random" ----------------------------------------------------------------

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

/** Fixed so buildLoremPages() is reproducible without a caller having to supply anything. */
const SEED = 0x6c6f7265 // 'lore'

// The classic lorem ipsum word list - words are drawn from this at random rather than the
// text being reproduced verbatim, so every page differs while still reading as "lorem ipsum".
const LOREM_WORDS =
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(
    ' ',
  )

/** One page's runs, ready to hand to either Text or VectorText's `runs` option. */
export interface LoremPage {
  runs: TextRun[]
}

// Body text plus punctuation and paragraph breaks, built word-by-word so sentence length and
// paragraph breaks are randomized the same way the styling is (same rng, same draw order).
function loremText(rng: () => number, wordCount: number): string {
  let out = ''
  let sinceSentence = 0
  let sentenceLength = 6 + Math.floor(rng() * 10)
  let capitalizeNext = true
  for (let i = 0; i < wordCount; i++) {
    let word = LOREM_WORDS[Math.floor(rng() * LOREM_WORDS.length)]
    if (capitalizeNext) {
      word = word.charAt(0).toUpperCase() + word.slice(1)
      capitalizeNext = false
    }
    out += word
    sinceSentence++
    if (sinceSentence >= sentenceLength) {
      // Roughly one paragraph break every ~5-6 sentences.
      out += rng() < 0.18 ? '.\n\n' : '. '
      capitalizeNext = true
      sinceSentence = 0
      sentenceLength = 6 + Math.floor(rng() * 10)
    } else {
      if (rng() < 0.12) out += ','
      out += ' '
    }
  }
  return out.trim()
}

// Each token is a word plus whatever whitespace follows it (a single space, or a paragraph
// break) - splitting this way means a run boundary can never fall inside a word, without
// having to special-case punctuation or newlines separately.
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

/**
 * `PAGE_COUNT` pages of styled lorem ipsum. Deterministic: every call returns the identical
 * pages, words, and styles - see the file header for why that's the point rather than a
 * limitation. Runs are chunked 3-8 words at a time, each with its own randomized style, so a
 * page reads as continuous prose while still exercising per-run materials throughout.
 */
export function buildLoremPages(): LoremPage[] {
  const rng = mulberry32(SEED)
  const pages: LoremPage[] = []
  for (let p = 0; p < PAGE_COUNT; p++) {
    const tokens = tokenize(loremText(rng, WORDS_PER_PAGE))
    const runs: TextRun[] = []
    let i = 0
    while (i < tokens.length) {
      const n = Math.min(tokens.length - i, 3 + Math.floor(rng() * 6))
      runs.push({ text: tokens.slice(i, i + n).join(''), style: randomStyle(rng) })
      i += n
    }
    pages.push({ runs })
  }
  return pages
}

// --- shared page chrome ---------------------------------------------------------------

/**
 * The paper background and "Page N" caption for page `index` - decorative, and identical
 * between the two scenes, so a difference in the actual body text is never a difference in
 * the surrounding chrome. Returns where the body copy should start (inside the padding,
 * below the caption).
 */
export function addPageFrame(root: Container, index: number): { x: number; y: number } {
  const origin = pageOrigin(index)

  const background = new Rect({
    name: `lorem-page-bg-${index}`,
    x: origin.x + PAGE_WIDTH / 2,
    y: origin.y - PAGE_HEIGHT / 2,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
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

  return { x: origin.x + PAGE_PADDING, y: origin.y - PAGE_PADDING - 40 }
}
