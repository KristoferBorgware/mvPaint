// Text - a drawable Shape rendered through the MSDF text lane rather than the mesh lane
// (it has no tessellate() / fill geometry; TextBatcher shapes it directly from its
// runs). It inherits position/scale/rotation/offset/visible/pickable/zIndex from Shape and
// its styled runs plus block-layout options from TextBlock, caching the shaped result
// (glyph + decoration quads and per-run materials) until its content changes. Its transform
// is applied in the vertex shader like every other node, so moving or scaling a Text never
// re-shapes it; only editing the runs or layout does.
//
// VectorText is the same content drawn the other way - real glyph outlines through the mesh
// lane. The two share this class's whole public surface via TextBlock, so which one a scene
// uses is a choice of constructor; see text/vectorGlyphs.ts for what actually differs.

import { TextBlock, type TextBlockOptions } from './TextBlock'
import { layoutText, type FontProvider, type ShapedText } from '../text/layout'
import { fontEpoch } from './contentEpoch'

export interface TextOptions extends TextBlockOptions {
  /**
   * Which font family to draw with - a name the renderer resolves through its loaded families
   * (see handle.setFonts). Omitted, or naming a family that is not loaded, draws with the
   * default family, so a node built while its atlas is still being fetched shows text now and
   * the right face once it arrives.
   *
   * A node-level choice, not a per-run one: a paragraph is one family, and mixing families
   * within a node is not supported. Two nodes can be different families freely - the text lane
   * splits its draw where the family changes, so that costs a draw call and nothing else.
   */
  fontFamily?: string
}

export class Text extends TextBlock {
  override readonly nodeName: string = 'Text'

  private familyName: string | undefined
  private shapedCache: ShapedText | null = null
  private shapedFontEpoch = -1

  constructor(options: TextOptions = {}) {
    super(options)
    this.familyName = options.fontFamily
  }

  protected override attrKeys(): readonly string[] {
    return [...super.attrKeys(), 'fontFamily']
  }

  /** The family this node draws with; undefined means the default. */
  get fontFamily(): string | undefined {
    return this.familyName
  }

  /**
   * Draw with a different family.
   *
   * Goes through invalidateShaping(), which drops THIS node's cached layout and marks the lane
   * stale - so only this node re-shapes, and every other node's quads are repacked from the
   * caches they already have. Deliberately not the font epoch, which is for a family's atlases
   * being replaced underneath every node at once and re-shapes all of them.
   */
  set fontFamily(family: string | undefined) {
    if (this.familyName === family) return
    this.familyName = family
    this.invalidateShaping()
  }

  /**
   * Shape the runs into quads + materials, cached until the content, the layout or the FONTS
   * change.
   *
   * The parameter is a FontProvider rather than the GPU-owning FontBook because shaping
   * reads metrics and an atlas INDEX and nothing else - no texture, no device. Keeping it
   * at that width is what lets text be measured, culled and hit-tested with no renderer at
   * all (see text/msdfProvider.ts, which is how the self-tests shape under node).
   *
   * The cache cannot be keyed on that argument - callers pass whatever provider is to hand,
   * and two of them may be different objects over the same metrics - so it is keyed on the
   * global font epoch instead. An application replacing its atlases at runtime bumps that, and
   * every Text re-shapes on next access rather than keeping a layout measured against metrics
   * that are gone.
   */
  shaped(fonts: FontProvider): ShapedText {
    if (!this.shapedCache || this.shapedFontEpoch !== fontEpoch()) {
      this.shapedCache = layoutText(this.runsData, this.layoutOptions(), fonts)
      this.shapedFontEpoch = fontEpoch()
    }
    return this.shapedCache
  }

  protected override dropShapingCache(): void {
    this.shapedCache = null
  }
}
