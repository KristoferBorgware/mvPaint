// Shape - the base for drawable leaf nodes. A Shape carries a transform (via
// localMatrix()) like any Node and tessellates its own geometry into the mesh lane.
// Shapes own NO GPU resources - the renderer owns all buffers/bind groups and reads
// each shape's worldMatrix() into the per-object transform buffer.
//
// Every Shape has a fill API, since any shape's fill triangles can use a flat color or
// a gradient: `fillPriority` selects which one is used ('color' uses `fill` directly;
// 'linear-gradient'/'radial-gradient' use the matching set of properties below). A
// shape whose tessellate() never emits fill vertices - only stroke, which is always a
// flat color - simply leaves these unused. Gradient points are in the shape's own
// local space, so a gradient moves and rotates with the shape.

import type { FillPriority, GradientStop, MeshSink, Point2, RGBA } from '../render/meshFormat'
import { Node } from './Node'

export abstract class Shape extends Node {
  /** Skipped by the renderer when false. */
  visible = true

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

  /**
   * Emit this shape's geometry (in local space) into the sink: vertices with per-vertex
   * color and triangles referencing them. The renderer applies the per-object world
   * matrix in the vertex shader, so positions here are pre-transform.
   */
  abstract tessellate(sink: MeshSink): void
}
