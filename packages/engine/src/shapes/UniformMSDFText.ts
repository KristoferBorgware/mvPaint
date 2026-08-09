// UniformMSDFText - an MSDFText whose whole string is one style, said in node attributes.
//
// The same glyphs through the same lane as MSDFText, and the same node in every other respect;
// what differs is where the styling lives. `fontSize`, `fontStyle`, `textDecoration`,
// `letterSpacing` and `padding` are attributes of the node, and `fill`, `stroke` and
// `strokeWidth` - which a plain MSDFText carries and never draws from - are the glyphs' paint.
// Underneath there is exactly one run, rebuilt whenever any of them is written (see
// shapes/singleRun.ts).
//
// REACH FOR MSDFText INSTEAD when one string has to carry more than one style - a bold word in a
// sentence, a coloured token in a log line, a gradient on part of a heading. That is what runs
// are for, and nothing here can express it.
//
// TWO THINGS DIFFER FROM THE ENGINE'S OWN DEFAULTS, both deliberately: the size is 12 rather than
// 32, and the fill starts opaque black rather than absent. Every other shape in this engine draws
// nothing until it is given a colour, and this one does not, because a text node that renders
// invisibly is a worse default than a text node that renders in black.
//
// WHAT IT DOES NOT HAVE, and what each would take: `fontVariant` (small-caps needs a second set
// of glyphs or a synthesis pass in the shaper), `underlineOffset` and `charRenderFunc` (both
// reach below the shaper into how a glyph is placed and drawn), `wrap: 'char'` (the line breaker
// splits on words and spaces only), and `ellipsis` and `verticalAlign` (both need the shaper to
// know a fixed block height and to truncate against it). Wrapping is `maxWidth`, inherited from
// Text, rather than a `wrap` attribute.

import { MSDFText, type MSDFTextOptions } from './MSDFText'
import { withSingleRun, type SingleRunTextOptions, type TextSize } from './singleRun'
import type { FontProvider } from '../text/layout'

/**
 * What a UniformMSDFText is constructed with: everything MSDFText takes except the two ways of
 * giving it several styles, plus the attributes that replace them.
 */
export interface UniformMSDFTextOptions extends Omit<MSDFTextOptions, 'runs' | 'style'>, SingleRunTextOptions {}

export class UniformMSDFText extends withSingleRun(MSDFText) {
  override readonly nodeName: string = 'UniformMSDFText'

  constructor(options: UniformMSDFTextOptions = {}) {
    super(options)
  }

  /**
   * The width of the shaped block, including any padding.
   *
   * `fonts` is what an MSDF node cannot supply for itself: its glyphs live in atlases the
   * renderer owns, and measuring reads their metrics. `handle.msdfFonts` is the one to pass.
   */
  getTextWidth(fonts: FontProvider): number {
    return this.shaped(fonts).width
  }

  /** The height of the shaped block - every line of it, plus any padding. */
  getTextHeight(fonts: FontProvider): number {
    return this.shaped(fonts).height
  }

  /**
   * Some other string in this node's style and layout, measured without disturbing it - for
   * fitting a field to its longest possible value, or a label to a name not yet set.
   */
  measureSize(text: string, fonts: FontProvider): TextSize {
    return this.measureWith(text, fonts)
  }
}
