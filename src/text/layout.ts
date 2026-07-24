// Text shaping: turn styled runs into positioned quads for the text lane. It resolves each run
// to a font atlas, lays glyphs out with kerning and letter-spacing, greedily wraps to an
// optional max width, breaks on '\n', aligns each line, and emits three kinds of quad -
// highlight backgrounds (behind), glyph quads (MSDF), and underline/strikethrough lines (in
// front). Every run becomes one material (transform + fill/gradient + per-letter stroke),
// referenced by its quads. Coordinates are the node's local text space: origin at the top-left
// of the block, +x right, +y up, first line's top at y = 0 (lines descend to negative y).

import type { FillPriority, GradientStop, Point2, RGBA } from '../render/meshFormat'
import type { FontStyle } from './FontAtlas'
import { glyphFor, kerningFor, type FontMetrics, type Glyph } from './msdfMetrics'

/**
 * The slice of a font source the shaper needs: a style's metrics and its atlas index. FontBook
 * satisfies this; decoupling it lets the shaper run (and be tested) without any GPU objects.
 */
export interface FontProvider {
  atlas(style: FontStyle): { metrics: FontMetrics }
  indexOf(style: FontStyle): number
}

export interface TextGradient {
  type: 'linear' | 'radial'
  start: Point2
  end: Point2
  /** Radial only; ignored for linear. */
  startRadius?: number
  endRadius?: number
  stops: GradientStop[]
}

export interface TextRunStyle {
  fontStyle?: FontStyle // default 'regular'
  fontSize?: number // px, default 32
  /** Solid fill color; ignored when `gradient` is set. */
  color?: RGBA
  gradient?: TextGradient
  strokeColor?: RGBA
  /** Per-letter outline width in world px; 0 = no outline. */
  strokeWidth?: number
  underline?: boolean
  strikethrough?: boolean
  /** Background highlight color drawn behind the run. */
  highlight?: RGBA
  /** Extra tracking in world px between glyphs. */
  letterSpacing?: number
}

export interface TextRun {
  text: string
  style?: TextRunStyle
}

export type TextAlign = 'left' | 'center' | 'right'

export interface TextLayoutOptions {
  align?: TextAlign
  /** Wrap width in world px; undefined = no wrapping (breaks only on '\n'). */
  maxWidth?: number
  /** Line-height multiplier over the font's own line height; default 1. */
  lineHeight?: number
}

/** Per-run material: transform-independent fill/gradient + per-letter stroke + atlas range. */
export interface TextMaterial {
  fillPriority: FillPriority
  gradientStart: Point2
  gradientStartRadius: number
  gradientEnd: Point2
  gradientEndRadius: number
  stops: GradientStop[]
  strokeColor: RGBA
  strokeWidth: number
  distanceRange: number
}

/** One axis-aligned quad in node-local space (y-up). Glyph quads also carry an atlas uv rect. */
export interface TextQuad {
  material: number
  atlasIndex: number
  isGlyph: boolean
  x0: number
  y0: number
  x1: number
  y1: number
  u0: number
  v0: number
  u1: number
  v1: number
  color: RGBA
}

export interface ShapedText {
  quads: TextQuad[]
  materials: TextMaterial[]
  width: number
  height: number
  lineCount: number
}

const BLACK: RGBA = [0, 0, 0, 1]
const ORIGIN: Point2 = { x: 0, y: 0 }

// One laid-out character (a glyph, or a space/blank that only advances the pen).
interface Entry {
  run: number
  atlasIndex: number
  metrics: FontMetrics
  scale: number
  fontSize: number
  cp: number
  glyph: Glyph | undefined
  isSpace: boolean
  advance: number // pen advance in world px (xadvance*scale + letterSpacing)
  letterSpacing: number
  color: RGBA
  underline: boolean
  strikethrough: boolean
  highlight: RGBA | undefined
}

function materialForRun(style: TextRunStyle, distanceRange: number): TextMaterial {
  const g = style.gradient
  let fillPriority: FillPriority = 'color'
  if (g) fillPriority = g.type === 'radial' ? 'radial-gradient' : 'linear-gradient'
  return {
    fillPriority,
    gradientStart: g ? g.start : ORIGIN,
    gradientStartRadius: g?.startRadius ?? 0,
    gradientEnd: g ? g.end : ORIGIN,
    gradientEndRadius: g?.endRadius ?? 0,
    stops: g ? g.stops : [],
    strokeColor: style.strokeColor ?? BLACK,
    strokeWidth: style.strokeColor ? (style.strokeWidth ?? 0) : 0,
    distanceRange,
  }
}

/** Shape styled runs into positioned quads + per-run materials. */
export function layoutText(
  runs: readonly TextRun[],
  options: TextLayoutOptions,
  fonts: FontProvider,
): ShapedText {
  const lineHeightMult = options.lineHeight ?? 1
  const materials: TextMaterial[] = []

  // Flatten runs into a single entry stream (glyphs, spaces, and hard '\n' breaks as null).
  const stream: (Entry | null)[] = []
  let fallback: { ascent: number; descent: number } | null = null

  runs.forEach((run, runIndex) => {
    const style = run.style ?? {}
    const fontStyle = style.fontStyle ?? 'regular'
    const fontSize = style.fontSize ?? 32
    const atlas = fonts.atlas(fontStyle)
    const metrics = atlas.metrics
    const atlasIndex = fonts.indexOf(fontStyle)
    const scale = fontSize / metrics.size
    const letterSpacing = style.letterSpacing ?? 0
    const color = style.color ?? style.gradient?.stops[0]?.color ?? BLACK
    const highlight = style.highlight

    materials.push(materialForRun(style, metrics.distanceRange))
    if (!fallback) {
      fallback = { ascent: metrics.base * scale, descent: (metrics.lineHeight - metrics.base) * scale }
    }

    for (const ch of run.text) {
      const cp = ch.codePointAt(0) ?? 0
      if (cp === 13) continue // ignore carriage returns
      if (cp === 10) {
        stream.push(null) // hard line break
        continue
      }
      const glyph = glyphFor(metrics, cp)
      const isSpace = cp === 32 || glyph === undefined
      const xadvance = glyph ? glyph.xadvance : (metrics.glyphs.get(32)?.xadvance ?? metrics.size * 0.3)
      stream.push({
        run: runIndex,
        atlasIndex,
        metrics,
        scale,
        fontSize,
        cp,
        glyph: isSpace ? undefined : glyph,
        isSpace,
        advance: xadvance * scale + letterSpacing,
        letterSpacing,
        color,
        underline: style.underline ?? false,
        strikethrough: style.strikethrough ?? false,
        highlight,
      })
    }
  })

  // Group into words (non-space runs) separated by spaces / breaks, for greedy wrapping.
  type Token = { kind: 'word'; entries: Entry[]; width: number } | { kind: 'space'; advance: number } | { kind: 'break' }
  const tokens: Token[] = []
  let word: Entry[] = []
  const flushWord = () => {
    if (word.length === 0) return
    tokens.push({ kind: 'word', entries: word, width: wordWidth(word) })
    word = []
  }
  for (const e of stream) {
    if (e === null) {
      flushWord()
      tokens.push({ kind: 'break' })
    } else if (e.isSpace) {
      flushWord()
      tokens.push({ kind: 'space', advance: e.advance })
    } else {
      word.push(e)
    }
  }
  flushWord()

  // Greedy line assembly. A line is a list of word-entry groups; spaces contribute width only.
  const maxWidth = options.maxWidth
  const lines: Entry[][] = []
  let line: Entry[] = []
  let lineWidth = 0
  let pendingSpace = 0
  const flushLine = () => {
    lines.push(line)
    line = []
    lineWidth = 0
    pendingSpace = 0
  }
  for (const token of tokens) {
    if (token.kind === 'break') {
      flushLine()
    } else if (token.kind === 'space') {
      pendingSpace = token.advance
    } else {
      const gap = line.length > 0 ? pendingSpace : 0
      if (maxWidth !== undefined && line.length > 0 && lineWidth + gap + token.width > maxWidth) {
        flushLine()
        line.push(...token.entries)
        lineWidth = token.width
      } else {
        lineWidth += gap
        // Represent the inter-word space as a spacer entry so placement advances the pen.
        if (gap > 0) line.push(spacer(gap))
        line.push(...token.entries)
        lineWidth += token.width
      }
      pendingSpace = 0
    }
  }
  flushLine()

  return placeLines(lines, materials, options.align ?? 'left', maxWidth, lineHeightMult, fallback)
}

// Width of a word including internal kerning (glyphs within a word share a run).
function wordWidth(entries: Entry[]): number {
  let w = 0
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (i > 0) {
      const prev = entries[i - 1]
      if (prev.run === e.run) w += kerningFor(e.metrics, prev.cp, e.cp) * e.scale
    }
    w += e.advance
  }
  return w
}

// A zero-glyph entry that only advances the pen (used for inter-word spaces on a line).
function spacer(advance: number): Entry {
  return {
    run: -1,
    atlasIndex: 0,
    metrics: null as unknown as FontMetrics,
    scale: 1,
    fontSize: 0,
    cp: 32,
    glyph: undefined,
    isSpace: true,
    advance,
    letterSpacing: 0,
    color: BLACK,
    underline: false,
    strikethrough: false,
    highlight: undefined,
  }
}

function lineExtent(entries: Entry[]): number {
  let pen = 0
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (i > 0 && e.run >= 0) {
      const prev = entries[i - 1]
      if (prev.run === e.run) pen += kerningFor(e.metrics, prev.cp, e.cp) * e.scale
    }
    pen += e.advance
  }
  return pen
}

function placeLines(
  lines: Entry[][],
  materials: TextMaterial[],
  align: TextAlign,
  maxWidth: number | undefined,
  lineHeightMult: number,
  fallback: { ascent: number; descent: number } | null,
): ShapedText {
  const fb = fallback ?? { ascent: 0, descent: 0 }
  const highlights: TextQuad[] = []
  const glyphs: TextQuad[] = []
  const decorations: TextQuad[] = []

  const widths = lines.map(lineExtent)
  const blockWidth = maxWidth ?? Math.max(0, ...widths)

  let topY = 0
  lines.forEach((entries, li) => {
    let ascent = fb.ascent
    let descent = fb.descent
    for (const e of entries) {
      if (e.run < 0) continue
      ascent = Math.max(ascent, e.metrics.base * e.scale)
      descent = Math.max(descent, (e.metrics.lineHeight - e.metrics.base) * e.scale)
    }
    const baselineY = topY - ascent
    const alignOffset = align === 'left' ? 0 : align === 'right' ? blockWidth - widths[li] : (blockWidth - widths[li]) / 2

    // Place glyphs left-to-right, accumulating per-run spans for decorations/highlights. A run
    // appears as one contiguous span per line (runs are ordered), and inter-word spacers
    // (run -1) keep the current span open so decorations run continuously across spaces.
    let pen = alignOffset
    let spanRun = -1
    let spanStart = 0
    let spanEnd = 0
    let spanEntry: Entry | null = null
    const flushSpan = () => {
      if (spanEntry && spanEnd > spanStart) {
        emitRunDecorations(spanEntry, spanStart, spanEnd, baselineY, highlights, decorations)
      }
      spanEntry = null
      spanRun = -1
    }

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (i > 0 && e.run >= 0 && entries[i - 1].run === e.run) {
        pen += kerningFor(e.metrics, entries[i - 1].cp, e.cp) * e.scale
      }
      if (e.run >= 0) {
        if (e.run !== spanRun) {
          flushSpan()
          spanRun = e.run
          spanStart = pen
          spanEntry = e
        }
        spanEnd = pen + e.advance
      }
      if (e.glyph) {
        const g = e.glyph
        const leftX = pen + g.xoffset * e.scale
        const topGY = baselineY + (e.metrics.base - g.yoffset) * e.scale
        glyphs.push({
          material: e.run,
          atlasIndex: e.atlasIndex,
          isGlyph: true,
          x0: leftX,
          y0: topGY - g.height * e.scale,
          x1: leftX + g.width * e.scale,
          y1: topGY,
          u0: g.u0,
          v0: g.v0,
          u1: g.u1,
          v1: g.v1,
          color: e.color,
        })
      }
      pen += e.advance
    }
    flushSpan()

    topY -= (ascent + descent) * lineHeightMult
  })

  return {
    quads: [...highlights, ...glyphs, ...decorations],
    materials,
    width: blockWidth,
    height: -topY,
    lineCount: lines.length,
  }
}

// Emit the highlight background (behind) and underline/strikethrough lines (in front) for one
// run's contiguous span on a line, using that run's font-derived decoration metrics.
function emitRunDecorations(
  e: Entry,
  startX: number,
  endX: number,
  baselineY: number,
  highlights: TextQuad[],
  decorations: TextQuad[],
): void {
  const solid = (x0: number, y0: number, x1: number, y1: number, color: RGBA, out: TextQuad[]) => {
    out.push({ material: e.run, atlasIndex: e.atlasIndex, isGlyph: false, x0, y0, x1, y1, u0: 0, v0: 0, u1: 0, v1: 0, color })
  }
  if (e.highlight) {
    const ascent = e.metrics.base * e.scale
    const descent = (e.metrics.lineHeight - e.metrics.base) * e.scale
    solid(startX, baselineY - descent, endX, baselineY + ascent, e.highlight, highlights)
  }
  const dec = e.metrics.decoration
  if (e.underline) {
    const cy = baselineY + dec.underlineOffset * e.fontSize
    const th = dec.underlineThickness * e.fontSize
    solid(startX, cy - th / 2, endX, cy + th / 2, e.color, decorations)
  }
  if (e.strikethrough) {
    const cy = baselineY + dec.strikeOffset * e.fontSize
    const th = dec.strikeThickness * e.fontSize
    solid(startX, cy - th / 2, endX, cy + th / 2, e.color, decorations)
  }
}
