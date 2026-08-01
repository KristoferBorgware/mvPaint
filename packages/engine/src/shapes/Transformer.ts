// Transformer - the classic manipulation frame: a border around a set of nodes, eight
// resize anchors, and a rotate handle above the top edge. It is an ordinary Container of
// Rects in the scene, so it draws through the same mesh lane as everything else and needs
// no special-case rendering.
//
// The ATTACHED SET is what this frame wraps and what a gesture moves, and it belongs to
// whoever is driving the editor - attach() replaces it wholesale, add()/detach()/toggle()
// edit it one node at a time. The engine never decides what goes in it. That is worth being
// precise about: an application's idea of "the selection" may be broader than this (rows in
// a panel, a locked layer, a group whose members are edited together), so the two are
// related by the application's choice rather than by definition. Nothing here calls this
// set a selection for exactly that reason.
//
// It never parents itself to the attached nodes. It sits at the scene root and re-fits
// itself from their world bounds, which is what lets one frame wrap a set whose members
// live under different (possibly transformed) parents. The gestures themselves live in
// transformerMath.ts; this file is the scene bookkeeping around them.
//
// Every part is a UNIT quad that is only ever moved, turned and scaled - never resized by
// its width/height, and never stroked. That matters: width/height/strokeWidth are baked
// into geometry, so changing them needs a buffer rebuild that only the renderer can
// trigger, and the transformer has no handle on the renderer. Driving everything through
// the transform instead means the frame tracks a set that is being dragged, scaled
// or spun with no rebuild at all - which is also why the border is four edge quads and
// each anchor is two stacked quads (an outer one showing through as its border) rather
// than stroked rectangles.
//
// Anchors are held at a constant SCREEN size: their world size is divided by the camera
// zoom, so a handle stays comfortably clickable whether the view is zoomed way in or out.
//
// Parts stay Shape.visible = true permanently, attached or not - hiding them is done by
// scaling to zero instead (see hideAll()). Toggling visible would drop them out of
// collectZOrder's traversal (see scene/picking.ts), changing the mesh batcher's shape SET
// the instant a set is attached or cleared - and MeshBatcher.rebuild() re-tessellates and
// re-uploads EVERY shape sharing the batch when that set changes, not just the ones that
// actually differ. On a scene with thousands of other shapes, that turns "select
// attaching" into a full-scene rebuild costing orders of magnitude more than the ~20
// unit quads that actually needed it. A permanent, zero-scale slot avoids that entirely:
// the set never changes, so selecting/deselecting costs nothing beyond these few quads.

import { Container } from './Container'
import { Rect } from './Rect'
import type { TransformableNode } from './Group'
import { hasListener } from '../events/listenerCensus'
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
  /** Extra room between the attached nodes' bounds and the frame, in screen pixels. Default 4. */
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

  private attached: TransformableNode[] = []
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

  protected override attrKeys(): readonly string[] {
    return [
      ...super.attrKeys(),
      'anchorSize',
      'rotateAnchorOffset',
      'padding',
      'borderWidth',
      'anchorBorderWidth',
      'enabledAnchors',
      'rotateEnabled',
      'keepRatio',
    ]
  }

  /**
   * A unit quad: fill only, never stroked or resized, so it costs no geometry rebuilds.
   *
   * Pivoted at its middle rather than its top-left corner, which is where a Rect's origin
   * otherwise is. Every part below is positioned by its CENTRE - an edge bar spans a side
   * of the frame, a handle sits on a corner - so centring the pivot is what lets the
   * placement talk about the middle of a bar directly. The offset is in unscaled local
   * units and the quad is 1x1, so it stays correct whatever scale the part is given.
   */
  private makePart(name: string, fill: RGBA, zIndex: number): Rect {
    const rect = new Rect({ name, width: 1, height: 1, offsetX: 0.5, offsetY: -0.5, fill: [...fill], strokeWidth: 0, zIndex, scaleX: 0, scaleY: 0 })
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
  get nodes(): readonly TransformableNode[] {
    return this.attached
  }

  get currentBox(): OrientedBox | null {
    return this.box
  }

  /** Replaces the attached set; an empty list hides the frame. */
  attach(nodes: readonly TransformableNode[]): void {
    // Never wrap the frame's own parts, however the caller assembled the list.
    const next = nodes.filter((node) => !this.owns(node))
    if (sameNodes(next, this.attached)) return
    this.setAttached(next)
  }

  /** Adds one node, if it is not already attached. */
  add(node: TransformableNode): void {
    if (this.owns(node) || this.attached.includes(node)) return
    this.setAttached([...this.attached, node])
  }

  /**
   * Drops one node from the attached set, if it is in it.
   *
   * Named for its pair, attach(), and deliberately NOT `remove` - a Transformer is a Node,
   * and Node.remove() means "take me out of my parent". Two methods with one name doing
   * unrelated things to different objects is a trap on a class that inherits one of them.
   */
  detach(node: TransformableNode): void {
    const index = this.attached.indexOf(node)
    if (index < 0) return
    const next = [...this.attached]
    next.splice(index, 1)
    this.setAttached(next)
  }

  /** Adds the node if it is absent, drops it if present - a shift-click, in one call. */
  toggle(node: TransformableNode): void {
    if (this.attached.includes(node)) this.detach(node)
    else this.add(node)
  }

  has(node: TransformableNode): boolean {
    return this.attached.includes(node)
  }

  /** Empties the set and hides the frame. */
  clear(): void {
    this.attach([])
  }

  /** True if `node` is one of this transformer's own visuals. */
  owns(node: TransformableNode): boolean {
    return this.parts.includes(node as Rect)
  }

  /**
   * Commits a new set and announces it. Only ever called with a genuinely different list.
   *
   * The box goes with it, because it was fitted to the set being replaced and cannot be
   * refitted here: fitting needs to measure the nodes, and measuring a Text needs a font
   * book this shape has no access to (see update(), which the owner calls once a frame).
   *
   * Dropping it is what keeps `nodes` and `currentBox` from disagreeing. Left in place, the
   * two describe different selections until the next refit, and anything reading both at
   * once - beginning a transform does exactly that - would move the new selection about the
   * old one's centre. A null box makes that unrepresentable rather than merely unlikely:
   * anchorAt() finds no handle to grab and beginTransform() declines to start.
   *
   * Nothing on screen changes. The frame's parts keep the transforms update() last gave
   * them, so they stay where they were drawn until the next frame refits them, exactly as
   * before - this only stops them being *acted on* while the box is known to be stale.
   */
  /**
   * Lets go of nodes that have been destroyed.
   *
   * The attached set is the one place a node is held by something that is NOT its parent, so
   * it is the one place a teardown does not clean itself up: everything else the renderer
   * keeps is rebuilt from the scene each frame, but this list would hold a destroyed node
   * alive forever and go on asking to measure it. There is no event to lean on either - a
   * transformer is a SIBLING of the nodes it wraps, not an ancestor, so a bubbling 'destroy'
   * never reaches it.
   *
   * DESTROYED, and not merely removed. A removed node is explicitly still usable and may be
   * on its way back (a cut waiting for its paste, an undo), so a frame that kept wrapping it
   * is doing the right thing - clear() is there for an application that disagrees. Only
   * destroy() says the node is finished, and that is the only claim this can act on.
   */
  private dropDepartedNodes(): void {
    if (this.attached.length === 0) return
    const kept = this.attached.filter((node) => !node.isDestroyed)
    if (kept.length !== this.attached.length) this.setAttached(kept)
  }

  private setAttached(next: TransformableNode[]): void {
    this.attached = next
    this.box = null
    if (next.length === 0) this.hideAll()
    if (hasListener('attachchange')) this.fire('attachchange', { nodes: next }, true)
  }

  /**
   * Re-fits the frame to the attached nodes and re-lays its handles out. `box` is
   * recomputed by the caller (it needs a font book to measure Text), and `zoom` keeps the
   * handles a constant size on screen. Call once per frame: the nodes may be moving.
   */
  update(box: OrientedBox | null, zoom: number): void {
    this.dropDepartedNodes()
    this.box = box
    this.zoom = zoom > 0 ? zoom : 1
    if (!box || this.attached.length === 0) {
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
    if (!this.box || this.attached.length === 0) return null
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

  /** The attached nodes' box grown by the frame's padding, in world units. */
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

/** Same nodes in the same order - what decides whether attach() is a real change. */
function sameNodes(a: readonly TransformableNode[], b: readonly TransformableNode[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
