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
//
// Also like Transformer, the four edges are PERMANENT: added once (a Container, added to the
// scene root exactly once by the caller) and hidden by scaling to zero rather than by
// leaving/re-entering the scene graph - toggling the debug slider back to 0 used to remove
// them and call markGeometryDirty(), forcing a full MeshBatcher.rebuild() of the whole scene
// just to hide four quads.

import { Container, Rect } from '@mvpaint/engine'
import type { AABB } from '@mvpaint/engine'

const OUTLINE_COLOR = [1, 0.45, 0, 1] as const
const OUTLINE_STROKE_WIDTH = 3
const Z_INDEX = 10_000

type EdgeName = 'top' | 'bottom' | 'left' | 'right'
const EDGES: readonly EdgeName[] = ['top', 'bottom', 'left', 'right']

export class CullBoundsOverlay extends Container {
  private readonly edges = new Map<EdgeName, Rect>()

  constructor() {
    super('__cull-bounds-overlay')
    for (const edge of EDGES) this.edges.set(edge, this.makePart(`__cull-bounds-${edge}`))
  }

  /**
   * Shows (or updates) the outline when `bounds` is non-null and valid; hides it otherwise
   * (margin back to 0, or bounds invalid - e.g. a margin so negative the rectangle inverted).
   */
  update(bounds: AABB | null): void {
    if (!bounds || !bounds.valid()) {
      this.hideAll()
      return
    }

    const cx = (bounds.min.x + bounds.max.x) / 2
    const cy = (bounds.min.y + bounds.max.y) / 2
    const width = bounds.max.x - bounds.min.x
    const height = bounds.max.y - bounds.min.y

    const halfW = width / 2
    const halfH = height / 2
    this.placeEdge('top', cx, cy + halfH, width + OUTLINE_STROKE_WIDTH, OUTLINE_STROKE_WIDTH)
    this.placeEdge('bottom', cx, cy - halfH, width + OUTLINE_STROKE_WIDTH, OUTLINE_STROKE_WIDTH)
    this.placeEdge('left', cx - halfW, cy, OUTLINE_STROKE_WIDTH, height + OUTLINE_STROKE_WIDTH)
    this.placeEdge('right', cx + halfW, cy, OUTLINE_STROKE_WIDTH, height + OUTLINE_STROKE_WIDTH)
  }

  /**
   * A unit quad: fill only, never stroked or resized by width/height, so it costs no
   * geometry rebuilds. Pivoted at its middle, because placeEdge below positions each bar
   * by its centre and a Rect's own origin is its top-left corner.
   */
  private makePart(name: string): Rect {
    const rect = new Rect({ name, width: 1, height: 1, offsetX: 0.5, offsetY: -0.5, fill: [...OUTLINE_COLOR], strokeWidth: 0, zIndex: Z_INDEX, scaleX: 0, scaleY: 0 })
    rect.pickable = false
    this.addChild(rect)
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

  /** Collapses every edge to zero scale - invisible without dropping out of the mesh
   * batcher's shape set (see the class comment on why that distinction matters). */
  private hideAll(): void {
    for (const rect of this.edges.values()) {
      rect.scaleX = 0
      rect.scaleY = 0
    }
  }
}
