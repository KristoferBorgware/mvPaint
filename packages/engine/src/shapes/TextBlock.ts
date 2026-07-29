// TextBlock - everything the engine's two text implementations have in common: a list of
// styled runs, the block-level layout options the shaper takes, and the cache-invalidation
// protocol around them. Text (MSDF, drawn through the text lane) and VectorText (real glyph
// outlines, drawn through the mesh lane) both extend this, which is what makes them
// interchangeable at the call site - swapping one for the other is a change of constructor
// and nothing else.
//
// The base deliberately does NOT own the shaped result: what "shaped" means differs (one
// needs a FontBook of atlases, the other a book of parsed outlines), so each subclass keeps
// its own cache and says how to drop it via invalidateShaping(). Everything that can
// invalidate shaping - replacing the runs, replacing the text, or editing a layout option
// in place and calling markDirty() - funnels through that one hook.

import { Shape, type ShapeOptions } from './Shape'
import type { TextAlign, TextDirection, TextLayoutOptions, TextOrientation, TextRun, TextRunStyle } from '../text/layout'
import type { TextPathOptions } from '../text/textPath'

/** Constructor options shared by every text kind: styled content plus block layout. */
export interface TextBlockOptions extends ShapeOptions, TextLayoutOptions {
  /** Styled segments. Provide this, or `text` (+ optional `style`) for a single run. */
  runs?: TextRun[]
  text?: string
  style?: TextRunStyle
}

export abstract class TextBlock extends Shape {
  align: TextAlign
  maxWidth: number | undefined
  lineHeight: number
  direction: TextDirection
  orientation: TextOrientation
  /** A curve for the text to follow; undefined lays it out on a straight baseline. */
  textPath: TextPathOptions | undefined

  protected runsData: TextRun[]

  constructor(options: TextBlockOptions = {}) {
    super(options)
    this.align = options.align ?? 'left'
    this.maxWidth = options.maxWidth
    this.lineHeight = options.lineHeight ?? 1
    this.direction = options.direction ?? 'ltr'
    this.orientation = options.orientation ?? 'horizontal'
    this.textPath = options.textPath
    this.runsData = options.runs ?? (options.text !== undefined ? [{ text: options.text, style: options.style }] : [])
  }

  protected override attrKeys(): readonly string[] {
    return [...super.attrKeys(), 'runs', 'align', 'maxWidth', 'lineHeight', 'direction', 'orientation', 'textPath']
  }

  get runs(): readonly TextRun[] {
    return this.runsData
  }

  /** Replace all runs (invalidates the cached shaping). */
  setRuns(runs: TextRun[]): void {
    this.runsData = runs
    this.invalidateShaping()
  }

  /** Replace the content with a single styled run (invalidates the cached shaping). */
  setText(text: string, style?: TextRunStyle): void {
    this.runsData = [{ text, style }]
    this.invalidateShaping()
  }

  /** Force a re-shape on the next access (after mutating layout options in place). */
  markDirty(): void {
    this.invalidateShaping()
  }

  /** The block options as the shaper takes them. */
  protected layoutOptions(): TextLayoutOptions {
    return {
      align: this.align,
      maxWidth: this.maxWidth,
      lineHeight: this.lineHeight,
      direction: this.direction,
      orientation: this.orientation,
      textPath: this.textPath,
    }
  }

  /**
   * Drop whatever the subclass cached from the last shaping. Called for every content or
   * layout change; a subclass whose geometry is derived from the shaping (VectorText) also
   * invalidates that here.
   */
  protected abstract invalidateShaping(): void
}
