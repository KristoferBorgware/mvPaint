// SelectionHighlight - draws a dashed-looking (thin, bright) outline rect around
// whatever node is currently picked, sized and positioned from the node's own local
// bounds (see @mvpaint/engine's localBoundsOf/pickNode). It's a plain Rect reusing the
// mesh lane, added as a sibling of the picked node so it inherits the exact same
// ancestor transform chain - which is what makes it line up under rotation/scale/nesting
// without any extra transform math beyond copying the node's own local fields.
//
// Those copied fields are re-synced every frame (see sync()), so the outline tracks a
// node that is moving - dragged by the pointer, or animated by the app - instead of
// staying where the node happened to be when it was picked.

import { Container, Rect, type PickableNode, type SceneRendererHandle } from '@mvpaint/engine'

const HIGHLIGHT_COLOR = [0.16, 0.62, 1, 1] as const
const HIGHLIGHT_PADDING = 6 // world px, added around the node's own bounds
const HIGHLIGHT_STROKE_WIDTH = 2.5

export class SelectionHighlight {
  private rect: Rect | null = null
  private parent: Container | null = null
  private node: PickableNode | null = null
  // The picked node's local-bounds center, which the outline is recentered on. Fixed for
  // as long as the node's geometry is (a transform never moves it), so it's captured
  // once here rather than recomputed on every sync().
  private centerX = 0
  private centerY = 0

  /** Moves the highlight onto `node` (or clears it for null). */
  update(handle: SceneRendererHandle, node: PickableNode | null): void {
    if (this.rect && this.parent) {
      this.parent.removeChild(this.rect)
      this.rect = null
      this.parent = null
    }
    this.node = null

    if (node) {
      const bounds = handle.localBoundsOf(node)
      if (bounds.valid()) {
        this.centerX = (bounds.min.x + bounds.max.x) / 2
        this.centerY = (bounds.min.y + bounds.max.y) / 2

        const rect = new Rect({
          name: '__selection-highlight',
          width: bounds.max.x - bounds.min.x + HIGHLIGHT_PADDING * 2,
          height: bounds.max.y - bounds.min.y + HIGHLIGHT_PADDING * 2,
          fill: [0, 0, 0, 0],
          stroke: [...HIGHLIGHT_COLOR],
          strokeWidth: HIGHLIGHT_STROKE_WIDTH,
        })
        rect.pickable = false

        const parent = node.parent instanceof Container ? node.parent : handle.scene.root
        parent.addChild(rect)
        this.rect = rect
        this.parent = parent
        this.node = node
        this.sync()
      }
    }

    handle.markGeometryDirty()
  }

  /**
   * Re-copies the highlighted node's transform onto the outline. Cheap enough to call
   * every frame: every field here is transform-only (applied per frame from the object's
   * world matrix), so unlike the outline's width/height it never dirties geometry.
   */
  sync(): void {
    const rect = this.rect
    const node = this.node
    if (!rect || !node) return
    rect.x = node.x
    rect.y = node.y
    rect.rotation = node.rotation
    rect.scaleX = node.scaleX
    rect.scaleY = node.scaleY
    // Recenters the highlight's own (origin-centered) quad on the picked node's local
    // bounds center, in the same pre-scale/rotate frame as the node's own pivot offset.
    rect.offsetX = node.offsetX - this.centerX
    rect.offsetY = node.offsetY - this.centerY
  }
}
