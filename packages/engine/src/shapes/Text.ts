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
// uses is a choice of constructor; see text/VectorFont.ts for what actually differs.

import { TextBlock, type TextBlockOptions } from './TextBlock'
import { layoutText, type FontProvider, type ShapedText } from '../text/layout'

export type TextOptions = TextBlockOptions

export class Text extends TextBlock {
  override readonly nodeName: string = 'Text'

  private shapedCache: ShapedText | null = null

  /**
   * Shape the runs into quads + materials, cached until the content or layout changes.
   *
   * The parameter is a FontProvider rather than the GPU-owning FontBook because shaping
   * reads metrics and an atlas INDEX and nothing else - no texture, no device. Keeping it
   * at that width is what lets text be measured, culled and hit-tested with no renderer at
   * all (see text/msdfProvider.ts, which is how the self-tests shape under node).
   */
  shaped(fonts: FontProvider): ShapedText {
    if (!this.shapedCache) {
      this.shapedCache = layoutText(this.runsData, this.layoutOptions(), fonts)
    }
    return this.shapedCache
  }

  protected override dropShapingCache(): void {
    this.shapedCache = null
  }
}
