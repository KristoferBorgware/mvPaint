// One style for the whole string, said in node attributes.
//
// The engine models text as RUNS - segments of one string, each styled independently - which is
// what lets a paragraph mix weights, colours and sizes in a single node. An application that has
// no way to select part of a string does not need that, and pays for it anyway: `fontSize` is
// not a property of the node but of every run inside it, and `Shape.fill` is not read by either
// text path at all, so `text.fill = 'red'` assigns a field nothing draws from.
//
// This is the other shape of the same node. Every attribute sits where a caller reaches for it,
// and exactly one run is kept underneath, rebuilt whenever one of them is written. Nothing is
// lost: these are ordinary Text nodes, so alignment, wrapping, curves, hit-testing and the
// transformer all behave as they do on any other.
//
// A MIXIN because there are two of them. MSDFText and VectorText are both concrete, and where a
// glyph comes from is the only thing separating them, so the attribute surface has to be written
// over each - which TypeScript, having no multiple inheritance, does this way and not by a shared
// base. See UniformMSDFText and UniformVectorText, which are what an application constructs.
//
// THE CONSTRUCTOR ORDER MATTERS HERE, and getting it wrong is silent. Shape's constructor assigns
// `this.fill`, and it runs BEFORE Text's constructor creates the run list and before this class's
// own fields are initialised - so the overridden setter below fires while everything it would
// read is still undefined. `ready` is what holds it off; it is undefined (falsy) through every
// base constructor, false once this class's fields initialise, and true from the end of its
// constructor onward.

import type { RGBA } from '../render/meshFormat'
import type { ColorInput } from '../render/color'
import { layoutText, type FontProvider, type TextRunStyle } from '../text/layout'
import type { FontStyle } from '../text/msdfProvider'
import { Text } from './Text'

/** Konva's default text size. Deliberately not the engine's 32 - see the class headers. */
export const UNIFORM_TEXT_FONT_SIZE = 12

/** Konva's Text paints black unless told otherwise, and so does this. */
export const UNIFORM_TEXT_FILL: RGBA = [0, 0, 0, 1]

/** A `fill` of null paints nothing, which for glyphs means transparent rather than absent. */
const NO_PAINT: RGBA = [0, 0, 0, 0]

/** A measured block: what `measureSize` reports. */
export interface TextSize {
  width: number
  height: number
}

/** The attributes a uniform text node adds on top of its base class's. */
export interface SingleRunTextOptions {
  /** The string. Default ''. */
  text?: string
  /** Size in world px. Default 12. */
  fontSize?: number
  /** 'normal', 'bold', 'italic', or the two together. Default 'normal'. See fontStyle. */
  fontStyle?: string
  /** 'underline', 'line-through', or both. Default '' - neither. See textDecoration. */
  textDecoration?: string
  /** Extra tracking between glyphs, world px. Default 0. */
  letterSpacing?: number
}

const WEIGHTS = new Set(['bold'])
const SLANTS = new Set(['italic', 'oblique'])
// The words that mean "no change" in either vocabulary - CSS's and this engine's own.
const PLAIN = new Set(['normal', 'regular', 'none', ''])

/**
 * A CSS-ish font style onto the four faces a font book holds.
 *
 * Splits on whitespace AND hyphens, so every way of writing it lands in the same place:
 * 'bold italic', 'italic bold' and the engine's own 'bold-italic' are one face. An unrecognised
 * word throws rather than being dropped - a typo that silently drew regular is the kind of thing
 * nobody finds.
 */
export function toFontStyle(value: string): FontStyle {
  const words = value.trim().toLowerCase().split(/[\s-]+/).filter((word) => !PLAIN.has(word))
  const unknown = words.filter((word) => !WEIGHTS.has(word) && !SLANTS.has(word))
  if (unknown.length > 0) {
    throw new Error(
      `fontStyle: '${value}' has nothing to draw with - expected 'normal', 'bold', 'italic' or the last two together, not '${unknown.join(' ')}'.`,
    )
  }
  const bold = words.some((word) => WEIGHTS.has(word))
  const italic = words.some((word) => SLANTS.has(word))
  if (bold && italic) return 'bold-italic'
  return bold ? 'bold' : italic ? 'italic' : 'regular'
}

/** Which rules a `textDecoration` asks for. Both spellings of the middle one are accepted. */
export function toDecorations(value: string): { underline: boolean; strikethrough: boolean } {
  const words = value.trim().toLowerCase().split(/\s+/).filter((word) => !PLAIN.has(word))
  const unknown = words.filter((word) => word !== 'underline' && word !== 'line-through' && word !== 'strikethrough')
  if (unknown.length > 0) {
    throw new Error(
      `textDecoration: '${value}' is not a rule this draws - expected 'underline', 'line-through', or both, not '${unknown.join(' ')}'.`,
    )
  }
  return {
    underline: words.includes('underline'),
    strikethrough: words.includes('line-through') || words.includes('strikethrough'),
  }
}

/** Any concrete Text - what this can be written over. */
type TextClass = abstract new (...args: any[]) => Text

/**
 * `Base` with Konva's Text attributes on the front of it, over exactly one run.
 *
 * Not exported from the package: what an application uses is UniformMSDFText or
 * UniformVectorText, which are this applied to each of the two glyph sources.
 */
export function withSingleRun<T extends TextClass>(Base: T) {
  abstract class SingleRun extends Base {
    private textValue = ''
    private fontSizeValue = UNIFORM_TEXT_FONT_SIZE
    private fontStyleValue = 'normal'
    private textDecorationValue = ''
    private letterSpacingValue = 0
    // See the file header. Undefined through the base constructors, which is what makes the
    // guard in syncRun() hold before this class's own fields exist.
    private ready = false

    constructor(...args: any[]) {
      super(...args)
      const options = (args[0] ?? {}) as SingleRunTextOptions & {
        runs?: unknown
        style?: unknown
        fill?: ColorInput | null
      }
      if (options.runs !== undefined || options.style !== undefined) {
        throw new Error(
          'A uniform text node carries one style for the whole string, so it takes `fontSize`/`fill`/`fontStyle` rather than `runs` or `style` - use MSDFText or VectorText for independently styled runs.',
        )
      }

      this.textValue = options.text ?? ''
      this.fontSizeValue = options.fontSize ?? UNIFORM_TEXT_FONT_SIZE
      this.fontStyleValue = options.fontStyle ?? 'normal'
      this.textDecorationValue = options.textDecoration ?? ''
      this.letterSpacingValue = options.letterSpacing ?? 0
      // Only when the caller said nothing about it. An explicit `fill: null` means what it says -
      // paint nothing - and is not the same as leaving it out.
      if (options.fill === undefined) this.fill = UNIFORM_TEXT_FILL

      this.ready = true
      this.syncRun()
    }

    // --- the attributes ---------------------------------------------------------------------

    /** The string this node draws. */
    get text(): string {
      return this.textValue
    }
    set text(value: string) {
      if (value === this.textValue) return
      this.textValue = value
      this.syncRun()
    }

    /** Size in world px. */
    get fontSize(): number {
      return this.fontSizeValue
    }
    set fontSize(value: number) {
      if (value === this.fontSizeValue) return
      this.fontSizeValue = value
      this.syncRun()
    }

    /**
     * Which face to draw with, as it is written in CSS: 'normal', 'bold', 'italic', or the last
     * two together in either order. Reads back exactly as it was assigned; what it resolved to
     * is `toFontStyle(node.fontStyle)`.
     */
    get fontStyle(): string {
      return this.fontStyleValue
    }
    set fontStyle(value: string) {
      if (value === this.fontStyleValue) return
      // Resolved before it is stored, so a typo throws at the assignment that made it rather
      // than at the next frame that tries to draw with it.
      toFontStyle(value)
      this.fontStyleValue = value
      this.syncRun()
    }

    /** 'underline', 'line-through', both, or '' for neither. */
    get textDecoration(): string {
      return this.textDecorationValue
    }
    set textDecoration(value: string) {
      if (value === this.textDecorationValue) return
      toDecorations(value)
      this.textDecorationValue = value
      this.syncRun()
    }

    /** Extra tracking between glyphs, world px. */
    get letterSpacing(): number {
      return this.letterSpacingValue
    }
    set letterSpacing(value: number) {
      if (value === this.letterSpacingValue) return
      this.letterSpacingValue = value
      this.syncRun()
    }

    // --- the inherited ones this node actually draws from -------------------------------------
    //
    // On any other Shape these are the paint the mesh lane reads. On a text node the glyphs take
    // their colour from the run, so each of these is overridden to reach it - which is what makes
    // `text.fill = 'red'` mean what it says.

    /** The glyphs' colour. Opaque black unless the constructor was told otherwise; null paints nothing. */
    override get fill(): RGBA | null {
      return super.fill
    }
    override set fill(value: ColorInput | null) {
      super.fill = value
      this.syncRun()
    }

    /** The per-letter outline's colour. null draws no outline, whatever strokeWidth says. */
    override get stroke(): RGBA | null {
      return super.stroke
    }
    override set stroke(value: ColorInput | null) {
      super.stroke = value
      this.syncRun()
    }

    /** How wide that outline is. */
    override get strokeWidth(): number {
      return super.strokeWidth
    }
    override set strokeWidth(value: number) {
      if (value === super.strokeWidth) return
      super.strokeWidth = value
      this.syncRun()
    }

    /** Blank space inside the block, world px. Grows the measured size by twice it. */
    override get padding(): number {
      return super.padding
    }
    override set padding(value: number) {
      if (value === super.padding) return
      super.padding = value
      this.syncRun()
    }

    // --- measuring --------------------------------------------------------------------------

    /** This node's whole style, as the shaper takes it - what measureSize applies to other text. */
    protected runStyle(): TextRunStyle {
      const { underline, strikethrough } = toDecorations(this.textDecorationValue)
      const outlined = this.stroke !== null && this.strokeWidth > 0
      return {
        fontSize: this.fontSizeValue,
        fontStyle: toFontStyle(this.fontStyleValue),
        color: this.fill ?? NO_PAINT,
        strokeColor: outlined ? (this.stroke as RGBA) : undefined,
        strokeWidth: outlined ? this.strokeWidth : 0,
        letterSpacing: this.letterSpacingValue,
        underline,
        strikethrough,
      }
    }

    /** Some other string in this node's style and layout, measured without disturbing it. */
    protected measureWith(text: string, fonts: FontProvider): TextSize {
      const shaped = layoutText([{ text, style: this.runStyle() }], this.layoutOptions(), fonts)
      return { width: shaped.width, height: shaped.height }
    }

    /**
     * Rebuilds the single run from the attributes and drops the cached shaping.
     *
     * Held off until the node is fully constructed - see the file header. Every base constructor
     * would otherwise reach it with half a node, and the epoch bump inside invalidateShaping()
     * is scene-wide, so one per text node built would re-shape every other text node in the
     * scene as it was being populated.
     */
    private syncRun(): void {
      if (!this.ready) return
      this.runsData = [{ text: this.textValue, style: this.runStyle() }]
      this.invalidateShaping()
    }
  }
  return SingleRun
}
