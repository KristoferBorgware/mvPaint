// MarqueeOverlay - the translucent rectangle drawn while a selection box is being pulled
// out. Purely a visual: MarqueeTool holds the corners and resolves what they covered, and
// what covering something means is decided above it.
//
// Built the way Transformer builds its own frame: five UNIT quads (one fill, four border
// edges) that are only ever moved and scaled, never resized by width/height and never
// stroked - see Transformer's own header for why that matters. It used to be a single
// stroked Rect whose width/height changed on every pointer-move; a geometry change on ANY
// one shape forces the whole shared mesh-lane buffer to re-tessellate and re-upload (see
// MeshBatcher), so on a scene of thousands of shapes that meant redoing the entire scene's
// geometry on every mouse move during a drag. A pure transform change costs nothing extra
// however large the scene is.
//
// Also like Transformer, the five parts are PERMANENT: added once and hidden between
// gestures by scaling to zero rather than by leaving/re-entering the scene graph. This used
// to add/remove the parts per gesture and call markGeometryDirty() on each end, which - on a
// scene of thousands of shapes - meant every marquee drag (including a plain empty-space
// click, which begins and instantly ends a zero-size one) forced a full MeshBatcher.rebuild()
// of the ENTIRE shared mesh-lane buffer, twice. A permanent, zero-scale slot avoids that
// entirely: the mesh batcher's shape SET never changes, so pulling one out - or just starting
// and releasing it - costs nothing beyond these five quads.

import type { Vector2Like } from '../math/Vector2'
import { Container } from '../shapes/Container'
import { Rect } from '../shapes/Rect'
import type { RGBA } from '../render/meshFormat'
import { MV_GREEN } from '../render/color'

// The same green the transformer's frame is drawn in - a marquee becomes that frame the
// moment it is released, so anything else reads as two different tools.
const FILL: RGBA = [MV_GREEN[0], MV_GREEN[1], MV_GREEN[2], 0.14]
const STROKE: RGBA = [MV_GREEN[0], MV_GREEN[1], MV_GREEN[2], 0.9]
const STROKE_WIDTH_PX = 1
/** Above ordinary content, below the transformer's own handles. */
const Z_INDEX = 999_000

type EdgeName = 'top' | 'bottom' | 'left' | 'right'
const EDGES: readonly EdgeName[] = ['top', 'bottom', 'left', 'right']

export interface MarqueeOverlayOptions {
  /** The rectangle's wash. Default a translucent mv green. */
  fill?: RGBA
  /** Its border. Default the same green, near-opaque. */
  stroke?: RGBA
  /** Border thickness in SCREEN pixels, held constant across zoom. Default 1. */
  strokeWidth?: number
}

export class MarqueeOverlay extends Container {
  override readonly nodeName: string = 'MarqueeOverlay'

  private readonly fill: Rect
  private readonly edges = new Map<EdgeName, Rect>()
  private readonly strokeWidth: number

  constructor(options: MarqueeOverlayOptions = {}) {
    super('__marquee-overlay')
    this.strokeWidth = options.strokeWidth ?? STROKE_WIDTH_PX
    this.fill = this.makePart('__marquee-fill', options.fill ?? FILL)
    for (const edge of EDGES) this.edges.set(edge, this.makePart(`__marquee-${edge}`, options.stroke ?? STROKE))
  }

  /** Draws (or moves) the box between two world-space corners, at the given camera zoom
   * (for a constant on-screen border weight); null hides it. */
  update(corners: { from: Vector2Like; to: Vector2Like } | null, zoom: number): void {
    if (!corners) {
      this.hideAll()
      return
    }

    const { from, to } = corners
    const width = Math.abs(to.x - from.x)
    const height = Math.abs(to.y - from.y)
    const cx = (from.x + to.x) / 2
    const cy = (from.y + to.y) / 2

    this.fill.x = cx
    this.fill.y = cy
    this.fill.scaleX = width
    this.fill.scaleY = height

    // Keep the border a constant weight on screen however far the view is zoomed - same
    // reasoning as Transformer's own border. Edges overlap at the corners by the border's
    // own thickness, which is what closes the frame cleanly there.
    const thickness = this.strokeWidth / (zoom > 0 ? zoom : 1)
    const halfW = width / 2
    const halfH = height / 2
    this.placeEdge('top', cx, cy + halfH, width + thickness, thickness)
    this.placeEdge('bottom', cx, cy - halfH, width + thickness, thickness)
    this.placeEdge('left', cx - halfW, cy, thickness, height + thickness)
    this.placeEdge('right', cx + halfW, cy, thickness, height + thickness)
  }

  /**
   * A unit quad: fill only, never stroked or resized by width/height, so it costs no
   * geometry rebuilds. Pivoted at its middle, because placeEdge below positions each bar
   * by its centre and a Rect's own origin is its top-left corner.
   */
  private makePart(name: string, fill: RGBA): Rect {
    const rect = new Rect({
      name,
      width: 1,
      height: 1,
      offsetX: 0.5,
      offsetY: -0.5,
      fill: [...fill],
      strokeWidth: 0,
      zIndex: Z_INDEX,
      scaleX: 0,
      scaleY: 0,
    })
    rect.pickable = false
    rect.draggable = false
    rect.overlay = true
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

  /** Collapses every part to zero scale - invisible without dropping out of the mesh
   * batcher's shape set (see the class comment on why that distinction matters). */
  private hideAll(): void {
    this.fill.scaleX = 0
    this.fill.scaleY = 0
    for (const rect of this.edges.values()) {
      rect.scaleX = 0
      rect.scaleY = 0
    }
  }
}
