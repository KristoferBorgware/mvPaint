// Shape - the base for drawable leaf nodes (Konva-style Node → Shape). A Shape carries
// a transform (via localMatrix()) like any Node and knows how to record its own draw
// calls into a render pass. Concrete shapes (Rect, ...) implement draw(). The renderer
// walks the graph and draws each visible Shape through the active camera.

import type { Matrix4x4 } from '../math/Matrix4x4'
import { Node } from './Node'

export abstract class Shape extends Node {
  /** Skipped by the renderer when false (Konva-style). */
  visible = true

  /**
   * Record this shape's draw calls into an open render pass. `viewProjection` is the
   * active camera's matrix; the shape's model matrix is its worldMatrix().
   */
  abstract draw(pass: GPURenderPassEncoder, viewProjection: Matrix4x4): void

  /** Release any GPU resources this shape owns. */
  abstract destroy(): void
}
