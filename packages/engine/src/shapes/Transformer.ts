// Transformer - the classic selection frame: a border around the current selection, eight
// resize anchors, and a rotate handle above the top edge. Adapted from Konva's Transformer
// to this engine: it is an ordinary Container of Rects in the scene, so it draws through
// the same mesh lane as everything else and needs no special-case rendering.
//
// It never parents itself to the selected nodes. It sits at the scene root and re-fits
// itself from their world bounds, which is what lets one frame wrap a multi-node selection
// whose members live under different (possibly transformed) parents. The gestures
// themselves live in transformerMath.ts; this file is the scene bookkeeping around them.
//
// Anchors are held at a constant SCREEN size: their world size is divided by the camera
// zoom, so a handle stays comfortably clickable whether the view is zoomed way in or out.

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
const BORDER_STROKE_PX = 1.5
const ANCHOR_STROKE_PX = 1.5
/** Anchors are picked within this many screen px of their center - forgiving on touch. */
const ANCHOR_HIT_SLOP_PX = 6

/** Sits above ordinary content so the frame and its handles are never buried. */
const TRANSFORMER_Z_INDEX = 1_000_000

export class Transformer extends Container {
  readonly anchorSize: number
  readonly rotateAnchorOffset: number
  readonly padding: number
  readonly enabledAnchors: readonly ResizeAnchor[]
  readonly rotateEnabled: boolean
  keepRatio: boolean

  private nodes: Shape[] = []
  private box: OrientedBox | null = null
  private zoom = 1

  private readonly border: Rect
  private readonly anchors = new Map<TransformerAnchor, Rect>()

  constructor(options: TransformerOptions = {}) {
    super('__transformer')
    this.anchorSize = options.anchorSize ?? 10
    this.rotateAnchorOffset = options.rotateAnchorOffset ?? 24
    this.padding = options.padding ?? 4
    this.enabledAnchors = options.enabledAnchors ?? RESIZE_ANCHORS
    this.rotateEnabled = options.rotateEnabled ?? true
    this.keepRatio = options.keepRatio ?? true

    const borderColor = options.borderColor ?? DEFAULT_BORDER
    const anchorFill = options.anchorFill ?? DEFAULT_ANCHOR_FILL
    const anchorStroke = options.anchorStroke ?? DEFAULT_ANCHOR_STROKE

    // One unfilled rect for the frame. Its size tracks the selection, so it is the one
    // piece here that re-tessellates during a drag (width/height are baked geometry,
    // unlike a transform) - acceptable for an overlay that only changes while a gesture
    // is actually in flight.
    this.border = new Rect({
      name: '__transformer-border',
      fill: [0, 0, 0, 0],
      stroke: [...borderColor],
      strokeWidth: BORDER_STROKE_PX,
      zIndex: TRANSFORMER_Z_INDEX,
    })
    this.border.pickable = false
    this.border.draggable = false
    this.addChild(this.border)

    const names: TransformerAnchor[] = [...this.enabledAnchors]
    if (this.rotateEnabled) names.push('rotate')
    for (const name of names) {
      const anchor = new Rect({
        name: `__transformer-${name}`,
        width: 1,
        height: 1,
        fill: [...anchorFill],
        stroke: [...anchorStroke],
        strokeWidth: ANCHOR_STROKE_PX,
        zIndex: TRANSFORMER_Z_INDEX + 1,
      })
      // Handles are hit-tested geometrically by anchorAt(), never through pickNode() -
      // otherwise they would shadow the very shapes they are meant to manipulate.
      anchor.pickable = false
      anchor.draggable = false
      anchor.visible = false
      this.anchors.set(name, anchor)
      this.addChild(anchor)
    }

    this.setVisible(false)
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
      this.setVisible(false)
    }
  }

  detach(): void {
    this.attach([])
  }

  /** True if `node` is one of this transformer's own visuals. */
  owns(node: Shape): boolean {
    if (node === this.border) return true
    for (const anchor of this.anchors.values()) {
      if (node === anchor) return true
    }
    return false
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
      this.setVisible(false)
      return
    }

    // World units per screen pixel: 1 at zoom 1, so handles shrink in world terms as the
    // camera zooms in and stay the same size to the eye.
    const perPixel = 1 / this.zoom
    const pad = this.padding * perPixel
    const framed: OrientedBox = { ...box, halfW: box.halfW + pad, halfH: box.halfH + pad }

    this.border.visible = true
    this.border.x = framed.cx
    this.border.y = framed.cy
    this.border.rotation = framed.rotation
    this.border.strokeWidth = BORDER_STROKE_PX * perPixel
    this.setBorderSize(framed.halfW * 2, framed.halfH * 2)

    const size = this.anchorSize * perPixel
    for (const name of this.enabledAnchors) {
      const anchor = this.anchors.get(name)
      if (!anchor) continue
      const at = anchorPosition(framed, name)
      this.placeAnchor(anchor, at.x, at.y, framed.rotation, size)
    }

    const rotateAnchor = this.anchors.get('rotate')
    if (rotateAnchor) {
      const at = rotateAnchorPosition(framed, this.rotateAnchorOffset * perPixel)
      this.placeAnchor(rotateAnchor, at.x, at.y, framed.rotation, size)
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
    const perPixel = 1 / this.zoom
    const reach = (this.anchorSize / 2 + ANCHOR_HIT_SLOP_PX) * perPixel
    const pad = this.padding * perPixel
    const framed: OrientedBox = { ...this.box, halfW: this.box.halfW + pad, halfH: this.box.halfH + pad }

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

    if (this.rotateEnabled && this.anchors.has('rotate')) {
      consider('rotate', rotateAnchorPosition(framed, this.rotateAnchorOffset * perPixel), false)
    }
    for (const name of this.enabledAnchors) {
      const isCorner = name.includes('-') && !name.includes('center') && !name.includes('middle')
      consider(name, anchorPosition(framed, name), isCorner)
    }
    return best
  }

  private placeAnchor(anchor: Rect, x: number, y: number, rotation: number, size: number): void {
    anchor.visible = true
    anchor.x = x
    anchor.y = y
    anchor.rotation = rotation
    // The handle is a 1x1 rect scaled to size, so re-sizing it on zoom stays a pure
    // transform change and never re-tessellates.
    anchor.scaleX = size
    anchor.scaleY = size
    anchor.strokeWidth = ANCHOR_STROKE_PX / size / this.zoom
  }

  private setBorderSize(width: number, height: number): void {
    if (this.border.width === width && this.border.height === height) return
    this.border.width = width
    this.border.height = height
    this.border.markGeometryDirty()
  }

  private setVisible(visible: boolean): void {
    this.border.visible = visible
    for (const anchor of this.anchors.values()) anchor.visible = visible
  }
}
