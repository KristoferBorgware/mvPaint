// MarqueeOverlay - the translucent rectangle drawn while a selection box is being pulled
// out. Purely a visual: the controller decides what the rectangle actually selects when
// it is released (see SceneInputController's onMarquee).
//
// Built the way Transformer builds its own frame: five UNIT quads (one fill, four border
// edges) that are only ever moved and scaled, never resized by width/height and never
// stroked - see Transformer's own header for why that matters. It used to be a single
// stroked Rect whose width/height changed on every pointer-move; a geometry change on ANY
// one shape forces the whole shared mesh-lane buffer to re-tessellate and re-upload (see
// MeshBatcher), so on a scene of thousands of shapes that meant redoing the entire scene's
// geometry on every mouse move during a drag. A pure transform change costs nothing extra
// however large the scene is.

import { Rect, type SceneRendererHandle } from '@mvpaint/engine'

const FILL = [0.16, 0.62, 1, 0.14] as const
const STROKE = [0.16, 0.62, 1, 0.9] as const
const STROKE_WIDTH_PX = 1
/** Above ordinary content, below the transformer's own handles. */
const Z_INDEX = 999_000

type EdgeName = 'top' | 'bottom' | 'left' | 'right'
const EDGES: readonly EdgeName[] = ['top', 'bottom', 'left', 'right']

export class MarqueeOverlay {
  private fill: Rect | null = null
  private readonly edges = new Map<EdgeName, Rect>()

  /** Draws (or moves) the box between two world-space corners; null removes it. */
  update(handle: SceneRendererHandle, corners: { from: { x: number; y: number }; to: { x: number; y: number } } | null): void {
    if (!corners) {
      if (this.fill) {
        handle.scene.root.removeChild(this.fill)
        for (const edge of this.edges.values()) handle.scene.root.removeChild(edge)
        this.fill = null
        this.edges.clear()
        // Membership changed (five shapes just left the scene) - rare (once per gesture),
        // unlike the per-frame resize below, which needs no rebuild at all now.
        handle.markGeometryDirty()
      }
      return
    }

    const { from, to } = corners
    const width = Math.abs(to.x - from.x)
    const height = Math.abs(to.y - from.y)
    const cx = (from.x + to.x) / 2
    const cy = (from.y + to.y) / 2

    if (!this.fill) {
      this.fill = this.makePart(handle, '__marquee-fill', FILL)
      for (const edge of EDGES) this.edges.set(edge, this.makePart(handle, `__marquee-${edge}`, STROKE))
      handle.markGeometryDirty()
    }

    this.fill.x = cx
    this.fill.y = cy
    this.fill.scaleX = width
    this.fill.scaleY = height

    // Keep the border a constant weight on screen however far the view is zoomed - same
    // reasoning as Transformer's own border. Edges overlap at the corners by the border's
    // own thickness, which is what closes the frame cleanly there.
    const thickness = STROKE_WIDTH_PX / handle.getZoom()
    const halfW = width / 2
    const halfH = height / 2
    this.placeEdge('top', cx, cy + halfH, width + thickness, thickness)
    this.placeEdge('bottom', cx, cy - halfH, width + thickness, thickness)
    this.placeEdge('left', cx - halfW, cy, thickness, height + thickness)
    this.placeEdge('right', cx + halfW, cy, thickness, height + thickness)
  }

  /** A unit quad: fill only, never stroked or resized by width/height, so it costs no geometry rebuilds. */
  private makePart(handle: SceneRendererHandle, name: string, fill: readonly [number, number, number, number]): Rect {
    const rect = new Rect({ name, width: 1, height: 1, fill: [...fill], strokeWidth: 0, zIndex: Z_INDEX })
    rect.pickable = false
    rect.draggable = false
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
