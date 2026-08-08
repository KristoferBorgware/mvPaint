// MSDFText - a drawable Shape rendered through the MSDF text lane rather than the mesh lane
// (it has no tessellate() / fill geometry; TextBatcher shapes it directly from its
// runs). It inherits position/scale/rotation/offset/visible/pickable/zIndex from Shape and
// its styled runs plus block-layout options from Text, caching the shaped result
// (glyph + decoration quads and per-run materials) until its content changes. Its transform
// is applied in the vertex shader like every other node, so moving or scaling an MSDFText never
// re-shapes it; only editing the runs or layout does.
//
// VectorText is the same content drawn the other way - real glyph outlines through the mesh
// lane. Both take their whole public surface from Text, the shared base, so which one a scene
// uses is a choice of constructor; see text/vectorGlyphs.ts for what actually differs. The
// names say which glyph source each one reads, since that is the only thing separating them.

import { Text, type TextOptions } from './Text'
import { layoutText, type FontProvider, type ShapedText } from '../text/layout'
import { fontEpoch } from './contentEpoch'

/** MSDFText adds nothing to Text's options; `fontFamily` names the atlases it samples. */
export type MSDFTextOptions = TextOptions

export class MSDFText extends Text {
  override readonly nodeName: string = 'MSDFText'

  private shapedCache: ShapedText | null = null
  private shapedFontEpoch = -1

  constructor(options: MSDFTextOptions = {}) {
    super(options)
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
   * every MSDFText re-shapes on next access rather than keeping a layout measured against metrics
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
