// SelectionHighlight - draws a dashed-looking (thin, bright) outline rect around
// whatever node is currently picked, sized and positioned from the node's own local
// bounds (see @mvpaint/engine's localBoundsOf/pickNode). It's a plain Rect reusing the
// mesh lane, added as a sibling of the picked node so it inherits the exact same
// ancestor transform chain - which is what makes it line up under rotation/scale/nesting
// without any extra transform math beyond copying the node's own local fields.

import { Container, Rect, Shape, type PickableNode, type SceneRendererHandle } from '@mvpaint/engine'

const HIGHLIGHT_COLOR = [0.16, 0.62, 1, 1] as const
const HIGHLIGHT_PADDING = 6 // world px, added around the node's own bounds
const HIGHLIGHT_STROKE_WIDTH = 2.5

export class SelectionHighlight {
  private rect: Rect | null = null
  private parent: Container | null = null

  /** Moves the highlight onto `node` (or clears it for null). */
  update(handle: SceneRendererHandle, node: PickableNode | null): void {
    if (this.rect && this.parent) {
      this.parent.removeChild(this.rect)
      this.rect = null
      this.parent = null
    }

    if (node) {
      const bounds = handle.localBoundsOf(node)
      if (bounds.valid()) {
        const cx = (bounds.min.x + bounds.max.x) / 2
        const cy = (bounds.min.y + bounds.max.y) / 2
        // A Shape's own pivot offset applies before the highlight's recentering offset
        // below is computed, so it has to be folded in too; Text has no offset field.
        const pivotX = node instanceof Shape ? node.offsetX : 0
        const pivotY = node instanceof Shape ? node.offsetY : 0

        const rect = new Rect({
          name: '__selection-highlight',
          x: node.x,
          y: node.y,
          rotation: node.rotation,
          scaleX: node.scaleX,
          scaleY: node.scaleY,
          width: bounds.max.x - bounds.min.x + HIGHLIGHT_PADDING * 2,
          height: bounds.max.y - bounds.min.y + HIGHLIGHT_PADDING * 2,
          fill: [0, 0, 0, 0],
          stroke: [...HIGHLIGHT_COLOR],
          strokeWidth: HIGHLIGHT_STROKE_WIDTH,
        })
        // Recenters the highlight's own (origin-centered) quad on the picked node's
        // local bounds center, in the same pre-scale/rotate frame as the node's pivot.
        rect.offsetX = pivotX - cx
        rect.offsetY = pivotY - cy
        rect.pickable = false

        const parent = node.parent instanceof Container ? node.parent : handle.scene.root
        parent.addChild(rect)
        this.rect = rect
        this.parent = parent
      }
    }

    handle.markGeometryDirty()
  }
}
