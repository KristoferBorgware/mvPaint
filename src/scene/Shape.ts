// Shape - the base for drawable leaf nodes (Konva-style Node → Shape). A Shape carries
// a transform (via localMatrix()) like any Node and tessellates its own geometry into
// the mesh lane. Shapes own NO GPU resources - the renderer owns all buffers/bind groups
// and reads each shape's worldMatrix() into the per-object transform buffer.

import type { MeshSink } from '../render/meshFormat'
import { Node } from './Node'

export abstract class Shape extends Node {
  /** Skipped by the renderer when false (Konva-style). */
  visible = true

  /**
   * Emit this shape's geometry (in local space) into the sink: vertices with per-vertex
   * color and triangles referencing them. The renderer applies the per-object world
   * matrix in the vertex shader, so positions here are pre-transform.
   */
  abstract tessellate(sink: MeshSink): void
}
