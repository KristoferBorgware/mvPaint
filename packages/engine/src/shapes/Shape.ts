// Shape - the base for every drawable scene-graph node (Rect, Circle, Polyline, Path,
// Text). Carries the full common vocabulary every drawable shares: transform (position,
// scale, rotation, pivot offset), visibility/pickability, stacking order (zIndex), a
// settable size (width/height), and the complete fill/stroke styling API (flat color or
// gradient fill; stroke color/width/join/cap/miter limit) - mirroring how a well-known
// 2D canvas library's Shape class puts all of this in one place rather than splitting it
// by "how the shape happens to be drawn". Concrete shapes only add what's genuinely
// specific to them (Rect: nothing beyond a default size; Circle: radius; Polyline:
// points; Path: contours; Text: runs and block layout).
//
// tessellate() defaults to emitting nothing - that's what makes it safe for Text (which
// renders through the separate MSDF text lane, not the mesh lane) to inherit it
// unchanged; every mesh-drawn shape overrides it with real geometry. A shape whose
// tessellate() never emits fill vertices (stroke-only, like Polyline), or whose stroke
// width is 0, simply leaves the unused half of the fill/stroke API alone.
//
// localMatrix() composes translate(x, y) * rotate(rotation) * scale(scaleX, scaleY) *
// translate(-offsetX, -offsetY): offset shifts the shape's own pivot (applied first, to
// the shape's local geometry) before scale and rotation are applied about that pivot,
// then the result is placed at (x, y). Skew (shear) is not currently supported.

import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Vector3 } from '../math/Vector3'
import type { FillPriority, GradientStop, MeshSink, Point2, RGBA } from '../render/meshFormat'
import type { LineCap, LineJoin } from '../render/stroke'
import { Node } from './Node'

export interface ShapeOptions {
  name?: string
  x?: number
  y?: number
  width?: number
  height?: number
  scaleX?: number
  scaleY?: number
  /** Radians, about +Z. */
  rotation?: number
  offsetX?: number
  offsetY?: number
  /**
   * Stacking-order hint: shapes with a higher zIndex render in front, resolved by the
   * renderer's depth buffer (so mesh shapes and text can freely interleave). Integer-
   * valued by convention; ties fall back to scene-graph order. Default 0.
   */
  zIndex?: number
  fill?: RGBA
  stroke?: RGBA
  /** Stroke width in world units; 0 = no stroke. */
  strokeWidth?: number
  lineJoin?: LineJoin
  /** Only applies to open contours (e.g. Polyline with `closed: false`). */
  lineCap?: LineCap
  miterLimit?: number
}

export abstract class Shape extends Node {
  /** Skipped by the renderer when false. */
  visible = true
  /** Excluded from pickNode() hit-testing when false (e.g. a selection-highlight overlay). */
  pickable = true

  x = 0
  y = 0
  scaleX = 1
  scaleY = 1
  /** Radians, about +Z. */
  rotation = 0
  offsetX = 0
  offsetY = 0
  zIndex = 0

  protected _width = 0
  protected _height = 0

  get width(): number {
    return this._width
  }
  set width(value: number) {
    this._width = value
  }
  get height(): number {
    return this._height
  }
  set height(value: number) {
    this._height = value
  }

  /** Flat fill color, used when fillPriority is 'color'. */
  fill: RGBA = [0, 0, 0, 1]

  /** Which fill mechanism this shape's fill triangles use. */
  fillPriority: FillPriority = 'color'

  fillLinearGradientStartPoint: Point2 = { x: 0, y: 0 }
  fillLinearGradientEndPoint: Point2 = { x: 0, y: 0 }
  fillLinearGradientColorStops: GradientStop[] = []

  fillRadialGradientStartPoint: Point2 = { x: 0, y: 0 }
  fillRadialGradientStartRadius = 0
  fillRadialGradientEndPoint: Point2 = { x: 0, y: 0 }
  fillRadialGradientEndRadius = 0
  fillRadialGradientColorStops: GradientStop[] = []

  stroke: RGBA = [0, 0, 0, 1]
  strokeWidth = 0
  lineJoin: LineJoin = 'miter'
  lineCap: LineCap = 'butt'
  miterLimit = 10

  constructor(options: ShapeOptions = {}) {
    super(options.name)
    this.x = options.x ?? 0
    this.y = options.y ?? 0
    this.width = options.width ?? 0
    this.height = options.height ?? 0
    this.scaleX = options.scaleX ?? 1
    this.scaleY = options.scaleY ?? 1
    this.rotation = options.rotation ?? 0
    this.offsetX = options.offsetX ?? 0
    this.offsetY = options.offsetY ?? 0
    this.zIndex = options.zIndex ?? 0
    this.fill = options.fill ?? [0, 0, 0, 1]
    this.stroke = options.stroke ?? [0, 0, 0, 1]
    this.strokeWidth = options.strokeWidth ?? 0
    this.lineJoin = options.lineJoin ?? 'miter'
    this.lineCap = options.lineCap ?? 'butt'
    this.miterLimit = options.miterLimit ?? 10
  }

  override localMatrix(): Matrix4x4 {
    let m = Matrix4x4.translation(new Vector3(this.x, this.y, 0))
    if (this.rotation !== 0) {
      m = m.mul(Matrix4x4.rotationQuaternion(Quaternion.fromAxisAngle(Vector3.unitZ(), this.rotation)))
    }
    if (this.scaleX !== 1 || this.scaleY !== 1) {
      m = m.mul(Matrix4x4.scaling(new Vector3(this.scaleX, this.scaleY, 1)))
    }
    if (this.offsetX !== 0 || this.offsetY !== 0) {
      m = m.mul(Matrix4x4.translation(new Vector3(-this.offsetX, -this.offsetY, 0)))
    }
    return m
  }

  /**
   * Emit this shape's geometry (in local space) into the sink: vertices with per-vertex
   * color and triangles referencing them. The renderer applies the per-object world
   * matrix in the vertex shader, so positions here are pre-transform. The default emits
   * nothing - Text (rendered through the separate text lane) relies on exactly that;
   * every mesh-drawn shape overrides this.
   */
  tessellate(_sink: MeshSink): void {}
}
