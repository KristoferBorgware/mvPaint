// Group - a Container that places itself, so the things inside it move, turn and scale as
// one. It draws nothing of its own: a group has no fill, no stroke and no geometry, and it
// occupies no slot in any render lane. What it contributes is a matrix in the middle of the
// chain, and the render lanes already compose that (child_world = parent_world *
// child_local), so a shape inside a group needs no special handling anywhere downstream.
//
// A group has NO SIZE OF ITS OWN. Its extent is whatever it currently holds, measured on
// demand - the same relationship the transformer's frame has with the nodes it wraps, and
// for the same reason: a stored width and height would be a second, independent claim about
// the same thing, and would be wrong the moment a child moved. Add a shape to a group and
// the group grows; move that shape and the group follows it; empty the group and it has no
// extent at all (an invalid AABB, not a zero-sized one - there is a difference between a
// group holding nothing and a group holding something infinitely small).
//
// Groups nest. bounds() recurses through child groups, composing each one's local matrix on
// the way down, so a group of groups measures the leaves.
//
// WHAT A GROUP GOVERNS FOR ITS SUBTREE.
//
//   visible   - false hides everything inside, not just the group. Nothing draws, and
//               nothing can be picked either, since an invisible node is not a candidate.
//   listening - inherited from Node: false makes the whole subtree inert to events.
//   draggable - a press on a shape inside a draggable group drags the GROUP (see
//               input/SceneInputDispatcher). This is what makes a group feel like one
//               object under the pointer rather than a folder its contents happen to
//               share.
//
// Note which of those is NOT here: nothing about selection. What is selected is an
// application's own idea (see Transformer's header), and an application that wants a click
// inside a group to select the group asks for the group - closestGroup() and
// outermostGroup() are here for exactly that - rather than having the engine decide it.
//
// Hit-testing is unchanged by grouping: a pick still returns the SHAPE under the pointer,
// because that is the honest answer to "what is here" and any other answer throws away
// information the caller may want. Grouping is a question the caller asks afterwards.

import { AABB } from '../math/AABB'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Container } from './Container'
import { Layer } from './Layer'
import { Node, type NodeOptions } from './Node'
import { Shape } from './Shape'

export interface GroupOptions extends NodeOptions {
  /** Hide the whole subtree. Default true (shown). */
  visible?: boolean
  /** Does a drag on a shape inside this group move the group? Default true. */
  draggable?: boolean
}

/**
 * A node's own bounds in its own local space, or null for something with nothing to
 * measure. Shapes answer this from their tessellated triangles; a Text has to be shaped
 * against a font atlas first, which is why the resolver is a parameter rather than a
 * method call - the group cannot reach a FontBook, and the caller that cares already has
 * one (see scene/picking.ts's localBoundsOf).
 */
export type LocalBoundsResolver = (node: Node) => AABB | null

/** What a group measures with when the caller has no opinion: mesh geometry only. */
export const shapeGeometryBounds: LocalBoundsResolver = (node) =>
  node instanceof Shape ? node.localBounds() : null

export class Group extends Container {
  override readonly nodeName: string = 'Group'

  /** Hides this group and everything under it. See the header. */
  visible = true

  /** Whether a drag starting on a descendant moves this group. See the header. */
  draggable = true

  constructor(options: GroupOptions = {}) {
    super(options)
    this.visible = options.visible ?? true
    this.draggable = options.draggable ?? true
  }

  protected override attrKeys(): readonly string[] {
    return [...super.attrKeys(), 'visible', 'draggable']
  }

  /**
   * The extent of everything this group holds, in the group's OWN local space - each
   * child's bounds carried up through that child's local matrix, and through any nested
   * group's on the way.
   *
   * Invalid (see AABB.valid) when the group holds nothing measurable, which is the honest
   * answer: an empty group is not a point at its origin, it is nowhere.
   *
   * Recomputed per call rather than cached. A cache would have to be invalidated by any
   * descendant moving, resizing or re-tessellating, which is a subscription to every node
   * in the subtree - and the callers that ask (a transformer re-fitting its frame, an
   * application measuring a group) already ask once per frame at most.
   */
  bounds(boundsOf: LocalBoundsResolver = shapeGeometryBounds): AABB {
    const box = new AABB()
    this.encapsulateInto(box, Matrix4x4.identity(), boundsOf)
    return box
  }

  /** The same extent in world space, for a caller working in scene coordinates. */
  worldBounds(boundsOf: LocalBoundsResolver = shapeGeometryBounds): AABB {
    const box = new AABB()
    this.encapsulateInto(box, this.worldMatrix(), boundsOf)
    return box
  }

  // One walk serving both: `into` is the matrix mapping THIS group's local space to
  // whatever space the box is being accumulated in, so the world variant differs from the
  // local one only in what it starts with.
  private encapsulateInto(box: AABB, into: Matrix4x4, boundsOf: LocalBoundsResolver): void {
    encapsulateChildren(this, box, into, boundsOf)
  }
}

/**
 * Accumulate a container's contents into `box`, recursing through the containers that merely
 * hold things - a nested Group, and a Layer, which is the same in this respect - and skipping
 * a hidden group or a disabled layer whole rather than shape by shape.
 *
 * A free function rather than a method because it has to run over a Layer as readily as a
 * Group, and a Layer is deliberately not one.
 */
function encapsulateChildren(
  container: Container,
  box: AABB,
  into: Matrix4x4,
  boundsOf: LocalBoundsResolver,
): void {
  for (const child of container.children) {
    const toBox = into.mul(child.localMatrix())
    if (child instanceof Group) {
      if (!child.visible) continue
      encapsulateChildren(child, box, toBox, boundsOf)
      continue
    }
    if (child instanceof Layer) {
      if (!child.enabled) continue
      encapsulateChildren(child, box, toBox, boundsOf)
      continue
    }
    if (child instanceof Shape && !child.visible) continue
    const local = boundsOf(child)
    if (!local || !local.valid()) continue
    box.encapsulate(local.transformed(toBox))
  }
}

/**
 * What a transformer can wrap and a gesture can move. Every Node carries a transform, so
 * what narrows this to two kinds is having an EXTENT: a frame has to fit around something,
 * and a bare Container or a Camera has nothing to measure.
 */
export type TransformableNode = Shape | Group

/** True if this node, or anything above it, is a hidden group. */
export function hiddenByGroup(node: Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p instanceof Group && !p.visible) return true
  }
  return false
}

/** The nearest Group above this node, or null if it is not in one. */
export function closestGroup(node: Node): Group | null {
  for (let p = node.parent; p; p = p.parent) {
    if (p instanceof Group) return p
  }
  return null
}

/**
 * The HIGHEST group above this node - the whole assembly rather than the innermost part of
 * it. This is what an application usually wants from a click when groups nest: clicking a
 * bolt selects the machine, not the bracket the bolt happens to sit in. Reach for
 * closestGroup() instead when a second click should step inward.
 */
export function outermostGroup(node: Node): Group | null {
  let found: Group | null = null
  for (let p = node.parent; p; p = p.parent) {
    if (p instanceof Group) found = p
  }
  return found
}

/**
 * The nearest ancestor group that a drag should move, or null if none wants to be moved.
 * Stops at the first group that has opted out: a non-draggable group means "my contents
 * are not moved by dragging inside me", and letting the search continue past it to an
 * outer group would move the very thing that said no.
 */
export function draggableGroup(node: Node): Group | null {
  let found: Group | null = null
  for (let p = node.parent; p; p = p.parent) {
    if (p instanceof Group) {
      if (!p.draggable) break
      found = p
    }
  }
  return found
}
