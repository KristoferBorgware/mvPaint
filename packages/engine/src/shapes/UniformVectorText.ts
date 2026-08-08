// UniformVectorText - a VectorText whose whole string is one style, said in node attributes.
//
// The outline counterpart of UniformMSDFText, and the same trade: real glyph geometry through the
// mesh lane, so hit-testing is per glyph, a shadow is cast from the letterforms, and a stroke is
// the mesh lane's own - at the price of triangles rather than four vertices a glyph. See
// text/vectorGlyphs.ts for the full comparison; the choice between the two is a constructor.
//
// It names its family exactly as the MSDF class does - `fontFamily: 'inter'` - because a font
// reaches the engine by being registered under a name (see resources/FontRegistry.ts) whichever
// kind of text is going to draw it.
//
// Measuring needs nothing passed in, unlike the MSDF class: outlines are device-free, so this
// node resolves its own from the registry rather than being handed a provider.

import { VectorText, type VectorTextOptions } from './VectorText'
import { withSingleRun, toFontStyle, type SingleRunTextOptions, type TextSize } from './singleRun'

/**
 * What a UniformVectorText is constructed with: everything VectorText takes except the two ways
 * of giving it several styles, plus the attributes that replace them.
 */
export interface UniformVectorTextOptions extends Omit<VectorTextOptions, 'runs' | 'style'>, SingleRunTextOptions {}

export class UniformVectorText extends withSingleRun(VectorText) {
  override readonly nodeName: string = 'UniformVectorText'

  constructor(options: UniformVectorTextOptions = {}) {
    super(options)
  }

  /** The width of the shaped block, including any padding. */
  getTextWidth(): number {
    return this.shaped().width
  }

  /** The height of the shaped block - every line of it, plus any padding. */
  getTextHeight(): number {
    return this.shaped().height
  }

  /**
   * Some other string in this node's style and layout, measured without disturbing it. A node
   * whose family is not registered measures 0 x 0, which is what it draws.
   *
   * The characters are measured into the book first, because a VectorFonts that parses a font
   * file at runtime (see @mvpaint/ttf) only holds the glyphs it has been asked for - a book of
   * baked outlines has them all already and answers this as a no-op.
   */
  measureSize(text: string): TextSize {
    const fonts = this.fonts
    if (!fonts) return { width: 0, height: 0 }
    fonts.prepare(toFontStyle(this.fontStyle), text)
    return this.measureWith(text, fonts)
  }
}
