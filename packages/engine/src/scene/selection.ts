// Marquee (rubber-band) selection: which shapes a dragged-out world rectangle picks up.
// Sits alongside pickNode() in picking.ts - same z-order source, same visible/pickable
// rules - but answers "everything within this region" instead of "the topmost thing under
// this point", and so tests world-space bounds rather than exact triangles: a marquee is
// a coarse gesture, and box-vs-box is what every editor uses for it.

import { AABB } from '../math/AABB'
import { Vector3 } from '../math/Vector3'
import type { Scene } from './Scene'
import { Shape } from '../shapes/Shape'
import { Text } from '../shapes/Text'
import type { FontProvider } from '../text/layout'
import { textLocalBounds } from './picking'

export interface MarqueeOptions {
  /**
   * 'intersect' (default) selects anything the rectangle touches; 'contain' only takes
   * shapes that fall entirely inside it. Both conventions are common - Figma uses
   * intersect, some CAD tools use contain - so it's a caller choice.
   */
  mode?: 'intersect' | 'contain'
  /** Needed to measure Text nodes; without it they are skipped rather than mis-measured. */
  fontBook?: FontProvider
}

/** A shape's bounds in world space, or null when it has nothing to measure. */
export function worldBounds(shape: Shape, fonts?: FontProvider): AABB | null {
  const local =
    shape instanceof Text
      ? fonts
        ? textLocalBounds(shape.shaped(fonts))
        : null
      : shape.localBounds()
  if (!local || !local.valid()) return null
  return local.transformed(shape.worldMatrix())
}

/** True if `outer` fully encloses `inner` on the x/y axes (z is ignored - the scene is 2D). */
function contains2D(outer: AABB, inner: AABB): boolean {
  return (
    inner.min.x >= outer.min.x &&
    inner.max.x <= outer.max.x &&
    inner.min.y >= outer.min.y &&
    inner.max.y <= outer.max.y
  )
}

/**
 * Every visible, pickable shape whose world bounds meet the world-space rectangle
 * (`from`/`to` are opposite corners in any order - a drag can go in any direction).
 * Returned in the scene's z-order, back to front, so the result lines up with
 * collectZOrder()/pickNode() rather than raw traversal order.
 */
export function nodesInBox(
  scene: Scene,
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: MarqueeOptions = {},
): Shape[] {
  const mode = options.mode ?? 'intersect'
  const box = new AABB(
    new Vector3(Math.min(from.x, to.x), Math.min(from.y, to.y), -Infinity),
    new Vector3(Math.max(from.x, to.x), Math.max(from.y, to.y), Infinity),
  )

  const hits: Shape[] = []
  scene.root.traversePreOrder((node) => {
    if (!(node instanceof Shape) || !node.visible || !node.pickable) return
    const bounds = worldBounds(node, options.fontBook)
    if (!bounds) return
    if (mode === 'contain' ? contains2D(box, bounds) : box.intersects(bounds)) {
      hits.push(node)
    }
  })
  return hits.sort((a, b) => a.zIndex - b.zIndex)
}
