// Shape - the base for drawable leaf nodes. A Shape carries the common geometric
// parameters every shape shares - position (x, y), size (width, height), scale
// (scaleX, scaleY), rotation, and pivot offset (offsetX, offsetY) - plus the fill API
// (flat color or a gradient). Concrete shapes only add what's specific to them
// (Rect: strokeWidth; Circle: radius; ...); the common parameters and their transform
// composition live here once. Shapes own NO GPU resources - the renderer owns all
// buffers/bind groups and reads each shape's worldMatrix() into the per-object
// transform buffer.
//
// localMatrix() composes translate(x, y) * rotate(rotation) * scale(scaleX, scaleY) *
// translate(-offsetX, -offsetY): offset shifts the shape's own pivot (applied first, to
// the shape's local geometry) before scale and rotation are applied about that pivot,
// then the result is placed at (x, y). Skew (shear) is not currently supported.
//
// Width/height default to 0 and are a plain, independent size hint - Rect ties its
// fill/stroke geometry to them directly; a shape like Polyline, whose size comes from
// its own point list, simply leaves them unused (consistent with each other, since
// stroke geometry has no separate size parameter of its own). Circle overrides the
// width/height accessors to derive them from its own `radius` instead of storing them
// independently - see Circle.ts.
//
// Gradient points are in the shape's own local space (pre-transform, before x/y/scale/
// rotation/offset are applied), so a gradient moves and rotates with its shape. A shape
// whose tessellate() never emits fill vertices - only stroke, which is always a flat
// color - simply leaves the fill properties unused.

import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Vector3 } from '../math/Vector3'
import type { FillPriority, GradientStop, MeshSink, Point2, RGBA } from '../render/meshFormat'
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
  fill?: RGBA
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
    this.fill = options.fill ?? [0, 0, 0, 1]
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
   * matrix in the vertex shader, so positions here are pre-transform.
   */
  abstract tessellate(sink: MeshSink): void
}
