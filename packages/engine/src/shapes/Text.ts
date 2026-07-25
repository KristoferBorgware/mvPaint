// Text - a drawable Shape rendered through the MSDF text lane rather than the mesh lane
// (it has no tessellate() / fill geometry; TextBatcher shapes it directly from its
// runs). It inherits position/scale/rotation/offset/visible/pickable/zIndex from Shape,
// and adds its styled runs and block-layout options, caching the shaped result (glyph +
// decoration quads and per-run materials) until its content changes. Its transform is
// applied in the vertex shader like every other node, so moving or scaling a Text never
// re-shapes it; only editing the runs or layout does.

import { Shape, type ShapeOptions } from '../scene/Shape'
import type { FontBook } from '../text/FontAtlas'
import {
  layoutText,
  type ShapedText,
  type TextAlign,
  type TextDirection,
  type TextOrientation,
  type TextRun,
  type TextRunStyle,
} from '../text/layout'

export interface TextOptions extends ShapeOptions {
  /** Styled segments. Provide this, or `text` (+ optional `style`) for a single run. */
  runs?: TextRun[]
  text?: string
  style?: TextRunStyle
  align?: TextAlign
  /** Wrap width in world px; undefined = no wrapping. */
  maxWidth?: number
  /** Line-height multiplier over the font's line height; default 1. */
  lineHeight?: number
  /** Horizontal flow direction (ignored when vertical); default 'ltr'. */
  direction?: TextDirection
  /** 'horizontal' (default) or 'vertical' (top-to-bottom, right-to-left columns). */
  orientation?: TextOrientation
}

export class Text extends Shape {
  align: TextAlign
  maxWidth: number | undefined
  lineHeight: number
  direction: TextDirection
  orientation: TextOrientation

  private runsData: TextRun[]
  private shapedCache: ShapedText | null = null

  constructor(options: TextOptions = {}) {
    super(options)
    this.align = options.align ?? 'left'
    this.maxWidth = options.maxWidth
    this.lineHeight = options.lineHeight ?? 1
    this.direction = options.direction ?? 'ltr'
    this.orientation = options.orientation ?? 'horizontal'
    this.runsData = options.runs ?? (options.text !== undefined ? [{ text: options.text, style: options.style }] : [])
  }

  get runs(): readonly TextRun[] {
    return this.runsData
  }

  /** Replace all runs (invalidates the cached shaping). */
  setRuns(runs: TextRun[]): void {
    this.runsData = runs
    this.shapedCache = null
  }

  /** Replace the content with a single styled run (invalidates the cached shaping). */
  setText(text: string, style?: TextRunStyle): void {
    this.runsData = [{ text, style }]
    this.shapedCache = null
  }

  /** Force a re-shape on the next access (after mutating layout options in place). */
  markDirty(): void {
    this.shapedCache = null
  }

  /** Shape the runs into quads + materials, cached until the content or layout changes. */
  shaped(fontBook: FontBook): ShapedText {
    if (!this.shapedCache) {
      this.shapedCache = layoutText(
        this.runsData,
        {
          align: this.align,
          maxWidth: this.maxWidth,
          lineHeight: this.lineHeight,
          direction: this.direction,
          orientation: this.orientation,
        },
        fontBook,
      )
    }
    return this.shapedCache
  }
}
