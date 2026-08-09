// MSDFText shaping: turn styled runs into positioned quads for the text lane. It resolves each run
// to a font atlas (synthesizing a missing weight/slant as faux bold/italic), lays glyphs out
// with kerning, letter-spacing, and baseline shift, greedily wraps to an optional max width,
// breaks on '\n', aligns each line (left/center/right/justify), and emits quads back-to-front:
// highlight backgrounds, drop shadows, soft glows, glyph bodies, then underline/strikethrough.
// Horizontal text supports left-to-right and (mechanically mirrored) right-to-left; a vertical
// orientation stacks glyphs top-to-bottom in right-to-left columns. Every run becomes one or
// more materials (fill/gradient + per-letter stroke + coverage dilation) referenced by its
// quads. Coordinates are the node's local space: +x right, +y DOWN, the block's top-left at the
// origin (horizontal lines descend to positive y; vertical columns extend to negative x).

import type { Vector2Like } from '../math/Vector2'
import { parseColor, parseStops } from '../render/color'
import type {ColorInput, ColorStopsInput, FillPriority, GradientStop, RGBA} from '../render/meshFormat'
import { NO_ROTATION, type TextQuad } from './textQuad'
import { bendOntoPath, type TextPathOptions } from './textPath'
// From the metrics module, not from webgpu/MSDFFontBook which re-exports it: the shaper is pure
// and must stay importable without dragging a render path in behind it.
import type { FontStyle } from './msdfProvider'
import { glyphFor, kerningFor, type FontMetrics, type Glyph } from './msdfMetrics'

export interface TextGradient {
  type: 'linear' | 'radial'
  start: Vector2Like
  end: Vector2Like
  /** Radial only; ignored for linear. */
  startRadius?: number
  endRadius?: number
  /** Each stop's `color` accepts a string as well as the tuple. */
  stops: ColorStopsInput
}

/**
 * MSDFText's drop shadow: a duplicate of the run's glyphs, drawn behind them at an offset in
 * the shadow's colour. Deliberately NOT the canvas blur model the mesh lane's Shape.shadow*
 * properties implement - a glyph has no rasterized silhouette to blur here, so text takes
 * the cheap, crisp duplicate instead. `offsetY` is downward-positive, matching Shape's.
 */
export interface TextShadow {
  /** Accepts a string as well as the tuple. */
  color: ColorInput
  offsetX: number
  offsetY: number
  /** Multiplies `color`'s own alpha. Default 1. */
  opacity?: number
}

/** Soft glow: a dilated copy of the glyphs behind them; `radius` is the spread in world px. */
export interface TextGlow {
  /** Accepts a string as well as the tuple. */
  color: ColorInput
  radius: number
  /** Multiplies `color`'s own alpha. Default 1. */
  opacity?: number
}

export interface TextRunStyle {
  fontStyle?: FontStyle // default 'regular'
  fontSize?: number // px, default 32
  /** Solid fill colour; ignored when `gradient` is set. Accepts a string as well as the tuple. */
  color?: ColorInput
  gradient?: TextGradient
  strokeColor?: ColorInput
  /** Per-letter outline width in world px; 0 = no outline. */
  strokeWidth?: number
  underline?: boolean
  strikethrough?: boolean
  /** Background highlight colour drawn behind the run. Accepts a string as well as the tuple. */
  highlight?: ColorInput
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
  /**
   * Blank space inside the block on all four sides, in world px. Default 0.
   *
   * It moves the text, and it grows the block: the first baseline sits `padding` lower, every
   * line starts `padding` further along, and the reported width and height each gain twice it.
   * So the block still starts at the node's origin, with the text inset within it - which is
   * what makes padding visible to everything measured from the block (bounds, hit-testing, a
   * highlight drawn behind it) rather than only to the glyphs.
   *
   * Wrapping is unaffected: `maxWidth` is the width the TEXT wraps at, so a padded block that
   * wraps is `maxWidth + 2 x padding` across.
   */
  padding?: number
  /**
   * Bend the finished block onto a curve (see text/textPath.ts). Everything else still
   * applies first - runs, kerning, wrapping, alignment, decorations - and the result is then
   * mapped onto the curve glyph by glyph.
   */
  textPath?: TextPathOptions
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

/** The family name a text node gets when it asks for none. Not a fallback - see MSDFFontFamilies. */
export const DEFAULT_FONT_FAMILY = 'default'

/**
 * The font families a scene can draw with - what an `MSDFText` node's `fontFamily` is resolved
 * through, and the reason two MSDFText nodes can be different typefaces.
 *
 * Device-free like FontProvider itself, and for the same reason: shaping reads metrics and an
 * atlas index, so text can be measured, wrapped, culled and hit-tested with no renderer at all.
 * The GPU-owning implementation (webgpu/MSDFFontLibrary.ts) adds the textures.
 *
 * A family is named rather than handed over as an object so that a text node stays plain data -
 * serializable, settable through setAttr, and constructible before any atlas has finished
 * loading. A node built while its atlas is in flight draws nothing until it lands, then re-shapes
 * on the font epoch.
 *
 * THERE IS NO FALLBACK FACE. The engine ships no typeface, so a name nothing was loaded under
 * resolves to an empty provider - no glyphs, nothing drawn - and says so once in the console.
 * Falling back would mean drawing in whatever the application happened to load first, under a
 * name that asked for something else.
 */
export interface MSDFFontFamilies {
  /**
   * The provider for a family. An absent name is the default family - the one a node gets when
   * it does not choose - and an unregistered name is an empty provider.
   */
  resolveFamily(family: string | undefined): FontProvider
}

/** Per-run material: transform-independent fill/gradient + per-letter stroke + coverage dilation. */
export interface TextMaterial {
  fillPriority: FillPriority
  gradientStart: Vector2Like
  gradientStartRadius: number
  gradientEnd: Vector2Like
  gradientEndRadius: number
  stops: GradientStop[]
  strokeColor: RGBA
  strokeWidth: number
  /** Extra coverage in world px (faux bold, glow spread) - a hard distance offset. */
  dilate: number
  distanceRange: number
  /**
   * Which layer of the shared atlas array this run's glyphs sample - the resolved style, after
   * any fallback. A run has exactly one font, so this belongs to the material alongside the
   * distanceRange it is read from, and the whole lane draws in one call regardless of how many
   * styles a paragraph mixes (see webgpu/MSDFFontBook.ts).
   */
  atlasIndex: number
}

export interface ShapedText {
  quads: TextQuad[]
  materials: TextMaterial[]
  width: number
  height: number
  lineCount: number
  /**
   * The y of the block's first baseline. Bending onto a curve lays this line on the curve
   * and keeps every other line's distance from it, so the leading survives the mapping.
   */
  referenceBaseline: number
}

const BLACK: RGBA = [0, 0, 0, 1]
const ORIGIN: Vector2Like = { x: 0, y: 0 }
const FAUX_BOLD_DILATE = 0.03 // fraction of font size, in world px
// Tangent of the shear angle, negative because of which way the lean is measured: the shear
// slides x by skew per unit of y about the baseline, an ascender sits at SMALLER y than the
// baseline, and an italic leans its ascenders to the RIGHT.
const FAUX_ITALIC_SKEW = -0.24

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
  // The style's own shadow/glow with their colours already parsed. Resolved here rather than
  // at quad time: the colour is read once per GLYPH down there, and a string would be parsed
  // that many times over.
  shadow: (Omit<TextShadow, 'color'> & { color: RGBA }) | undefined
  glow: (Omit<TextGlow, 'color'> & { color: RGBA }) | undefined
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

function solidMaterial(dilate: number, distanceRange: number, atlasIndex: number): TextMaterial {
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
    atlasIndex,
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
    // Parsed once and read twice - as the material's stop list, and as the fallback colour a
    // run with a gradient but no `color` of its own draws in.
    const stops = g ? parseStops(g.stops) : []
    const mainMaterial = materials.length
    materials.push({
      fillPriority,
      gradientStart: g ? g.start : ORIGIN,
      gradientStartRadius: g?.startRadius ?? 0,
      gradientEnd: g ? g.end : ORIGIN,
      gradientEndRadius: g?.endRadius ?? 0,
      stops,
      strokeColor: style.strokeColor ? parseColor(style.strokeColor) : BLACK,
      strokeWidth: style.strokeColor ? (style.strokeWidth ?? 0) : 0,
      dilate: boldDilate,
      distanceRange: metrics.distanceRange,
      atlasIndex: r.atlasIndex,
    })

    let glowMaterial = -1
    if (style.glow) {
      glowMaterial = materials.length
      materials.push(solidMaterial(style.glow.radius + boldDilate, metrics.distanceRange, r.atlasIndex))
    }
    let shadowMaterial = -1
    if (style.shadow) {
      shadowMaterial = materials.length
      materials.push(solidMaterial(boldDilate, metrics.distanceRange, r.atlasIndex))
    }

    resolved.push({
      metrics,
      atlasIndex: r.atlasIndex,
      scale,
      fontSize,
      letterSpacing: style.letterSpacing ?? 0,
      baselineShift: style.baselineShift ?? 0,
      // Parsed here rather than where the style was written: this runs once per run when the
      // text is shaped, which is cached, so a string costs nothing per glyph or per frame.
      color: style.color ? parseColor(style.color) : (stops[0]?.color ?? BLACK),
      underline: style.underline ?? false,
      strikethrough: style.strikethrough ?? false,
      highlight: style.highlight ? parseColor(style.highlight) : undefined,
      skew: fauxItalic ? FAUX_ITALIC_SKEW : 0,
      mainMaterial,
      shadowMaterial,
      glowMaterial,
      shadow: style.shadow ? { ...style.shadow, color: parseColor(style.shadow.color) } : undefined,
      glow: style.glow ? { ...style.glow, color: parseColor(style.glow.color) } : undefined,
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
    // A curve is not applied here: a vertical column runs along its own axis and has no one
    // baseline to lay on a curve, so there is nothing coherent to map.
    return layoutVertical(runs, options, resolved, materials, fonts)
  }
  const shaped = layoutHorizontal(runs, options, resolved, materials)
  return options.textPath ? bendOntoPath(shaped, options.textPath, shaped.referenceBaseline) : shaped
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
  // The width the TEXT occupies, which is what alignment measures against. Padding is added to
  // the reported block width at the end and deliberately not here: aligning against a padded
  // width would centre the text on the padding rather than within it.
  const blockWidth = maxWidth ?? Math.max(0, ...widths)
  const padding = options.padding ?? 0

  let topY = padding
  let referenceBaseline = 0
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
    const baselineY = topY + ascent
    if (li === 0) referenceBaseline = baselineY

    // Justify wrapped (non-final) lines by widening the inter-word spacers.
    const spacerCount = l.entries.reduce((n, e) => n + (e.rr < 0 ? 1 : 0), 0)
    const justify = align === 'justify' && l.ended === 'wrap' && maxWidth !== undefined && spacerCount > 0
    const extraPerSpacer = justify ? (blockWidth - widths[li]) / spacerCount : 0
    const alignOffset =
      align === 'right' ? blockWidth - widths[li] : align === 'center' ? (blockWidth - widths[li]) / 2 : 0

    let pen = padding + alignOffset
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
        if (e.glyph) emitGlyphStack(resolved[e.rr], e.glyph, e.cp, pen, baselineY, 0, glyphs, shadows, glows)
        pen += e.advance
      } else {
        pen += e.advance + extraPerSpacer
      }
    }
    flushSpan()

    topY += (ascent + descent) * lineHeightMult
  })

  return {
    quads: [...highlights, ...shadows, ...glows, ...glyphs, ...decorations],
    materials,
    width: blockWidth + padding * 2,
    // topY already carries the leading padding, having started there; this adds the trailing one.
    height: topY + padding,
    lineCount: lines.length,
    referenceBaseline,
  }
}

// Emit a glyph's body, plus its drop-shadow and glow copies (behind it) when the run has them.
function emitGlyphStack(
  rr: RunResolved,
  glyph: Glyph,
  codePoint: number,
  penX: number,
  baselineY: number,
  penYOffset: number,
  glyphs: TextQuad[],
  shadows: TextQuad[],
  glows: TextQuad[],
): void {
  if (rr.glowMaterial >= 0 && rr.glow) {
    glows.push(makeGlyphQuad(rr, glyph, codePoint, penX, baselineY, penYOffset, rr.glowMaterial, withOpacity(rr.glow.color, rr.glow.opacity), 0, 0))
  }
  if (rr.shadowMaterial >= 0 && rr.shadow) {
    // offsetY is downward-positive, which is where +y points, so it carries through as it is.
    shadows.push(
      makeGlyphQuad(rr, glyph, codePoint, penX, baselineY, penYOffset, rr.shadowMaterial, withOpacity(rr.shadow.color, rr.shadow.opacity), rr.shadow.offsetX, rr.shadow.offsetY),
    )
  }
  glyphs.push(makeGlyphQuad(rr, glyph, codePoint, penX, baselineY, penYOffset, rr.mainMaterial, rr.color, 0, 0))
}

function makeGlyphQuad(
  rr: RunResolved,
  g: Glyph,
  codePoint: number,
  penX: number,
  baselineY: number,
  penYOffset: number,
  material: number,
  color: RGBA,
  offX: number,
  offY: number,
): TextQuad {
  const scale = rr.scale
  // The pen origin: where the glyph's own coordinate system is planted on the baseline.
  // The bounding box below is that origin plus the glyph's extents; an outline consumer
  // wants the origin itself.
  const originX = penX + offX
  // baselineShift is +up by convention (a superscript is positive), and up is -y here.
  const originY = baselineY - rr.baselineShift + penYOffset + offY
  const leftX = originX + g.xoffset * scale
  // The glyph's top edge, which in a y-down space is its SMALLER y.
  const topGY = originY - (rr.metrics.base - g.yoffset) * scale
  return {
    material,
    atlasIndex: rr.atlasIndex,
    isGlyph: true,
    x0: leftX,
    y0: topGY,
    x1: leftX + g.width * scale,
    y1: topGY + g.height * scale,
    u0: g.u0,
    v0: g.v0,
    u1: g.u1,
    v1: g.v1,
    color,
    skew: rr.skew,
    skewPivotY: baselineY,
    codePoint,
    originX,
    originY,
    unitScale: scale,
    ...NO_ROTATION,
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
    // No outline behind a rule or a highlight - the quad IS the shape, so codePoint 0 tells
    // an outline consumer to draw the rectangle itself.
    // originY is the line's baseline, not the rule's own y: it is what a curve mapping
    // measures this quad's offset from, so an underline bends with the glyphs above it.
    out.push({ material: rr.mainMaterial, atlasIndex: rr.atlasIndex, isGlyph: false, x0, y0, x1, y1, u0: 0, v0: 0, u1: 0, v1: 0, color, skew: 0, skewPivotY: 0, codePoint: 0, originX: x0, originY: baselineY, unitScale: rr.scale, ...NO_ROTATION })
  }
  const shift = rr.baselineShift
  if (rr.highlight) {
    const ascent = rr.metrics.base * rr.scale
    const descent = (rr.metrics.lineHeight - rr.metrics.base) * rr.scale
    solid(startX, baselineY - ascent, endX, baselineY + descent, rr.highlight, highlights)
  }
  const dec = rr.metrics.decoration
  if (rr.underline) {
    const cy = baselineY - shift - dec.underlineOffset * rr.fontSize
    const th = dec.underlineThickness * rr.fontSize
    solid(startX, cy - th / 2, endX, cy + th / 2, rr.color, decorations)
  }
  if (rr.strikethrough) {
    const cy = baselineY - shift - dec.strikeOffset * rr.fontSize
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

  // Columns run to negative x from the origin, so the inset is negative on that axis and
  // positive on the other - the same "inside the block" in both cases.
  const padding = options.padding ?? 0
  let columnX = -padding
  let maxDepth = 0
  for (const col of columns) {
    let columnWidth = 0
    for (const e of col) if (e.rr >= 0) columnWidth = Math.max(columnWidth, resolved[e.rr].fontSize)
    if (columnWidth === 0) columnWidth = 32

    let penY = padding
    for (const e of col) {
      if (e.rr >= 0 && e.glyph) {
        const rr = resolved[e.rr]
        const scale = rr.scale
        const ascent = rr.metrics.base * scale
        const step = rr.metrics.lineHeight * scale * lineHeightMult
        // Center the glyph box on the column axis; place its cell baseline below the pen top.
        const centerX = columnX - columnWidth / 2
        const leftX = centerX - (e.glyph.width * scale) / 2 - e.glyph.xoffset * scale
        const baselineY = penY + ascent
        emitCenteredGlyph(rr, e.glyph, e.cp, leftX, baselineY, glyphs, shadows, glows)
        penY += step
      } else if (e.rr >= 0) {
        penY += resolved[e.rr].metrics.lineHeight * resolved[e.rr].scale * lineHeightMult
      }
    }
    maxDepth = Math.max(maxDepth, penY)
    columnX -= columnWidth * lineHeightMult
  }

  return {
    quads: [...shadows, ...glows, ...glyphs],
    materials,
    // Both already carry the leading padding, having started there; these add the trailing one.
    width: -columnX + padding,
    height: maxDepth + padding,
    lineCount: columns.length,
    referenceBaseline: 0,
  }
}

function emitCenteredGlyph(rr: RunResolved, glyph: Glyph, codePoint: number, leftX: number, baselineY: number, glyphs: TextQuad[], shadows: TextQuad[], glows: TextQuad[]): void {
  const penX = leftX - glyph.xoffset * rr.scale // makeGlyphQuad re-adds xoffset
  if (rr.glowMaterial >= 0 && rr.glow) {
    glows.push(makeGlyphQuad(rr, glyph, codePoint, penX, baselineY, 0, rr.glowMaterial, withOpacity(rr.glow.color, rr.glow.opacity), 0, 0))
  }
  if (rr.shadowMaterial >= 0 && rr.shadow) {
    shadows.push(
      makeGlyphQuad(rr, glyph, codePoint, penX, baselineY, 0, rr.shadowMaterial, withOpacity(rr.shadow.color, rr.shadow.opacity), rr.shadow.offsetX, rr.shadow.offsetY),
    )
  }
  glyphs.push(makeGlyphQuad(rr, glyph, codePoint, penX, baselineY, 0, rr.mainMaterial, rr.color, 0, 0))
}
