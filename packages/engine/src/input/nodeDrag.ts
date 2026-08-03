// Pure drag math for moving a node with the pointer, split out of SceneInputDispatcher
// so it can be checked without a canvas or a GPU (see input/input.test.ts) - the same way
// cameraControls.ts holds the pan/zoom math.

import type { Vector2Like } from '../math/Vector2'
import type { Node } from '../shapes/Node'
import { Vector3 } from '../math/Vector3'

/**
 * Where a node's x/y must land so that the world point grabbed at drag start stays under
 * the pointer, which is now over `currentWorld`.
 *
 * `startX`/`startY` are the node's own x/y when the drag began. Those are relative to its
 * PARENT, so the world-space drag delta has to be re-expressed in the parent's space: an
 * ancestor may rotate, scale, or flip the node's frame (the SVG loader's root matrix does
 * all three). The delta is a direction, not a position, so the parent's translation is
 * deliberately excluded - transformDirection, not transformPoint.
 *
 * Everything is resolved against the fixed start values rather than accumulated per
 * pointer move, so a long drag can't drift.
 */
export function draggedPosition(
  node: Node,
  startX: number,
  startY: number,
  anchorWorld: Vector2Like,
  currentWorld: Vector2Like,
): Vector2Like {
  let dx = currentWorld.x - anchorWorld.x
  let dy = currentWorld.y - anchorWorld.y

  if (node.parent) {
    const local = node.parent.worldMatrix().inverse().transformDirection(new Vector3(dx, dy, 0))
    dx = local.x
    dy = local.y
  }

  return { x: startX + dx, y: startY + dy }
}
