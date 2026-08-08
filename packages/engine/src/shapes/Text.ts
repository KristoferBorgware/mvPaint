// Text - everything the engine's two text implementations have in common: a list of styled
// runs, the block-level layout options the shaper takes, and the cache-invalidation protocol
// around them. Abstract: a scene draws one of the two concrete classes, each named for where
// its glyphs come from. MSDFText samples a distance-field atlas through the text lane;
// VectorText tessellates real outlines through the mesh lane. Both extend this, which is what
// makes them interchangeable at the call site - swapping one for the other is a change of
// constructor and nothing else.
//
// The base deliberately does NOT own the shaped result: what "shaped" means differs (one
// needs a FontBook of atlases, the other a book of parsed outlines), so each subclass keeps
// its own cache and says how to drop it via invalidateShaping(). Everything that can
// invalidate shaping - replacing the runs, replacing the text, or editing a layout option
// in place and calling markDirty() - funnels through that one hook.

import { Shape, type ShapeOptions } from './Shape'
import { bumpTextShapingEpoch } from './contentEpoch'
import type { TextAlign, TextDirection, TextLayoutOptions, TextOrientation, TextRun, TextRunStyle } from '../text/layout'
import type { TextPathOptions } from '../text/textPath'

/** Constructor options shared by every text kind: styled content plus block layout. */
export interface TextOptions extends ShapeOptions, TextLayoutOptions {
  /** Styled segments. Provide this, or `text` (+ optional `style`) for a single run. */
  runs?: TextRun[]
  text?: string
  style?: TextRunStyle
  /** Which registered family to draw with - see Text.fontFamily. */
  fontFamily?: string
}

export abstract class Text extends Shape {
  align: TextAlign
  maxWidth: number | undefined
  lineHeight: number
  direction: TextDirection
  orientation: TextOrientation
  /**
   * Blank space inside the block, in world px - see TextLayoutOptions.padding.
   *
   * An accessor rather than a plain field for the same reason Shape.strokeWidth is one: a
   * subclass that keeps its run in step with its attributes has to hear the assignment. Like
   * every other layout option here, changing it needs markDirty() to re-shape.
   */
  private _padding = 0
  get padding(): number {
    return this._padding
  }
  set padding(value: number) {
    this._padding = value
  }

  private _fontFamily: string | undefined
  /**
   * Which registered family to draw with - one name, whichever kind of text this is.
   *
   * A font reaches the engine by being registered under a name (see resources/FontRegistry.ts),
   * so this is how a node says WHICH TYPEFACE. What it does not say is how the glyphs are drawn:
   * that is the class, chosen when the node is written - MSDFText samples a distance field,
   * VectorText tessellates real contours - and the two have different strengths rather than being
   * swappable. Two nodes of different kinds naming one family is the ordinary case.
   *
   * A name nothing is registered under draws NOTHING, and says so once in the console. The engine
   * ships no typeface, so there is no face to fall back to.
   *
   * A node-level choice, not a per-run one: a paragraph is one family, and mixing families within
   * a node is not supported. Two nodes can differ freely - the text lane splits its draw where
   * the family changes, which is a draw call and nothing else.
   */
  get fontFamily(): string | undefined {
    return this._fontFamily
  }
  set fontFamily(value: string | undefined) {
    if (value === this._fontFamily) return
    this._fontFamily = value
    // Only this node re-shapes. Deliberately not the font epoch, which is for a family's contents
    // being replaced underneath every node at once.
    this.invalidateShaping()
  }
  /** A curve for the text to follow; undefined lays it out on a straight baseline. */
  textPath: TextPathOptions | undefined

  protected runsData: TextRun[]

  constructor(options: TextOptions = {}) {
    super(options)
    this.align = options.align ?? 'left'
    this.maxWidth = options.maxWidth
    this.lineHeight = options.lineHeight ?? 1
    this.direction = options.direction ?? 'ltr'
    this.orientation = options.orientation ?? 'horizontal'
    this.padding = options.padding ?? 0
    // The backing field, not the setter: the setter invalidates, and invalidateShaping() bumps a
    // scene-wide epoch, so one per text node constructed would re-shape every other text node in
    // the scene as it was being populated.
    this._fontFamily = options.fontFamily
    this.textPath = options.textPath
    this.runsData = options.runs ?? (options.text !== undefined ? [{ text: options.text, style: options.style }] : [])
  }

  protected override attrKeys(): readonly string[] {
    return [
      ...super.attrKeys(),
      'runs',
      'align',
      'maxWidth',
      'lineHeight',
      'direction',
      'orientation',
      'padding',
      'fontFamily',
      'textPath',
    ]
  }

  get runs(): readonly TextRun[] {
    return this.runsData
  }

  /** Replace all runs (invalidates the cached shaping). */
  setRuns(runs: TextRun[]): void {
    this.runsData = runs
    this.invalidateShaping()
  }

  /**
   * Drops the cached shaping and announces it lane-wide.
   *
   * Both halves are needed. The subclass hook clears what THIS node cached; the epoch is
   * what the renderer can actually see, since it packs every text node into shared buffers
   * and has no way to ask each one whether it re-shaped. Without the second half a node
   * whose content changes in place - runs replaced, or a layout option edited and markDirty
   * called - keeps drawing its old glyphs until something unrelated forces a rebuild.
   */
  protected invalidateShaping(): void {
    bumpTextShapingEpoch()
    this.dropShapingCache()
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
      padding: this.padding,
      textPath: this.textPath,
    }
  }

  /**
   * Drop whatever the subclass cached from the last shaping. Called for every content or
   * layout change; a subclass whose geometry is derived from the shaping (VectorText) also
   * invalidates that here.
   */
  protected abstract dropShapingCache(): void
}
