// Text - a drawable leaf node rendered through the MSDF text lane (not the mesh lane, so it
// extends Node directly rather than Shape). It carries the scene transform (position, rotation,
// scale) plus its styled runs and block-layout options, and caches the shaped result (glyph +
// decoration quads and per-run materials) until its content changes. Its transform is applied
// in the vertex shader like every other node, so moving or scaling a Text never re-shapes it;
// only editing the runs or layout does.

import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Vector3 } from '../math/Vector3'
import { Node } from '../scene/Node'
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

export interface TextOptions {
  name?: string
  x?: number
  y?: number
  /** Radians, about +Z. */
  rotation?: number
  scaleX?: number
  scaleY?: number
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

export class Text extends Node {
  /** Skipped by the renderer when false. */
  visible = true

  x = 0
  y = 0
  /** Radians, about +Z. */
  rotation = 0
  scaleX = 1
  scaleY = 1

  align: TextAlign
  maxWidth: number | undefined
  lineHeight: number
  direction: TextDirection
  orientation: TextOrientation

  private runsData: TextRun[]
  private shapedCache: ShapedText | null = null

  constructor(options: TextOptions = {}) {
    super(options.name)
    this.x = options.x ?? 0
    this.y = options.y ?? 0
    this.rotation = options.rotation ?? 0
    this.scaleX = options.scaleX ?? 1
    this.scaleY = options.scaleY ?? 1
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

  override localMatrix(): Matrix4x4 {
    let m = Matrix4x4.translation(new Vector3(this.x, this.y, 0))
    if (this.rotation !== 0) {
      m = m.mul(Matrix4x4.rotationQuaternion(Quaternion.fromAxisAngle(Vector3.unitZ(), this.rotation)))
    }
    if (this.scaleX !== 1 || this.scaleY !== 1) {
      m = m.mul(Matrix4x4.scaling(new Vector3(this.scaleX, this.scaleY, 1)))
    }
    return m
  }
}
