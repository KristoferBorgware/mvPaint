// CullBoundsOverlay - draws the camera's current (margin-expanded) viewport-culling
// rectangle as an outline, so the debug cull-margin slider's effect is visible on
// screen, not just numeric.
//
// Built the way Transformer builds its own frame: four UNIT quads, one per edge, only ever
// moved and scaled - never resized by width/height, never stroked. This used to be a single
// stroked Rect whose width/height/position changed on every frame the overlay was shown (the
// cull rectangle tracks the camera), which forced the ENTIRE shared mesh-lane buffer to
// re-tessellate and re-upload every one of those frames (see MeshBatcher) - fine to accept
// for an opt-in debug view over a small scene, not fine at all over a scene of thousands of
// shapes. A pure transform change costs nothing extra however large the scene is, so there's
// no longer a tradeoff to accept.

import { Rect, type SceneRendererHandle } from '@mvpaint/engine'

const OUTLINE_COLOR = [1, 0.45, 0, 1] as const
const OUTLINE_STROKE_WIDTH = 3
const Z_INDEX = 10_000

type EdgeName = 'top' | 'bottom' | 'left' | 'right'
const EDGES: readonly EdgeName[] = ['top', 'bottom', 'left', 'right']

export class CullBoundsOverlay {
  private readonly edges = new Map<EdgeName, Rect>()

  /**
   * Shows (or updates) the outline when `margin` is non-zero and the renderer has a
   * cull rectangle to show; removes it otherwise (margin back to 0, or bounds invalid -
   * e.g. a margin so negative the rectangle inverted).
   */
  update(handle: SceneRendererHandle, margin: number): void {
    const bounds = margin !== 0 ? handle.getCullBounds() : null

    if (!bounds || !bounds.valid()) {
      if (this.edges.size > 0) {
        for (const edge of this.edges.values()) handle.scene.root.removeChild(edge)
        this.edges.clear()
        // Membership changed (four shapes just left the scene) - rare (only when the
        // debug slider is toggled back to 0), unlike the per-frame move below.
        handle.markGeometryDirty()
      }
      return
    }

    const cx = (bounds.min.x + bounds.max.x) / 2
    const cy = (bounds.min.y + bounds.max.y) / 2
    const width = bounds.max.x - bounds.min.x
    const height = bounds.max.y - bounds.min.y

    if (this.edges.size === 0) {
      for (const edge of EDGES) this.edges.set(edge, this.makePart(handle, `__cull-bounds-${edge}`))
      handle.markGeometryDirty()
    }

    // Edges overlap at the corners by the outline's own thickness, which is what closes
    // the frame cleanly there - same technique as Transformer's border.
    const halfW = width / 2
    const halfH = height / 2
    this.placeEdge('top', cx, cy + halfH, width + OUTLINE_STROKE_WIDTH, OUTLINE_STROKE_WIDTH)
    this.placeEdge('bottom', cx, cy - halfH, width + OUTLINE_STROKE_WIDTH, OUTLINE_STROKE_WIDTH)
    this.placeEdge('left', cx - halfW, cy, OUTLINE_STROKE_WIDTH, height + OUTLINE_STROKE_WIDTH)
    this.placeEdge('right', cx + halfW, cy, OUTLINE_STROKE_WIDTH, height + OUTLINE_STROKE_WIDTH)
  }

  /** A unit quad: fill only, never stroked or resized by width/height, so it costs no geometry rebuilds. */
  private makePart(handle: SceneRendererHandle, name: string): Rect {
    const rect = new Rect({ name, width: 1, height: 1, fill: [...OUTLINE_COLOR], strokeWidth: 0, zIndex: Z_INDEX })
    rect.pickable = false
    rect.overlay = true
    handle.scene.root.addChild(rect)
    return rect
  }

  private placeEdge(edge: EdgeName, x: number, y: number, width: number, height: number): void {
    const rect = this.edges.get(edge)
    if (!rect) return
    rect.x = x
    rect.y = y
    rect.scaleX = width
    rect.scaleY = height
  }
}
