// Text shaping: turn styled runs into positioned quads for the text lane. It resolves each run
// to a font atlas (synthesizing a missing weight/slant as faux bold/italic), lays glyphs out
// with kerning, letter-spacing, and baseline shift, greedily wraps to an optional max width,
// breaks on '\n', aligns each line (left/center/right/justify), and emits quads back-to-front:
// highlight backgrounds, drop shadows, soft glows, glyph bodies, then underline/strikethrough.
// Horizontal text supports left-to-right and (mechanically mirrored) right-to-left; a vertical
// orientation stacks glyphs top-to-bottom in right-to-left columns. Every run becomes one or
// more materials (fill/gradient + per-letter stroke + coverage dilation) referenced by its
// quads. Coordinates are the node's local space: +x right, +y up, the block's top-left at the
// origin (horizontal lines descend to negative y; vertical columns extend to negative x).

import type { FillPriority, GradientStop, Point2, RGBA } from '../render/meshFormat'
import type { FontStyle } from './FontAtlas'
import { glyphFor, kerningFor, type FontMetrics, type Glyph } from './msdfMetrics'

export interface TextGradient {
  type: 'linear' | 'radial'
  start: Point2
  end: Point2
  /** Radial only; ignored for linear. */
  startRadius?: number
  endRadius?: number
  stops: GradientStop[]
}

/**
 * Text's drop shadow: a duplicate of the run's glyphs, drawn behind them at an offset in
 * the shadow's colour. Deliberately NOT the canvas blur model the mesh lane's Shape.shadow*
 * properties implement - a glyph has no rasterized silhouette to blur here, so text takes
 * the cheap, crisp duplicate instead. `offsetY` is downward-positive, matching Shape's.
 */
export interface TextShadow {
  color: RGBA
  offsetX: number
  offsetY: number
  /** Multiplies `color`'s own alpha. Default 1. */
  opacity?: number
}

/** Soft glow: a dilated copy of the glyphs behind them; `radius` is the spread in world px. */
export interface TextGlow {
  color: RGBA
  radius: number
  /** Multiplies `color`'s own alpha. Default 1. */
  opacity?: number
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
  /** Vertical shift from the baseline in world px (+up = superscript, -down = subscript). */
  baselineShift?: number
  /** Force synthetic bold (distance dilation) on top of the resolved atlas. */
  fauxBold?: boolean
  /** Force synthetic italic (horizontal shear) on top of the resolved atlas. */
  fauxItalic?: boolean
  /** Drop shadow: an offset copy of the glyphs drawn behind them. */
  shadow?: TextShadow
  glow?: TextGlow
}

export interface TextRun {
  text: string
  style?: TextRunStyle
}

export type TextAlign = 'left' | 'center' | 'right' | 'justify'
export type TextDirection = 'ltr' | 'rtl'
export type TextOrientation = 'horizontal' | 'vertical'

export interface TextLayoutOptions {
  align?: TextAlign
  /** Wrap width in world px; undefined = no wrapping (breaks only on '\n'). */
  maxWidth?: number
  /** Line-height multiplier over the font's line height; default 1. */
  lineHeight?: number
  /** Horizontal flow direction; ignored when orientation is vertical. Default 'ltr'. */
  direction?: TextDirection
  /** 'horizontal' (default) flows in lines; 'vertical' stacks glyphs in right-to-left columns. */
  orientation?: TextOrientation
}

/** The slice of a font source the shaper needs: metrics, atlas index, and synthesis flags. */
export interface ResolvedStyle {
  metrics: FontMetrics
  atlasIndex: number
  fauxBold: boolean
  fauxItalic: boolean
}

export interface FontProvider {
  resolve(style: FontStyle): ResolvedStyle
}

/** Per-run material: transform-independent fill/gradient + per-letter stroke + coverage dilation. */
export interface TextMaterial {
  fillPriority: FillPriority
  gradientStart: Point2
  gradientStartRadius: number
  gradientEnd: Point2
  gradientEndRadius: number
  stops: GradientStop[]
  strokeColor: RGBA
  strokeWidth: number
  /** Extra coverage in world px (faux bold, glow spread) - a hard distance offset. */
  dilate: number
  distanceRange: number
}

/** One quad in node-local space (y-up). Glyph quads carry an atlas uv rect; `skew` shears x. */
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
  /** Faux-italic shear factor: each corner's x is offset by skew*(y - skewPivotY). */
  skew: number
  skewPivotY: number
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
const FAUX_BOLD_DILATE = 0.03 // fraction of font size, in world px
const FAUX_ITALIC_SKEW = 0.24 // tangent of the shear angle

// A run resolved to its atlas + materials, shared by every entry of the run.
interface RunResolved {
  metrics: FontMetrics
  atlasIndex: number
  scale: number
  fontSize: number
  letterSpacing: number
  baselineShift: number
  color: RGBA
  underline: boolean
  strikethrough: boolean
  highlight: RGBA | undefined
  skew: number
  mainMaterial: number
  shadowMaterial: number
  glowMaterial: number
  shadow: TextShadow | undefined
  glow: TextGlow | undefined
}

// One laid-out character: a glyph, or a space/spacer that only advances the pen (rr = -1).
interface Entry {
  rr: number
  cp: number
  glyph: Glyph | undefined
  isSpace: boolean
  advance: number
}

interface ResolveResult {
  resolved: RunResolved[]
  materials: TextMaterial[]
}

function solidMaterial(dilate: number, distanceRange: number): TextMaterial {
  // Color rides the per-vertex channel; the material stays a solid (fillType 'color').
  return {
    fillPriority: 'color',
    gradientStart: ORIGIN,
    gradientStartRadius: 0,
    gradientEnd: ORIGIN,
    gradientEndRadius: 0,
    stops: [],
    strokeColor: BLACK,
    strokeWidth: 0,
    dilate,
    distanceRange,
  }
}

/** `color` with its own alpha multiplied by an optional opacity (default 1). */
function withOpacity(color: RGBA, opacity: number | undefined): RGBA {
  return [color[0], color[1], color[2], color[3] * (opacity ?? 1)]
}

function resolveRuns(runs: readonly TextRun[], fonts: FontProvider): ResolveResult {
  const resolved: RunResolved[] = []
  const materials: TextMaterial[] = []

  for (const run of runs) {
    const style = run.style ?? {}
    const fontSize = style.fontSize ?? 32
    const r = fonts.resolve(style.fontStyle ?? 'regular')
    const metrics = r.metrics
    const scale = fontSize / metrics.size
    const fauxBold = r.fauxBold || (style.fauxBold ?? false)
    const fauxItalic = r.fauxItalic || (style.fauxItalic ?? false)
    const boldDilate = fauxBold ? fontSize * FAUX_BOLD_DILATE : 0

    const g = style.gradient
    let fillPriority: FillPriority = 'color'
    if (g) fillPriority = g.type === 'radial' ? 'radial-gradient' : 'linear-gradient'
    const mainMaterial = materials.length
    materials.push({
      fillPriority,
      gradientStart: g ? g.start : ORIGIN,
      gradientStartRadius: g?.startRadius ?? 0,
      gradientEnd: g ? g.end : ORIGIN,
      gradientEndRadius: g?.endRadius ?? 0,
      stops: g ? g.stops : [],
      strokeColor: style.strokeColor ?? BLACK,
      strokeWidth: style.strokeColor ? (style.strokeWidth ?? 0) : 0,
      dilate: boldDilate,
      distanceRange: metrics.distanceRange,
    })

    let glowMaterial = -1
    if (style.glow) {
      glowMaterial = materials.length
      materials.push(solidMaterial(style.glow.radius + boldDilate, metrics.distanceRange))
    }
    let shadowMaterial = -1
    if (style.shadow) {
      shadowMaterial = materials.length
      materials.push(solidMaterial(boldDilate, metrics.distanceRange))
    }

    resolved.push({
      metrics,
      atlasIndex: r.atlasIndex,
      scale,
      fontSize,
      letterSpacing: style.letterSpacing ?? 0,
      baselineShift: style.baselineShift ?? 0,
      color: style.color ?? g?.stops[0]?.color ?? BLACK,
      underline: style.underline ?? false,
      strikethrough: style.strikethrough ?? false,
      highlight: style.highlight,
      skew: fauxItalic ? FAUX_ITALIC_SKEW : 0,
      mainMaterial,
      shadowMaterial,
      glowMaterial,
      shadow: style.shadow,
      glow: style.glow,
    })
  }

  return { resolved, materials }
}

// Flatten runs into an entry stream; null marks a hard '\n' break.
function buildStream(runs: readonly TextRun[], resolved: RunResolved[]): (Entry | null)[] {
  const stream: (Entry | null)[] = []
  runs.forEach((run, runIndex) => {
    const rr = resolved[runIndex]
    for (const ch of run.text) {
      const cp = ch.codePointAt(0) ?? 0
      if (cp === 13) continue
      if (cp === 10) {
        stream.push(null)
        continue
      }
      const glyph = glyphFor(rr.metrics, cp)
      const isSpace = cp === 32 || glyph === undefined
      const xadvance = glyph ? glyph.xadvance : (rr.metrics.glyphs.get(32)?.xadvance ?? rr.metrics.size * 0.3)
      stream.push({ rr: runIndex, cp, glyph: isSpace ? undefined : glyph, isSpace, advance: xadvance * rr.scale + rr.letterSpacing })
    }
  })
  return stream
}

export function layoutText(runs: readonly TextRun[], options: TextLayoutOptions, fonts: FontProvider): ShapedText {
  const { resolved, materials } = resolveRuns(runs, fonts)
  if (options.orientation === 'vertical') {
    return layoutVertical(runs, options, resolved, materials, fonts)
  }
  return layoutHorizontal(runs, options, resolved, materials)
}

// Kerning between two consecutive entries of the same run (0 across runs / spacers).
function kernBetween(prev: Entry, cur: Entry, resolved: RunResolved[]): number {
  if (prev.rr < 0 || cur.rr < 0 || prev.rr !== cur.rr) return 0
  const rr = resolved[cur.rr]
  return kerningFor(rr.metrics, prev.cp, cur.cp) * rr.scale
}

function lineExtent(entries: Entry[], resolved: RunResolved[]): number {
  let pen = 0
  for (let i = 0; i < entries.length; i++) {
    if (i > 0) pen += kernBetween(entries[i - 1], entries[i], resolved)
    pen += entries[i].advance
  }
  return pen
}

// A zero-glyph entry that only advances the pen (inter-word spaces on a line).
function spacer(advance: number): Entry {
  return { rr: -1, cp: 32, glyph: undefined, isSpace: true, advance }
}

interface Line {
  entries: Entry[]
  ended: 'wrap' | 'break' | 'end'
}

function layoutHorizontal(
  runs: readonly TextRun[],
  options: TextLayoutOptions,
  resolved: RunResolved[],
  materials: TextMaterial[],
): ShapedText {
  const stream = buildStream(runs, resolved)

  // Group into words (non-space runs) separated by spaces / hard breaks.
  type Token = { kind: 'word'; entries: Entry[]; width: number } | { kind: 'space'; advance: number } | { kind: 'break' }
  const tokens: Token[] = []
  let word: Entry[] = []
  const flushWord = () => {
    if (word.length === 0) return
    tokens.push({ kind: 'word', entries: word, width: lineExtent(word, resolved) })
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

  // Greedy line assembly; a line records why it ended (wrap vs break vs end) for justification.
  const maxWidth = options.maxWidth
  const lines: Line[] = []
  let line: Entry[] = []
  let lineWidth = 0
  let pendingSpace = 0
  const flush = (ended: Line['ended']) => {
    lines.push({ entries: line, ended })
    line = []
    lineWidth = 0
    pendingSpace = 0
  }
  for (const token of tokens) {
    if (token.kind === 'break') {
      flush('break')
    } else if (token.kind === 'space') {
      pendingSpace = token.advance
    } else {
      const gap = line.length > 0 ? pendingSpace : 0
      if (maxWidth !== undefined && line.length > 0 && lineWidth + gap + token.width > maxWidth) {
        flush('wrap')
        line.push(...token.entries)
        lineWidth = token.width
      } else {
        if (gap > 0) {
          line.push(spacer(gap))
          lineWidth += gap
        }
        line.push(...token.entries)
        lineWidth += token.width
      }
      pendingSpace = 0
    }
  }
  flush('end')

  const rtl = options.direction === 'rtl'
  const align = options.align ?? (rtl ? 'right' : 'left')
  const lineHeightMult = options.lineHeight ?? 1
  const fallback = resolved[0]
    ? { ascent: resolved[0].metrics.base * resolved[0].scale, descent: (resolved[0].metrics.lineHeight - resolved[0].metrics.base) * resolved[0].scale }
    : { ascent: 0, descent: 0 }

  if (rtl) for (const l of lines) l.entries.reverse()

  const highlights: TextQuad[] = []
  const shadows: TextQuad[] = []
  const glows: TextQuad[] = []
  const glyphs: TextQuad[] = []
  const decorations: TextQuad[] = []

  const widths = lines.map((l) => lineExtent(l.entries, resolved))
  const blockWidth = maxWidth ?? Math.max(0, ...widths)

  let topY = 0
  lines.forEach((l, li) => {
    let ascent = fallback.ascent
    let descent = fallback.descent
    for (const e of l.entries) {
      if (e.rr < 0) continue
      const rr = resolved[e.rr]
      ascent = Math.max(ascent, rr.metrics.base * rr.scale)
      descent = Math.max(descent, (rr.metrics.lineHeight - rr.metrics.base) * rr.scale)
    }
    // The baseline is fixed by the (unshifted) ascent; a run's baselineShift then moves its
    // glyphs relative to it (a small super/subscript rides within the line's leading).
    const baselineY = topY - ascent

    // Justify wrapped (non-final) lines by widening the inter-word spacers.
    const spacerCount = l.entries.reduce((n, e) => n + (e.rr < 0 ? 1 : 0), 0)
    const justify = align === 'justify' && l.ended === 'wrap' && maxWidth !== undefined && spacerCount > 0
    const extraPerSpacer = justify ? (blockWidth - widths[li]) / spacerCount : 0
    const alignOffset =
      align === 'right' ? blockWidth - widths[li] : align === 'center' ? (blockWidth - widths[li]) / 2 : 0

    let pen = alignOffset
    let spanRun = -1
    let spanStart = 0
    let spanEnd = 0
    let spanEntry: Entry | null = null
    const flushSpan = () => {
      if (spanEntry && spanEnd > spanStart) emitRunDecorations(resolved[spanEntry.rr], spanStart, spanEnd, baselineY, highlights, decorations)
      spanEntry = null
      spanRun = -1
    }

    for (let i = 0; i < l.entries.length; i++) {
      const e = l.entries[i]
      if (i > 0) pen += kernBetween(l.entries[i - 1], e, resolved)
      if (e.rr >= 0) {
        if (e.rr !== spanRun) {
          flushSpan()
          spanRun = e.rr
          spanStart = pen
          spanEntry = e
        }
        spanEnd = pen + e.advance
        if (e.glyph) emitGlyphStack(resolved[e.rr], e.glyph, pen, baselineY, 0, glyphs, shadows, glows)
        pen += e.advance
      } else {
        pen += e.advance + extraPerSpacer
      }
    }
    flushSpan()

    topY -= (ascent + descent) * lineHeightMult
  })

  return {
    quads: [...highlights, ...shadows, ...glows, ...glyphs, ...decorations],
    materials,
    width: blockWidth,
    height: -topY,
    lineCount: lines.length,
  }
}

// Emit a glyph's body, plus its drop-shadow and glow copies (behind it) when the run has them.
function emitGlyphStack(
  rr: RunResolved,
  glyph: Glyph,
  penX: number,
  baselineY: number,
  penYOffset: number,
  glyphs: TextQuad[],
  shadows: TextQuad[],
  glows: TextQuad[],
): void {
  if (rr.glowMaterial >= 0 && rr.glow) {
    glows.push(makeGlyphQuad(rr, glyph, penX, baselineY, penYOffset, rr.glowMaterial, withOpacity(rr.glow.color, rr.glow.opacity), 0, 0))
  }
  if (rr.shadowMaterial >= 0 && rr.shadow) {
    // offsetY is downward-positive; the scene is y-up, so the rotated vector's y is negated.
    shadows.push(
      makeGlyphQuad(rr, glyph, penX, baselineY, penYOffset, rr.shadowMaterial, withOpacity(rr.shadow.color, rr.shadow.opacity), rr.shadow.offsetX, -rr.shadow.offsetY),
    )
  }
  glyphs.push(makeGlyphQuad(rr, glyph, penX, baselineY, penYOffset, rr.mainMaterial, rr.color, 0, 0))
}

function makeGlyphQuad(
  rr: RunResolved,
  g: Glyph,
  penX: number,
  baselineY: number,
  penYOffset: number,
  material: number,
  color: RGBA,
  offX: number,
  offY: number,
): TextQuad {
  const scale = rr.scale
  const leftX = penX + g.xoffset * scale + offX
  const topGY = baselineY + rr.baselineShift + penYOffset + (rr.metrics.base - g.yoffset) * scale + offY
  return {
    material,
    atlasIndex: rr.atlasIndex,
    isGlyph: true,
    x0: leftX,
    y0: topGY - g.height * scale,
    x1: leftX + g.width * scale,
    y1: topGY,
    u0: g.u0,
    v0: g.v0,
    u1: g.u1,
    v1: g.v1,
    color,
    skew: rr.skew,
    skewPivotY: baselineY,
  }
}

// Highlight background (behind) + underline/strikethrough lines (in front) for one run's span.
function emitRunDecorations(
  rr: RunResolved,
  startX: number,
  endX: number,
  baselineY: number,
  highlights: TextQuad[],
  decorations: TextQuad[],
): void {
  const solid = (x0: number, y0: number, x1: number, y1: number, color: RGBA, out: TextQuad[]) => {
    out.push({ material: rr.mainMaterial, atlasIndex: rr.atlasIndex, isGlyph: false, x0, y0, x1, y1, u0: 0, v0: 0, u1: 0, v1: 0, color, skew: 0, skewPivotY: 0 })
  }
  const shift = rr.baselineShift
  if (rr.highlight) {
    const ascent = rr.metrics.base * rr.scale
    const descent = (rr.metrics.lineHeight - rr.metrics.base) * rr.scale
    solid(startX, baselineY - descent, endX, baselineY + ascent, rr.highlight, highlights)
  }
  const dec = rr.metrics.decoration
  if (rr.underline) {
    const cy = baselineY + shift + dec.underlineOffset * rr.fontSize
    const th = dec.underlineThickness * rr.fontSize
    solid(startX, cy - th / 2, endX, cy + th / 2, rr.color, decorations)
  }
  if (rr.strikethrough) {
    const cy = baselineY + shift + dec.strikeOffset * rr.fontSize
    const th = dec.strikeThickness * rr.fontSize
    solid(startX, cy - th / 2, endX, cy + th / 2, rr.color, decorations)
  }
}

// Vertical text: glyphs stack top-to-bottom, columns advance right-to-left, breaking on '\n'.
// A pragmatic subset - no wrap/justify/decorations/baseline-shift; faux bold, shadow, and glow
// still apply. Glyphs are centered on their column axis.
function layoutVertical(
  runs: readonly TextRun[],
  options: TextLayoutOptions,
  resolved: RunResolved[],
  materials: TextMaterial[],
  _fonts: FontProvider,
): ShapedText {
  const lineHeightMult = options.lineHeight ?? 1
  const stream = buildStream(runs, resolved)

  const columns: Entry[][] = []
  let column: Entry[] = []
  for (const e of stream) {
    if (e === null) {
      columns.push(column)
      column = []
    } else {
      column.push(e)
    }
  }
  columns.push(column)

  const shadows: TextQuad[] = []
  const glows: TextQuad[] = []
  const glyphs: TextQuad[] = []

  let columnX = 0
  let maxDepth = 0
  for (const col of columns) {
    let columnWidth = 0
    for (const e of col) if (e.rr >= 0) columnWidth = Math.max(columnWidth, resolved[e.rr].fontSize)
    if (columnWidth === 0) columnWidth = 32

    let penY = 0
    for (const e of col) {
      if (e.rr >= 0 && e.glyph) {
        const rr = resolved[e.rr]
        const scale = rr.scale
        const ascent = rr.metrics.base * scale
        const step = rr.metrics.lineHeight * scale * lineHeightMult
        // Center the glyph box on the column axis; place its cell baseline below the pen top.
        const centerX = columnX - columnWidth / 2
        const leftX = centerX - (e.glyph.width * scale) / 2 - e.glyph.xoffset * scale
        const baselineY = penY - ascent
        emitCenteredGlyph(rr, e.glyph, leftX, baselineY, glyphs, shadows, glows)
        penY -= step
      } else if (e.rr >= 0) {
        penY -= resolved[e.rr].metrics.lineHeight * resolved[e.rr].scale * lineHeightMult
      }
    }
    maxDepth = Math.max(maxDepth, -penY)
    columnX -= columnWidth * lineHeightMult
  }

  return {
    quads: [...shadows, ...glows, ...glyphs],
    materials,
    width: -columnX,
    height: maxDepth,
    lineCount: columns.length,
  }
}

function emitCenteredGlyph(rr: RunResolved, glyph: Glyph, leftX: number, baselineY: number, glyphs: TextQuad[], shadows: TextQuad[], glows: TextQuad[]): void {
  const penX = leftX - glyph.xoffset * rr.scale // makeGlyphQuad re-adds xoffset
  if (rr.glowMaterial >= 0 && rr.glow) {
    glows.push(makeGlyphQuad(rr, glyph, penX, baselineY, 0, rr.glowMaterial, withOpacity(rr.glow.color, rr.glow.opacity), 0, 0))
  }
  if (rr.shadowMaterial >= 0 && rr.shadow) {
    shadows.push(
      makeGlyphQuad(rr, glyph, penX, baselineY, 0, rr.shadowMaterial, withOpacity(rr.shadow.color, rr.shadow.opacity), rr.shadow.offsetX, -rr.shadow.offsetY),
    )
  }
  glyphs.push(makeGlyphQuad(rr, glyph, penX, baselineY, 0, rr.mainMaterial, rr.color, 0, 0))
}
