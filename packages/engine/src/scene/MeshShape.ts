// MeshShape - the base for shapes drawn through the mesh lane (Rect, Circle, Polyline,
// Path): adds a settable size hint (width/height), the fill API (flat color or a
// gradient), and the tessellate() contract the mesh batcher tessellates into a shared
// vertex/index buffer. Everything positional (x/y/scale/rotation/offset/zIndex) lives on
// the shared Shape base, so it's identical for mesh shapes and Text.
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

import type { FillPriority, GradientStop, MeshSink, Point2, RGBA } from '../render/meshFormat'
import { Shape, type ShapeOptions } from './Shape'

export interface MeshShapeOptions extends ShapeOptions {
  width?: number
  height?: number
  fill?: RGBA
}

export abstract class MeshShape extends Shape {
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

  constructor(options: MeshShapeOptions = {}) {
    super(options)
    this.width = options.width ?? 0
    this.height = options.height ?? 0
    this.fill = options.fill ?? [0, 0, 0, 1]
  }

  /**
   * Emit this shape's geometry (in local space) into the sink: vertices with per-vertex
   * color and triangles referencing them. The renderer applies the per-object world
   * matrix in the vertex shader, so positions here are pre-transform.
   */
  abstract tessellate(sink: MeshSink): void
}
