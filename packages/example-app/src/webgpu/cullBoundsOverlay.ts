// CullBoundsOverlay - draws the camera's current (margin-expanded) viewport-culling
// rectangle as an outline, so the debug cull-margin slider's effect is visible on
// screen, not just numeric. Reuses the same "unfilled, stroked Rect added as a scene
// child" trick as SelectionHighlight, but the cull rectangle is already axis-aligned in
// WORLD space (it comes straight from the camera, never rotated/scaled), so there's no
// parent-transform bookkeeping to do - it's always a direct child of the scene root.

import { Rect, type SceneRendererHandle } from '@mvpaint/engine'

const OUTLINE_COLOR = [1, 0.45, 0, 1] as const
const OUTLINE_STROKE_WIDTH = 3

export class CullBoundsOverlay {
  private rect: Rect | null = null

  /**
   * Shows (or updates) the outline when `margin` is non-zero and the renderer has a
   * cull rectangle to show; removes it otherwise (margin back to 0, or bounds invalid -
   * e.g. a margin so negative the rectangle inverted).
   */
  update(handle: SceneRendererHandle, margin: number): void {
    const bounds = margin !== 0 ? handle.getCullBounds() : null

    if (!bounds || !bounds.valid()) {
      if (this.rect) {
        handle.scene.root.removeChild(this.rect)
        this.rect = null
        handle.markGeometryDirty()
      }
      return
    }

    const x = (bounds.min.x + bounds.max.x) / 2
    const y = (bounds.min.y + bounds.max.y) / 2
    const width = bounds.max.x - bounds.min.x
    const height = bounds.max.y - bounds.min.y

    if (!this.rect) {
      this.rect = new Rect({
        name: '__cull-bounds-overlay',
        // Always drawn on top, so the outline is never hidden behind scene content.
        zIndex: 10_000,
        fill: [0, 0, 0, 0],
        stroke: [...OUTLINE_COLOR],
        strokeWidth: OUTLINE_STROKE_WIDTH,
      })
      this.rect.pickable = false
      handle.scene.root.addChild(this.rect)
    }

    // Every field here (x/y/width/height) changes at least as often as the camera pans
    // or zooms - width/height are baked into geometry (unlike x/y, a pure transform),
    // so this needs markGeometryDirty() most frames the overlay is shown. That's the
    // accepted cost of an opt-in debug visualization, not something the default
    // (margin === 0, overlay absent) render path ever pays.
    this.rect.x = x
    this.rect.y = y
    this.rect.width = width
    this.rect.height = height
    this.rect.markGeometryDirty()
    handle.markGeometryDirty()
  }
}
