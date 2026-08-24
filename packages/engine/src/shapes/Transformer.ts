// Transformer - the classic manipulation frame: a border around a set of nodes, eight
// resize anchors, and a rotate handle above the top edge. It is an ordinary Container of
// Rects in the scene, so it draws through the same mesh lane as everything else and needs
// no special-case rendering.
//
// The ATTACHED SET is what this frame wraps and what a gesture moves, and it belongs to
// whoever is driving the editor - attach() replaces it wholesale, addNode()/detach()/toggle()
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
// Every part is a UNIT shape - a 1x1 quad for the border bars, a radius-0.5 circle for the
// handles - that is only ever moved, turned and scaled, never resized by its width/height
// and never stroked. That matters: width/height/radius/strokeWidth are baked into geometry,
// so changing them needs a buffer rebuild that only the renderer can trigger, and the
// transformer has no handle on the renderer. Driving everything through the transform
// instead means the frame tracks a set that is being dragged, scaled or spun with no
// rebuild at all - which is also why the border is four edge quads and each anchor is two
// stacked circles (an outer one showing through as its ring) rather than stroked shapes.
//
// Anchors are held at a constant SCREEN size: their world size is divided by the camera
// zoom, so a handle stays comfortably clickable whether the view is zoomed way in or out.
//
// Parts stay visible = true permanently, attached or not - hiding them is done by
// scaling to zero instead (see hideAll()). Toggling visible would drop them out of
// collectZOrder's traversal (see scene/picking.ts), changing the mesh batcher's shape SET
// the instant a set is attached or cleared - and MeshBatcher.rebuild() re-tessellates and
// re-uploads EVERY shape sharing the batch when that set changes, not just the ones that
// actually differ. On a scene with thousands of other shapes, that turns "select
// attaching" into a full-scene rebuild costing orders of magnitude more than the ~20
// unit quads that actually needed it. A permanent, zero-scale slot avoids that entirely:
// the set never changes, so selecting/deselecting costs nothing beyond these few quads.

import type { Vector2Like } from '../math/Vector2'
import { Matrix4x4 } from '../math/Matrix4x4'
import { degToRad, radToDeg } from '../math/angle'
import { Container } from './Container'
import { Circle } from './Circle'
import { Rect } from './Rect'
import type { Shape } from './Shape'
import type { Node } from './Node'
import type { TransformableNode } from './Group'
import { hasListener } from '../events/listenerCensus'
import type { RGBA } from '../render/meshFormat'
import { MV_GREEN, parseColor, type ColorInput } from '../render/color'
import {
  RESIZE_ANCHORS,
  anchorPosition,
  rotateAnchorPosition,
  worldRotationOf,
  type AnchorDragBoundFunc,
  type BoundBoxFunc,
  type OrientedBox,
  type ResizeAnchor,
  type TransformerAnchor,
} from './transformerMath'

/**
 * What a Transformer needs from whatever is driving its handles, so that stopTransform() can
 * reach a gesture the frame does not itself run. SceneInputDispatcher satisfies it and hands
 * itself over in its own constructor.
 *
 * Declared here rather than in the input layer so the dependency points one way: the frame
 * knows this shape, and nothing in shapes/ imports the dispatcher.
 */
export interface TransformerGestureHost {
  stopTransform(): void
}

export interface TransformerOptions {
  /**
   * Anchor diameter in SCREEN pixels, held constant across zoom. Default 10.
   *
   * Screen pixels rather than the frame's own units, so a handle stays the same size to grab
   * however far the view is zoomed.
   */
  anchorSize?: number
  /** How far past the top edge the rotate handle sits, in screen pixels. Default 24. */
  rotateAnchorOffset?: number
  /** Extra room between the attached nodes' bounds and the frame, in screen pixels. Default 4. */
  padding?: number
  /** Border thickness in screen pixels. Default 1.5. */
  borderWidth?: number
  /** Anchor ring thickness in screen pixels. Default 1.5. */
  anchorBorderWidth?: number
  /** Which resize anchors to show. Default: all eight. */
  enabledAnchors?: readonly ResizeAnchor[]
  /** Show the resize anchors at all. Default true. False leaves the border and the rotate handle. */
  resizeEnabled?: boolean
  /** Show the rotate handle. Default true. */
  rotateEnabled?: boolean
  /**
   * Lock the aspect ratio when dragging a CORNER anchor. Default true - the classic
   * behaviour, and what the request calls uniform corner scaling. Set false to let corners
   * scale each axis freely. Shift forces the lock on whichever way this is set.
   */
  keepRatio?: boolean
  /** Let a resize dragged past its fixed point mirror the nodes. Default true. */
  flipEnabled?: boolean
  /** Scale about the box center rather than the opposite anchor. Default false; alt does it too. */
  centeredScaling?: boolean
  /**
   * Orient a frame around SEVERAL nodes to the FIRST one's angle, so the set resizes and turns
   * rigidly about whichever member came first. Default true.
   *
   * A frame around ONE node always takes that node's angle, whatever this says - a lone shape
   * gets a box that hugs it. This decides only what happens with several, where there is no one
   * angle to take: the first member lends its own, or, set false, the frame holds an upright
   * angle of its own that rotate drags carry forward (see `rotation`).
   *
   * The two differ in what a tilted member does to the frame. Taking the first node's angle
   * hugs a set that shares one, at the price of the frame changing shape when the set is
   * reordered. Upright, a set is framed along the world axes however its members are turned,
   * and reordering it changes nothing.
   */
  useFirstNodeRotation?: boolean
  /** Angles (DEGREES) a rotate drag settles onto when within `rotationSnapTolerance`. */
  rotationSnaps?: readonly number[]
  /** How close (DEGREES) a rotation must come to a snap to take it. Default 7. */
  rotationSnapTolerance?: number
  /** Constrains the box a resize or rotation lands on - see BoundBoxFunc. */
  boundBoxFunc?: BoundBoxFunc
  /** Constrains where a handle drag is read from, in world space - see AnchorDragBoundFunc. */
  anchorDragBoundFunc?: AnchorDragBoundFunc
  /** The four border bars. Default the mv green. Live - see the accessor. */
  borderColor?: ColorInput
  /** The inside of each handle. Default the mv green. Live - see the accessor. */
  anchorFill?: ColorInput
  /**
   * The ring around each handle. Default white. Named for what it looks like rather than
   * how it is drawn - it is the outer disc showing past the inner one, not a real stroke
   * (see makeAnchor on why a stroke could not follow the zoom). Live - see the accessor.
   */
  anchorStroke?: ColorInput
}

const WHITE: RGBA = [1, 1, 1, 1]
const DEFAULT_BORDER: RGBA = MV_GREEN
const DEFAULT_ANCHOR_FILL: RGBA = MV_GREEN
/** Handles are green discs ringed in white, so they read against dark and light content alike. */
const DEFAULT_ANCHOR_STROKE: RGBA = WHITE
/** Enough sides that a handle reads as round at the size it is drawn (~10 screen px). */
const ANCHOR_SEGMENTS = 24
/** Anchors are picked within this many screen px of their center - forgiving on touch. */
const ANCHOR_HIT_SLOP_PX = 6
/** Sits above ordinary content; the overlay pass keeps it above the text lane too. */
const TRANSFORMER_Z_INDEX = 1_000_000
/** Shared by every frame - see localMatrix, which hands the same one back to every caller. */
const IDENTITY = Matrix4x4.identity()

type EdgeName = 'top' | 'bottom' | 'left' | 'right'
const EDGES: readonly EdgeName[] = ['top', 'bottom', 'left', 'right']

interface AnchorVisual {
  outer: Circle
  inner: Circle
}

export class Transformer extends Container {
  override readonly nodeName: string = 'Transformer'

  anchorSize: number
  rotateAnchorOffset: number
  padding: number
  borderWidth: number
  anchorBorderWidth: number
  resizeEnabled: boolean
  rotateEnabled: boolean
  keepRatio: boolean
  flipEnabled: boolean
  centeredScaling: boolean
  useFirstNodeRotation: boolean
  /** Degrees - converted where the rotate gesture reads them. See math/angle.ts. */
  rotationSnaps?: readonly number[]
  /** Degrees. */
  rotationSnapTolerance: number
  boundBoxFunc?: BoundBoxFunc
  anchorDragBoundFunc?: AnchorDragBoundFunc

  private enabled: readonly ResizeAnchor[]
  /**
   * The frame's own angle, in RADIANS, which is what `rotation` reads and writes in degrees.
   *
   * Held here rather than taken from the attached nodes because a set of them has no one
   * angle to take. It starts upright each time the set changes and is carried forward by
   * rotate drags, so a frame around several nodes turns with them and stays turned.
   */
  private frameRotation = 0
  // The frame's paint, held here as well as in the parts that draw with it: a part's `fill` is a
  // copy of what it was given (see makeEdge), and a handle's two discs carry two of the three.
  private borderColorValue: RGBA
  private anchorFillValue: RGBA
  private anchorStrokeValue: RGBA
  private activeAnchor: TransformerAnchor | null = null
  private gestureHost: TransformerGestureHost | null = null

  private attached: TransformableNode[] = []
  // Each attached node's tree top, as it was when the node was attached. Compared against the
  // live one to notice a node that has since left the scene - see dropDepartedNodes.
  private attachedRoots: Node[] = []
  private box: OrientedBox | null = null
  private zoom = 1

  private readonly edges = new Map<EdgeName, Rect>()
  private readonly anchors = new Map<TransformerAnchor, AnchorVisual>()
  private readonly parts: Shape[] = []

  constructor(options: TransformerOptions = {}) {
    super('__transformer')
    this.anchorSize = options.anchorSize ?? 10
    this.rotateAnchorOffset = options.rotateAnchorOffset ?? 24
    this.padding = options.padding ?? 4
    this.borderWidth = options.borderWidth ?? 1.5
    this.anchorBorderWidth = options.anchorBorderWidth ?? 1.5
    this.enabled = options.enabledAnchors ?? RESIZE_ANCHORS
    this.resizeEnabled = options.resizeEnabled ?? true
    this.rotateEnabled = options.rotateEnabled ?? true
    this.keepRatio = options.keepRatio ?? true
    this.flipEnabled = options.flipEnabled ?? true
    this.centeredScaling = options.centeredScaling ?? false
    this.useFirstNodeRotation = options.useFirstNodeRotation ?? true
    this.rotationSnaps = options.rotationSnaps
    this.rotationSnapTolerance = options.rotationSnapTolerance ?? 7
    this.boundBoxFunc = options.boundBoxFunc
    this.anchorDragBoundFunc = options.anchorDragBoundFunc

    this.borderColorValue =
      options.borderColor === undefined ? DEFAULT_BORDER : parseColor(options.borderColor)
    this.anchorFillValue =
      options.anchorFill === undefined ? DEFAULT_ANCHOR_FILL : parseColor(options.anchorFill)
    this.anchorStrokeValue =
      options.anchorStroke === undefined ? DEFAULT_ANCHOR_STROKE : parseColor(options.anchorStroke)

    for (const edge of EDGES) {
      const rect = this.makeEdge(`__transformer-${edge}`, this.borderColorValue)
      this.edges.set(edge, rect)
    }

    // Every handle the frame can ever show gets its pair of discs here, whatever is enabled
    // right now, so that enabling one later is a matter of giving it a size again rather than
    // adding a shape. Adding one would change the mesh batcher's shape set and re-tessellate
    // the whole batch (see the class comment); this way switching a handle on is as cheap as
    // the frame appearing in the first place.
    for (const name of [...RESIZE_ANCHORS, 'rotate' as const]) {
      this.anchors.set(name, {
        outer: this.makeAnchor(`__transformer-${name}-border`, this.anchorStrokeValue, TRANSFORMER_Z_INDEX + 1),
        inner: this.makeAnchor(`__transformer-${name}`, this.anchorFillValue, TRANSFORMER_Z_INDEX + 2),
      })
    }

    this.hideAll()
  }

  /**
   * Which resize handles the frame shows and hit-tests. Live: assigning re-lays the frame out
   * on the next update(), and the handles dropped stop being grabbable at the same moment
   * they stop being drawn.
   */
  get enabledAnchors(): readonly ResizeAnchor[] {
    return this.enabled
  }
  set enabledAnchors(value: readonly ResizeAnchor[]) {
    this.enabled = value
  }

  // --- the frame's paint ---------------------------------------------------------------------
  //
  // Live, so a themed application restyles the frame when the theme changes rather than building
  // a second one. Each write reaches the parts that draw with it and shows on the next frame: the
  // colour is a fill on a unit quad or disc, and a fill needs no geometry rebuild.
  //
  // Each takes any form a colour can be written in and reads back as the parsed RGBA. A write is
  // compared on the form it ARRIVES in, the rule Shape.fill follows, so a freshly built tuple is
  // a new value even when its four numbers match the last one's.

  /** The four border bars. */
  get borderColor(): RGBA {
    return this.borderColorValue
  }
  set borderColor(value: ColorInput) {
    if (value === this.borderColorWritten) return
    const previous = this.borderColorValue
    this.borderColorValue = parseColor(value)
    this.borderColorWritten = value
    for (const edge of this.edges.values()) edge.fill = [...this.borderColorValue]
    this.announce('borderColor', previous, this.borderColorValue)
  }
  private borderColorWritten: ColorInput | null = null

  /** The inside of each handle. */
  get anchorFill(): RGBA {
    return this.anchorFillValue
  }
  set anchorFill(value: ColorInput) {
    if (value === this.anchorFillWritten) return
    const previous = this.anchorFillValue
    this.anchorFillValue = parseColor(value)
    this.anchorFillWritten = value
    for (const anchor of this.anchors.values()) anchor.inner.fill = [...this.anchorFillValue]
    this.announce('anchorFill', previous, this.anchorFillValue)
  }
  private anchorFillWritten: ColorInput | null = null

  /** The ring around each handle - the outer disc showing past the inner one. */
  get anchorStroke(): RGBA {
    return this.anchorStrokeValue
  }
  set anchorStroke(value: ColorInput) {
    if (value === this.anchorStrokeWritten) return
    const previous = this.anchorStrokeValue
    this.anchorStrokeValue = parseColor(value)
    this.anchorStrokeWritten = value
    for (const anchor of this.anchors.values()) anchor.outer.fill = [...this.anchorStrokeValue]
    this.announce('anchorStroke', previous, this.anchorStrokeValue)
  }
  private anchorStrokeWritten: ColorInput | null = null

  /** The resize handles that are both enabled and switched on, plus the rotate handle. */
  private shownAnchors(): readonly TransformerAnchor[] {
    const names: TransformerAnchor[] = this.resizeEnabled ? [...this.enabled] : []
    if (this.rotateEnabled) names.push('rotate')
    return names
  }

  /**
   * The frame's angle in DEGREES, the same unit every other node's rotation carries.
   *
   * Where a frame is hugging a node's angle - one node always, several when useFirstNodeRotation
   * is on - this reports that node's world angle. Otherwise it is the frame's own, which a
   * rotate drag carries forward and a change of attached set puts back upright.
   *
   * Writing it turns the frame without touching what it wraps, so the two disagree until the
   * next rotate drag re-fits them. The angle is the frame's own, not a proxy for the nodes'.
   */
  override get rotation(): number {
    return radToDeg(this.fitRotation())
  }
  override set rotation(value: number) {
    this.frameRotation = degToRad(value)
  }

  /**
   * The frame the box is fitted in, in radians - what update()'s caller measures the attached
   * nodes along. See boxForNodes, which takes it as its third argument.
   */
  fitRotation(): number {
    if (this.attached.length === 0) return this.frameRotation
    // One node is always hugged; the flag speaks only for a set, which has no one angle of its own.
    if (this.attached.length === 1 || this.useFirstNodeRotation) return worldRotationOf(this.attached[0])
    return this.frameRotation
  }

  /**
   * Identity, always. The frame's parts are placed in WORLD coordinates (see placeEdge), so
   * anything this contributed would be applied to them a second time - a rotation written here
   * would swing the whole frame about the scene origin, away from the nodes it is drawn around,
   * and the handles anchorAt() finds would no longer be the ones on screen.
   *
   * So the transform fields this inherits from Node are inert rather than dangerous, and
   * `rotation` is free to mean the frame's own angle instead (see above).
   */
  override localMatrix(): Matrix4x4 {
    return IDENTITY
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
      'resizeEnabled',
      'rotateEnabled',
      'keepRatio',
      'flipEnabled',
      'centeredScaling',
      'useFirstNodeRotation',
      'rotationSnaps',
      'rotationSnapTolerance',
      'borderColor',
      'anchorFill',
      'anchorStroke',
    ]
  }

  /**
   * See Node.attrDefaults. Built on the first call and kept, so the spread of the base class's
   * own table happens long after every module has finished evaluating.
   *
   * `boundBoxFunc` and `anchorDragBoundFunc` are absent, as they are from attrKeys(): a
   * constraint is a function, which no document holds and no reset has a stand-in for.
   */
  protected override attrDefaults(): Readonly<Record<string, unknown>> {
    return (Transformer.attrDefaultsTable ??= Object.freeze({
      ...super.attrDefaults(),
      anchorSize: 10,
      rotateAnchorOffset: 24,
      padding: 4,
      borderWidth: 1.5,
      anchorBorderWidth: 1.5,
      enabledAnchors: RESIZE_ANCHORS,
      resizeEnabled: true,
      rotateEnabled: true,
      keepRatio: true,
      flipEnabled: true,
      centeredScaling: false,
      useFirstNodeRotation: true,
      rotationSnaps: undefined,
      rotationSnapTolerance: 7,
      borderColor: DEFAULT_BORDER,
      anchorFill: DEFAULT_ANCHOR_FILL,
      anchorStroke: DEFAULT_ANCHOR_STROKE,
    }))
  }

  private static attrDefaultsTable: Readonly<Record<string, unknown>> | undefined

  /**
   * One border bar: a unit quad, fill only, never stroked or resized, so it costs no
   * geometry rebuilds.
   *
   * Pivoted at its middle rather than its top-left corner, which is where a Rect's origin
   * otherwise is. Every part below is positioned by its CENTRE - an edge bar spans a side
   * of the frame, a handle sits on a corner - so centring the pivot is what lets the
   * placement talk about the middle of a bar directly. The offset is in unscaled local
   * units and the quad is 1x1, so it stays correct whatever scale the part is given.
   */
  private makeEdge(name: string, fill: RGBA): Rect {
    return this.adopt(
      new Rect({ name, width: 1, height: 1, offsetX: 0.5, offsetY: 0.5, fill: [...fill], strokeWidth: 0, zIndex: TRANSFORMER_Z_INDEX, scaleX: 0, scaleY: 0 }),
    )
  }

  /**
   * One disc of a handle: a unit circle, radius 0.5, so scaling it by a size gives a circle
   * of exactly that DIAMETER - the same arithmetic the square handles used, and what lets
   * the ring thickness stay a plain subtraction in update().
   *
   * A Circle is centred on its own origin already, so unlike a Rect it needs no offset to
   * be placed by its middle. Fill only for the same reason as the bars: the white ring is
   * the outer disc showing past the inner one, not a stroke, since strokeWidth is baked
   * into geometry and could not follow the zoom without a rebuild. The segment count is
   * fixed rather than left to Circle's world-radius adaptivity, which would see radius 0.5
   * and tessellate for a dot even though the handle is drawn ten pixels across.
   */
  private makeAnchor(name: string, fill: RGBA, zIndex: number): Circle {
    return this.adopt(
      new Circle({ name, radius: 0.5, segments: ANCHOR_SEGMENTS, fill: [...fill], strokeWidth: 0, zIndex, scaleX: 0, scaleY: 0 }),
    )
  }

  /** The handling every part shares: never picked, always drawn on top, owned by the frame. */
  private adopt<T extends Shape>(shape: T): T {
    // Handles are hit-tested geometrically by anchorAt(), never through pickNode() -
    // otherwise they would shadow the very shapes they are meant to manipulate.
    shape.listening = false
    shape.draggable = false
    // Drawn in the always-on-top pass, so the frame never punches a depth hole through
    // the text lane the way an ordinary translucent shape would.
    shape.overlay = true
    this.parts.push(shape)
    this.addChild(shape)
    return shape
  }

  /**
   * The nodes this frame currently wraps. Assigning replaces the set, exactly as attach() does.
   */
  get nodes(): readonly TransformableNode[] {
    return this.attached
  }
  set nodes(value: readonly TransformableNode[]) {
    this.attach(value)
  }

  get currentBox(): OrientedBox | null {
    return this.box
  }

  /**
   * Which handle a gesture currently holds, or null between gestures. Set by whatever is
   * driving the handles; see bindGestureHost.
   */
  getActiveAnchor(): TransformerAnchor | null {
    return this.activeAnchor
  }

  isTransforming(): boolean {
    return this.activeAnchor !== null
  }

  /**
   * Ends a handle gesture where it stands, keeping what it has done so far. The nodes are left
   * as they are and a 'transformend' goes out, the same as releasing the handle would.
   */
  stopTransform(): void {
    this.gestureHost?.stopTransform()
  }

  /** Wires the frame to whatever runs its handle gestures. Null unwires it. */
  bindGestureHost(host: TransformerGestureHost | null): void {
    this.gestureHost = host
  }

  /** Told by the gesture host which handle is held, so the frame can report it. */
  setActiveAnchor(anchor: TransformerAnchor | null): void {
    this.activeAnchor = anchor
  }

  /** Replaces the attached set; an empty list hides the frame. */
  attach(nodes: readonly TransformableNode[]): void {
    // Never wrap the frame's own parts, however the caller assembled the list.
    const next = nodes.filter((node) => !this.owns(node))
    if (sameNodes(next, this.attached)) return
    this.setAttached(next)
  }

  /**
   * Attaches one more node, if it is not already attached.
   *
   * Named for `nodes`, the set it appends to, and deliberately NOT `add` - a Transformer is a
   * Container, and Container.add() means "put these inside me". A frame's attached nodes are
   * not its children; they are what it wraps, and they stay where they are in the scene.
   */
  addNode(node: TransformableNode): void {
    if (this.owns(node) || this.attached.includes(node)) return
    this.setAttached([...this.attached, node])
  }

  /**
   * Drops one node from the attached set, if it is in it. Called with nothing, empties the
   * set - the same as clear().
   *
   * Named for its pair, attach(), and deliberately NOT `remove` - a Transformer is a Node,
   * and Node.remove() means "take me out of my parent". Two methods with one name doing
   * unrelated things to different objects is a trap on a class that inherits one of them.
   */
  detach(node?: TransformableNode): void {
    if (node === undefined) {
      this.attach([])
      return
    }
    const index = this.attached.indexOf(node)
    if (index < 0) return
    const next = [...this.attached]
    next.splice(index, 1)
    this.setAttached(next)
  }

  /** Adds the node if it is absent, drops it if present - a shift-click, in one call. */
  toggle(node: TransformableNode): void {
    if (this.attached.includes(node)) this.detach(node)
    else this.addNode(node)
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
    return this.parts.includes(node as Shape)
  }

  /**
   * Commits a new set and announces it. Only ever called with a genuinely different list.
   *
   * The box goes with it, because it was fitted to the set being replaced and cannot be
   * refitted here: fitting needs to measure the nodes, and measuring an MSDFText needs a font
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
   * Lets go of nodes that have left the scene - destroyed, or merely removed.
   *
   * The attached set is the one place a node is held by something that is NOT its parent, so
   * it is the one place a removal does not clean itself up: everything else the renderer keeps
   * is rebuilt from the scene each frame, but this list would hold a node forever. There is no
   * event to lean on either - a transformer is a SIBLING of the nodes it wraps, not an
   * ancestor, so a bubbling 'remove' never reaches it.
   *
   * A REMOVED node counts, not only a destroyed one, and the reason is worth stating because
   * remove() otherwise promises the node is still perfectly usable. A detached node's
   * worldMatrix() has no parent chain left to compose, so it collapses to its LOCAL matrix - a
   * shape sitting at (10, 0) inside a group at (500, 300) reports (10, 0) the instant it is
   * removed. A frame that kept hold of it would not merely outline something invisible, it
   * would jump 500 units to outline where the node is not. Losing the selection is the milder
   * failure, and the honest one: what the frame wrapped is no longer in the scene.
   *
   * "Left" is measured against the tree top recorded when the node was attached, rather than
   * against a bare parent check, so that attaching a node that is not in a scene yet (built,
   * selected, then added) is not mistaken for one that has just been taken out of it. A node
   * moved to a different parent within the same tree stays attached, which is right - moveTo()
   * changes where a node is, not whether it is there.
   */
  private dropDepartedNodes(): void {
    if (this.attached.length === 0) return
    const kept = this.attached.filter((node, i) => {
      if (node.isDestroyed) return false
      const wasInATree = this.attachedRoots[i] !== node
      return !(wasInATree && node.root() === node)
    })
    if (kept.length !== this.attached.length) this.setAttached(kept)
  }

  private setAttached(next: TransformableNode[]): void {
    this.attached = next
    this.attachedRoots = next.map((node) => node.root())
    this.box = null
    // Upright again for the new set. A frame's own angle belongs to the set it was turned
    // around, so carrying it onto a different one would frame the new nodes at an angle
    // nothing asked for. A single node re-adopts its own angle immediately anyway - see
    // fitRotation.
    this.frameRotation = 0
    if (next.length === 0) this.hideAll()
    if (hasListener('attachchange')) this.fire('attachchange', { nodes: next }, true)
  }

  /**
   * Re-fits the frame to the attached nodes and re-lays its handles out. `box` is
   * recomputed by the caller (it needs a font book to measure MSDFText), and `zoom` keeps the
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
    // What the box was actually fitted at, so `rotation` reports the frame on screen rather
    // than the angle it was asked for - the two differ the moment a rotate drag is snapped.
    this.frameRotation = box.rotation

    const framed = this.framedBox(box)
    const perPixel = 1 / this.zoom
    const thickness = this.borderWidth * perPixel
    const fullW = framed.halfW * 2
    const fullH = framed.halfH * 2

    // Four edge bars, each spanning one side of the frame. Overlapping at the corners by
    // the bar thickness is what closes them cleanly.
    this.placeEdge('top', framed, 0, -framed.halfH, fullW + thickness, thickness)
    this.placeEdge('bottom', framed, 0, framed.halfH, fullW + thickness, thickness)
    this.placeEdge('left', framed, -framed.halfW, 0, thickness, fullH + thickness)
    this.placeEdge('right', framed, framed.halfW, 0, thickness, fullH + thickness)

    // Handle diameters: the outer disc at the full size, the inner one pulled in by the ring
    // thickness on each side. The floor keeps a sliver of green showing when a thick ring is
    // asked for on a small handle, rather than letting the inner disc invert.
    const size = this.anchorSize * perPixel
    const inner = Math.max(size - 2 * this.anchorBorderWidth * perPixel, size * 0.2)
    const shown = this.shownAnchors()
    for (const name of shown) {
      const at =
        name === 'rotate'
          ? rotateAnchorPosition(framed, this.rotateAnchorOffset * perPixel)
          : anchorPosition(framed, name)
      this.placeAnchor(name, at.x, at.y, size, inner)
    }

    // The handles this frame is not showing collapse instead, which is how a name taken out of
    // enabledAnchors stops being drawn. Zeroing one that is already zero writes nothing at all
    // (see Node's transform setters), so a frame whose set of handles never changes runs this
    // loop without touching anything.
    for (const [name, visual] of this.anchors) {
      if (shown.includes(name)) continue
      visual.outer.scaleX = 0
      visual.outer.scaleY = 0
      visual.inner.scaleX = 0
      visual.inner.scaleY = 0
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

    const consider = (name: TransformerAnchor, at: Vector2Like, isCorner: boolean): void => {
      const distance = Math.hypot(at.x - worldX, at.y - worldY)
      if (distance > reach) return
      // A corner wins over an edge it overlaps, even if the edge's center is nearer.
      if (best !== null && bestIsCorner && !isCorner) return
      if (best !== null && bestIsCorner === isCorner && distance >= bestDistance) return
      best = name
      bestDistance = distance
      bestIsCorner = isCorner
    }

    // The same list update() draws, so what can be grabbed is exactly what is on screen.
    for (const name of this.shownAnchors()) {
      if (name === 'rotate') {
        consider('rotate', rotateAnchorPosition(framed, this.rotateAnchorOffset / this.zoom), false)
        continue
      }
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
    // The box carries radians, a node's rotation is degrees - see math/angle.ts.
    rect.rotation = radToDeg(box.rotation)
    rect.scaleX = width
    rect.scaleY = height
  }

  /**
   * Both discs of one handle, concentric at a world point. The box's rotation is not passed
   * in and not applied: a uniformly scaled circle looks the same at every angle, so turning
   * it with the frame would be work with nothing to show for it. The POSITIONS still follow
   * the rotation - anchorPosition() turns them - which is the part that is visible.
   */
  private placeAnchor(name: TransformerAnchor, x: number, y: number, size: number, innerSize: number): void {
    const visual = this.anchors.get(name)
    if (!visual) return
    for (const [circle, scale] of [
      [visual.outer, size],
      [visual.inner, innerSize],
    ] as const) {
      circle.x = x
      circle.y = y
      circle.scaleX = scale
      circle.scaleY = scale
    }
  }

  /** Collapses every part to zero scale - invisible without dropping out of the mesh
   * batcher's shape set (see the class comment on why that distinction matters). */
  private hideAll(): void {
    for (const part of this.parts) {
      part.scaleX = 0
      part.scaleY = 0
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
