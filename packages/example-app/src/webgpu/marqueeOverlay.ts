// MarqueeOverlay - the translucent rectangle drawn while a selection box is being pulled
// out. Purely a visual: the controller decides what the rectangle actually selects when
// it is released (see SceneInputController's onMarquee).
//
// Like the transformer frame, its width/height are baked geometry rather than a
// transform, so it re-tessellates as it is dragged - fine for a single quad that only
// exists during an active gesture.

import { Rect, type SceneRendererHandle } from '@mvpaint/engine'

const FILL = [0.16, 0.62, 1, 0.14] as const
const STROKE = [0.16, 0.62, 1, 0.9] as const
const STROKE_WIDTH_PX = 1
/** Above ordinary content, below the transformer's own handles. */
const Z_INDEX = 999_000

export class MarqueeOverlay {
  private rect: Rect | null = null

  /** Draws (or moves) the box between two world-space corners; null removes it. */
  update(handle: SceneRendererHandle, corners: { from: { x: number; y: number }; to: { x: number; y: number } } | null): void {
    if (!corners) {
      if (this.rect) {
        handle.scene.root.removeChild(this.rect)
        this.rect = null
        handle.markGeometryDirty()
      }
      return
    }

    const { from, to } = corners
    const width = Math.abs(to.x - from.x)
    const height = Math.abs(to.y - from.y)

    if (!this.rect) {
      this.rect = new Rect({
        name: '__marquee',
        fill: [...FILL],
        stroke: [...STROKE],
        zIndex: Z_INDEX,
      })
      this.rect.pickable = false
      this.rect.draggable = false
      this.rect.overlay = true
      handle.scene.root.addChild(this.rect)
    }

    this.rect.x = (from.x + to.x) / 2
    this.rect.y = (from.y + to.y) / 2
    // Keep the outline a constant weight on screen however far the view is zoomed.
    this.rect.strokeWidth = STROKE_WIDTH_PX / handle.getZoom()
    this.rect.width = width
    this.rect.height = height
    this.rect.markGeometryDirty()
    handle.markGeometryDirty()
  }
}
