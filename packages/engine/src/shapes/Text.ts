// Text - everything the engine's two text implementations have in common: a list of styled
// runs, the block-level layout options the shaper takes, and the cache-invalidation protocol
// around them. Abstract: a scene draws one of the two concrete classes, each named for where
// its glyphs come from. MSDFText samples a distance-field atlas through the text lane;
// VectorText tessellates real outlines through the mesh lane. Both extend this, which is what
// makes them interchangeable at the call site - swapping one for the other is a change of
// constructor and nothing else.
//
// The base deliberately does NOT own the shaped result: what "shaped" means differs (one
// needs an MSDFFontBook of atlases, the other a book of parsed outlines), so each subclass keeps
// its own cache and says how to drop it via invalidateShaping(). Everything that can
// invalidate shaping - replacing the runs, replacing the text, or editing a layout option
// in place and calling markDirty() - funnels through that one hook.

import { shapeAttrDefaults, Shape, type ShapeOptions } from './Shape'
import type { ColorInput, RGBA } from '../render/meshFormat'
import { bumpTextShapingEpoch } from './contentEpoch'
import type { TextAlign, TextDirection, TextLayoutOptions, TextOrientation, TextRun, TextRunStyle, TextWrap } from '../text/layout'
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


/** See Node.attrDefaults. An empty run list draws nothing, which is the honest blank state. */
let cachedTextAttrDefaults: Readonly<Record<string, unknown>> | undefined

/**
 * Built on FIRST USE rather than at module load. It spreads a table from another module, and a
 * module-level spread is evaluated in whatever order the bundler happened to link the two - so
 * an import cycle, or a dev server reloading one module without the other, reads the imported
 * name before it exists. Deferring it to the first call puts the read long after every module
 * has finished evaluating.
 */
export function textAttrDefaults(): Readonly<Record<string, unknown>> {
  return (cachedTextAttrDefaults ??= Object.freeze({
    ...shapeAttrDefaults(),
    runs: Object.freeze([]),
    align: 'left',
    maxWidth: undefined,
    wrap: 'word',
    lineHeight: 1,
    direction: 'ltr',
    orientation: 'horizontal',
    padding: 0,
    fontFamily: undefined,
    textPath: undefined,
  }))
}

export abstract class Text extends Shape {
  // THE BLOCK OPTIONS. Each is an accessor that re-shapes when the value really changes, for
  // the reason every geometry input on a mesh shape is one: the shaping is cached, and a
  // caller assigning `align` means the block to move. They are what layoutOptions() hands the
  // shaper, so between them they decide every glyph position in the node.
  //
  // markDirty() remains for what an assignment cannot see - a textPath object edited in place
  // rather than replaced, or a run's style rewritten through the array.

  private _align: TextAlign = 'left'
  /** Which edge the lines are flush with. */
  get align(): TextAlign {
    return this._align
  }
  set align(value: TextAlign) {
    if (value === this._align) return
    const previous = this._align
    this._align = value
    this.invalidateShaping()
    this.announce('align', previous, value)
  }

  private _maxWidth: number | undefined
  /** Where lines wrap, in world px; undefined never wraps. */
  get maxWidth(): number | undefined {
    return this._maxWidth
  }
  set maxWidth(value: number | undefined) {
    if (value === this._maxWidth) return
    const previous = this._maxWidth
    this._maxWidth = value
    this.invalidateShaping()
    this.announce('maxWidth', previous, value)
  }

  private _wrap: TextWrap = 'word'
  /** How `maxWidth` is enforced - see TextLayoutOptions.wrap. */
  get wrap(): TextWrap {
    return this._wrap
  }
  set wrap(value: TextWrap) {
    if (value === this._wrap) return
    const previous = this._wrap
    this._wrap = value
    this.invalidateShaping()
    this.announce('wrap', previous, value)
  }

  private _lineHeight = 1
  /** Line spacing as a multiple of the font's own ascent+descent. */
  get lineHeight(): number {
    return this._lineHeight
  }
  set lineHeight(value: number) {
    if (value === this._lineHeight) return
    const previous = this._lineHeight
    this._lineHeight = value
    this.invalidateShaping()
    this.announce('lineHeight', previous, value)
  }

  private _direction: TextDirection = 'ltr'
  /** Which way the runs advance along a line. */
  get direction(): TextDirection {
    return this._direction
  }
  set direction(value: TextDirection) {
    if (value === this._direction) return
    const previous = this._direction
    this._direction = value
    this.invalidateShaping()
    this.announce('direction', previous, value)
  }

  private _orientation: TextOrientation = 'horizontal'
  /** Whether lines stack downward or across. */
  get orientation(): TextOrientation {
    return this._orientation
  }
  set orientation(value: TextOrientation) {
    if (value === this._orientation) return
    const previous = this._orientation
    this._orientation = value
    this.invalidateShaping()
    this.announce('orientation', previous, value)
  }

  /** Blank space inside the block, in world px - see TextLayoutOptions.padding. */
  private _padding = 0
  get padding(): number {
    return this._padding
  }
  set padding(value: number) {
    if (value === this._padding) return
    const previous = this._padding
    this._padding = value
    this.invalidateShaping()
    this.announce('padding', previous, value)
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
    const previous = this._fontFamily
    this._fontFamily = value
    // Only this node re-shapes. Deliberately not the font epoch, which is for a family's contents
    // being replaced underneath every node at once.
    this.invalidateShaping()
    this.announce('fontFamily', previous, value)
  }

  private _textPath: TextPathOptions | undefined
  /**
   * A curve for the text to follow; undefined lays it out on a straight baseline.
   *
   * Replacing it re-shapes; editing the object in place does not, so call markDirty() after
   * that or assign a new one.
   */
  get textPath(): TextPathOptions | undefined {
    return this._textPath
  }
  set textPath(value: TextPathOptions | undefined) {
    if (value === this._textPath) return
    const previous = this._textPath
    this._textPath = value
    this.invalidateShaping()
    this.announce('textPath', previous, value)
  }

  /**
   * Whether Shape's `fill`/`stroke` reach the glyphs.
   *
   * False here, and that is the whole difference between this pair of classes and the uniform
   * pair: glyph colour is a property of a RUN, so a node holding several styled runs has no one
   * fill and Shape's is not read by either text path. UniformMSDFText and UniformVectorText
   * carry exactly one run and project the shape's paint onto it, so they answer true.
   *
   * A method rather than a field because it is consulted from Shape's constructor - which runs
   * before any subclass field initialiser, where a field would still read undefined.
   */
  protected paintsFromShape(): boolean {
    return false
  }

  // Warned about once each, so a paragraph assigned in a loop says it once rather than per node.
  private warnedAboutPaint = false

  /**
   * Says once, to the console, that this node's paint goes nowhere - see paintsFromShape.
   *
   * A warning rather than a throw, because the assignment is harmless and the node is otherwise
   * fine; and rather than silence, because invisible text with a fill set on it looks like a
   * font that failed to load.
   */
  private warnPaintIgnored(property: string): void {
    if (this.paintsFromShape() || this.warnedAboutPaint) return
    this.warnedAboutPaint = true
    console.warn(
      `${this.nodeName}: '${property}' is not read - glyph colour belongs to a run, so this node ` +
        `takes its paint from runs[].style (color, strokeColor, strokeWidth). For one style across ` +
        `the whole string, use Uniform${this.nodeName}, whose fill/stroke/strokeWidth do reach the glyphs.`,
    )
  }

  override get fill(): RGBA | null {
    return super.fill
  }
  override set fill(value: ColorInput | null) {
    super.fill = value
    // Only a paint that would show anything is worth a warning: `fill` and `stroke` default to
    // null, so a node that never asked for either says nothing.
    if (value !== null) this.warnPaintIgnored('fill')
  }

  override get stroke(): RGBA | null {
    return super.stroke
  }
  override set stroke(value: ColorInput | null) {
    super.stroke = value
    if (value !== null) this.warnPaintIgnored('stroke')
  }

  protected runsData: TextRun[]

  constructor(options: TextOptions = {}) {
    super(options)
    // The backing fields, not the setters: each setter invalidates, and invalidateShaping()
    // bumps a scene-wide epoch, so one per option per text node constructed would re-shape
    // every other text node in the scene as it was being populated. A node being built has
    // nothing cached to invalidate anyway.
    this._align = options.align ?? 'left'
    this._maxWidth = options.maxWidth
    this._wrap = options.wrap ?? 'word'
    this._lineHeight = options.lineHeight ?? 1
    this._direction = options.direction ?? 'ltr'
    this._orientation = options.orientation ?? 'horizontal'
    this._padding = options.padding ?? 0
    this._fontFamily = options.fontFamily
    this._textPath = options.textPath
    this.runsData = options.runs ?? (options.text !== undefined ? [{ text: options.text, style: options.style }] : [])
  }

  protected override attrKeys(): readonly string[] {
    return [
      ...super.attrKeys(),
      'runs',
      'align',
      'maxWidth',
      'wrap',
      'lineHeight',
      'direction',
      'orientation',
      'padding',
      'fontFamily',
      'textPath',
    ]
  }

  protected override attrDefaults(): Readonly<Record<string, unknown>> {
    return textAttrDefaults()
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
      wrap: this.wrap,
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
