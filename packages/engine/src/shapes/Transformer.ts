// Transformer - the classic selection frame: a border around the current selection, eight
// resize anchors, and a rotate handle above the top edge. It is an ordinary Container of
// Rects in the scene, so it draws through the same mesh lane as everything else and needs
// no special-case rendering.
//
// It never parents itself to the selected nodes. It sits at the scene root and re-fits
// itself from their world bounds, which is what lets one frame wrap a multi-node selection
// whose members live under different (possibly transformed) parents. The gestures
// themselves live in transformerMath.ts; this file is the scene bookkeeping around them.
//
// Every part is a UNIT quad that is only ever moved, turned and scaled - never resized by
// its width/height, and never stroked. That matters: width/height/strokeWidth are baked
// into geometry, so changing them needs a buffer rebuild that only the renderer can
// trigger, and the transformer has no handle on the renderer. Driving everything through
// the transform instead means the frame tracks a selection that is being dragged, scaled
// or spun with no rebuild at all - which is also why the border is four edge quads and
// each anchor is two stacked quads (an outer one showing through as its border) rather
// than stroked rectangles.
//
// Anchors are held at a constant SCREEN size: their world size is divided by the camera
// zoom, so a handle stays comfortably clickable whether the view is zoomed way in or out.
//
// Parts stay Shape.visible = true permanently, selection or not - hiding them is done by
// scaling to zero instead (see hideAll()). Toggling visible would drop them out of
// collectZOrder's traversal (see scene/picking.ts), changing the mesh batcher's shape SET
// the instant a selection starts or ends - and MeshBatcher.rebuild() re-tessellates and
// re-uploads EVERY shape sharing the batch when that set changes, not just the ones that
// actually differ. On a scene with thousands of other shapes, that turns "select
// something" into a full-scene rebuild costing orders of magnitude more than the ~20
// unit quads that actually needed it. A permanent, zero-scale slot avoids that entirely:
// the set never changes, so selecting/deselecting costs nothing beyond these few quads.

import { Container } from './Container'
import { Rect } from './Rect'
import type { Shape } from './Shape'
import type { RGBA } from '../render/meshFormat'
import {
  RESIZE_ANCHORS,
  anchorPosition,
  rotateAnchorPosition,
  type OrientedBox,
  type ResizeAnchor,
  type TransformerAnchor,
} from './transformerMath'

export interface TransformerOptions {
  /** Anchor edge length in SCREEN pixels, held constant across zoom. Default 10. */
  anchorSize?: number
  /** How far past the top edge the rotate handle sits, in screen pixels. Default 24. */
  rotateAnchorOffset?: number
  /** Extra room between the selection's bounds and the frame, in screen pixels. Default 4. */
  padding?: number
  /** Border thickness in screen pixels. Default 1.5. */
  borderWidth?: number
  /** Anchor border thickness in screen pixels. Default 1.5. */
  anchorBorderWidth?: number
  /** Which resize anchors to show. Default: all eight. */
  enabledAnchors?: readonly ResizeAnchor[]
  /** Show the rotate handle. Default true. */
  rotateEnabled?: boolean
  /**
   * Lock the aspect ratio when dragging a CORNER anchor. Default true - the classic
   * behaviour, and what the request calls uniform corner scaling. Set false to let
   * corners scale each axis freely; holding shift inverts whichever way this is set.
   */
  keepRatio?: boolean
  borderColor?: RGBA
  anchorFill?: RGBA
  anchorStroke?: RGBA
}

const DEFAULT_BORDER: RGBA = [0.16, 0.62, 1, 1]
const DEFAULT_ANCHOR_FILL: RGBA = [1, 1, 1, 1]
const DEFAULT_ANCHOR_STROKE: RGBA = [0.16, 0.62, 1, 1]
/** Anchors are picked within this many screen px of their center - forgiving on touch. */
const ANCHOR_HIT_SLOP_PX = 6
/** Sits above ordinary content; the overlay pass keeps it above the text lane too. */
const TRANSFORMER_Z_INDEX = 1_000_000

type EdgeName = 'top' | 'bottom' | 'left' | 'right'
const EDGES: readonly EdgeName[] = ['top', 'bottom', 'left', 'right']

interface AnchorVisual {
  outer: Rect
  inner: Rect
}

export class Transformer extends Container {
  override readonly nodeName: string = 'Transformer'

  readonly anchorSize: number
  readonly rotateAnchorOffset: number
  readonly padding: number
  readonly borderWidth: number
  readonly anchorBorderWidth: number
  readonly enabledAnchors: readonly ResizeAnchor[]
  readonly rotateEnabled: boolean
  keepRatio: boolean

  private nodes: Shape[] = []
  private box: OrientedBox | null = null
  private zoom = 1

  private readonly edges = new Map<EdgeName, Rect>()
  private readonly anchors = new Map<TransformerAnchor, AnchorVisual>()
  private readonly parts: Rect[] = []

  constructor(options: TransformerOptions = {}) {
    super('__transformer')
    this.anchorSize = options.anchorSize ?? 10
    this.rotateAnchorOffset = options.rotateAnchorOffset ?? 24
    this.padding = options.padding ?? 4
    this.borderWidth = options.borderWidth ?? 1.5
    this.anchorBorderWidth = options.anchorBorderWidth ?? 1.5
    this.enabledAnchors = options.enabledAnchors ?? RESIZE_ANCHORS
    this.rotateEnabled = options.rotateEnabled ?? true
    this.keepRatio = options.keepRatio ?? true

    const borderColor = options.borderColor ?? DEFAULT_BORDER
    const anchorFill = options.anchorFill ?? DEFAULT_ANCHOR_FILL
    const anchorStroke = options.anchorStroke ?? DEFAULT_ANCHOR_STROKE

    for (const edge of EDGES) {
      const rect = this.makePart(`__transformer-${edge}`, borderColor, TRANSFORMER_Z_INDEX)
      this.edges.set(edge, rect)
    }

    const names: TransformerAnchor[] = [...this.enabledAnchors]
    if (this.rotateEnabled) names.push('rotate')
    for (const name of names) {
      this.anchors.set(name, {
        outer: this.makePart(`__transformer-${name}-border`, anchorStroke, TRANSFORMER_Z_INDEX + 1),
        inner: this.makePart(`__transformer-${name}`, anchorFill, TRANSFORMER_Z_INDEX + 2),
      })
    }

    this.hideAll()
  }

  /** A unit quad: fill only, never stroked or resized, so it costs no geometry rebuilds. */
  private makePart(name: string, fill: RGBA, zIndex: number): Rect {
    const rect = new Rect({ name, width: 1, height: 1, fill: [...fill], strokeWidth: 0, zIndex, scaleX: 0, scaleY: 0 })
    // Handles are hit-tested geometrically by anchorAt(), never through pickNode() -
    // otherwise they would shadow the very shapes they are meant to manipulate.
    rect.pickable = false
    rect.draggable = false
    // Drawn in the always-on-top pass, so the frame never punches a depth hole through
    // the text lane the way an ordinary translucent shape would.
    rect.overlay = true
    this.parts.push(rect)
    this.addChild(rect)
    return rect
  }

  /** The nodes this frame currently wraps. */
  get selection(): readonly Shape[] {
    return this.nodes
  }

  get currentBox(): OrientedBox | null {
    return this.box
  }

  /** Points the frame at a new selection; an empty list hides it. */
  attach(nodes: readonly Shape[]): void {
    // Never wrap the frame's own parts, however the caller assembled the selection.
    this.nodes = nodes.filter((node) => !this.owns(node))
    if (this.nodes.length === 0) {
      this.box = null
      this.hideAll()
    }
  }

  detach(): void {
    this.attach([])
  }

  /** True if `node` is one of this transformer's own visuals. */
  owns(node: Shape): boolean {
    return this.parts.includes(node as Rect)
  }

  /**
   * Re-fits the frame to the current selection and re-lays its handles out. `box` is
   * recomputed by the caller (it needs a font book to measure Text), and `zoom` keeps the
   * handles a constant size on screen. Call once per frame: the selection may be moving.
   */
  update(box: OrientedBox | null, zoom: number): void {
    this.box = box
    this.zoom = zoom > 0 ? zoom : 1
    if (!box || this.nodes.length === 0) {
      this.hideAll()
      return
    }

    const framed = this.framedBox(box)
    const perPixel = 1 / this.zoom
    const thickness = this.borderWidth * perPixel
    const fullW = framed.halfW * 2
    const fullH = framed.halfH * 2

    // Four edge bars, each spanning one side of the frame. Overlapping at the corners by
    // the bar thickness is what closes them cleanly.
    this.placeEdge('top', framed, 0, framed.halfH, fullW + thickness, thickness)
    this.placeEdge('bottom', framed, 0, -framed.halfH, fullW + thickness, thickness)
    this.placeEdge('left', framed, -framed.halfW, 0, thickness, fullH + thickness)
    this.placeEdge('right', framed, framed.halfW, 0, thickness, fullH + thickness)

    const size = this.anchorSize * perPixel
    const inner = Math.max(size - 2 * this.anchorBorderWidth * perPixel, size * 0.2)
    for (const name of this.enabledAnchors) {
      const at = anchorPosition(framed, name)
      this.placeAnchor(name, at.x, at.y, framed.rotation, size, inner)
    }
    if (this.anchors.has('rotate')) {
      const at = rotateAnchorPosition(framed, this.rotateAnchorOffset * perPixel)
      this.placeAnchor('rotate', at.x, at.y, framed.rotation, size, inner)
    }
  }

  /**
   * Which handle is within grabbing distance of a world point, or null. Checked against
   * handle CENTERS with a screen-space radius, so the hit area stays finger-friendly at
   * any zoom and slightly overhangs the drawn handle. Corners are tested before edges, so
   * the overlap at a corner resolves to the corner.
   */
  anchorAt(worldX: number, worldY: number): TransformerAnchor | null {
    if (!this.box || this.nodes.length === 0) return null
    const framed = this.framedBox(this.box)
    const reach = (this.anchorSize / 2 + ANCHOR_HIT_SLOP_PX) / this.zoom

    let best: TransformerAnchor | null = null
    let bestDistance = reach
    let bestIsCorner = false

    const consider = (name: TransformerAnchor, at: { x: number; y: number }, isCorner: boolean): void => {
      const distance = Math.hypot(at.x - worldX, at.y - worldY)
      if (distance > reach) return
      // A corner wins over an edge it overlaps, even if the edge's center is nearer.
      if (best !== null && bestIsCorner && !isCorner) return
      if (best !== null && bestIsCorner === isCorner && distance >= bestDistance) return
      best = name
      bestDistance = distance
      bestIsCorner = isCorner
    }

    if (this.anchors.has('rotate')) {
      consider('rotate', rotateAnchorPosition(framed, this.rotateAnchorOffset / this.zoom), false)
    }
    for (const name of this.enabledAnchors) {
      const isCorner = name.startsWith('top-') || name.startsWith('bottom-')
      consider(name, anchorPosition(framed, name), isCorner && !name.endsWith('-center'))
    }
    return best
  }

  /** The selection box grown by the frame's padding, in world units. */
  private framedBox(box: OrientedBox): OrientedBox {
    const pad = this.padding / this.zoom
    return { ...box, halfW: box.halfW + pad, halfH: box.halfH + pad }
  }

  private placeEdge(edge: EdgeName, box: OrientedBox, localX: number, localY: number, width: number, height: number): void {
    const rect = this.edges.get(edge)
    if (!rect) return
    const c = Math.cos(box.rotation)
    const s = Math.sin(box.rotation)
    rect.x = box.cx + localX * c - localY * s
    rect.y = box.cy + localX * s + localY * c
    rect.rotation = box.rotation
    rect.scaleX = width
    rect.scaleY = height
  }

  private placeAnchor(
    name: TransformerAnchor,
    x: number,
    y: number,
    rotation: number,
    size: number,
    innerSize: number,
  ): void {
    const visual = this.anchors.get(name)
    if (!visual) return
    for (const [rect, scale] of [
      [visual.outer, size],
      [visual.inner, innerSize],
    ] as const) {
      rect.x = x
      rect.y = y
      rect.rotation = rotation
      rect.scaleX = scale
      rect.scaleY = scale
    }
  }

  /** Collapses every part to zero scale - invisible without dropping out of the mesh
   * batcher's shape set (see the class comment on why that distinction matters). */
  private hideAll(): void {
    for (const rect of this.parts) {
      rect.scaleX = 0
      rect.scaleY = 0
    }
  }
}
