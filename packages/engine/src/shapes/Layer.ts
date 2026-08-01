// Layer - a container for organising a scene, and one switch that turns everything in it
// off.
//
// Optional, and not a canvas. A layer here is not a render target and not a draw-order
// boundary: this
// engine draws the whole scene in one pass and decides what is on top from each shape's
// zIndex, scene-wide (see scene/picking.ts's collectZOrder). A layer changes none of that. A
// scene with no layers behaves exactly as it always did, and two shapes in different layers
// still order by their own zIndex rather than by which layer they are in.
//
// WHAT IT IS FOR is the pair a Group cannot give you: a name for a slice of the scene, and a
// single `enabled` that takes that whole slice out of the picture - out of the render, out of
// hit-testing, out of a marquee. Toggling one costs one check, not one per shape, because the
// walk turns back at a disabled layer rather than asking every shape about its ancestors.
//
// HOW IT DIFFERS FROM A GROUP, which is the whole reason it is not one:
//
//   - A group is a UNIT. A press on a shape inside a draggable group takes hold of the group,
//     and an application selecting `outermostGroup()` selects the group. That is what a group
//     is for, and it is exactly wrong for a layer: putting fifty shapes on a "background"
//     layer must not make them one draggable object.
//   - A layer is not one. It extends Container rather than Group, so closestGroup() and
//     outermostGroup() walk straight past it and every shape inside stays independently
//     pickable, draggable, selectable and transformable - as if the layer were not there.
//
// It still carries a transform, because every Node does and composing it costs nothing while
// it is identity. Moving a layer moves its contents, which is occasionally what you want -
// a whole layer nudged - without any of the selection semantics that would come with a group.

import { Container } from './Container'
import type { NodeOptions } from './Node'

export interface LayerOptions extends NodeOptions {
  /** See Layer.enabled. Default true. */
  enabled?: boolean
}

export class Layer extends Container {
  override readonly nodeName: string = 'Layer'
  override readonly nodeType: string = 'Layer'

  /**
   * Whether anything in this layer takes part in the scene at all.
   *
   * False removes the whole subtree from the render order and therefore from everything
   * derived from it: nothing draws, nothing can be picked, nothing is caught by a marquee,
   * and no shape inside can be selected. It is a property of the layer, not of its children -
   * every shape keeps its own `visible`, and re-enabling the layer brings back exactly the
   * shapes that were visible before.
   *
   * It does not stop events from BUBBLING through the layer, which is `listening`'s job (see
   * Node) and is left separate so the two can be set independently.
   */
  enabled = true

  constructor(options: LayerOptions = {}) {
    super(options)
    this.enabled = options.enabled ?? true
  }

  protected override attrKeys(): readonly string[] {
    return [...super.attrKeys(), 'enabled']
  }
}
