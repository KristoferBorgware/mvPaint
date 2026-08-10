// Layer - a container for organising a scene: a name for a slice of it, and one `visible` that
// takes that whole slice out of the picture.
//
// Optional, and not a canvas. A layer here is not a render target and not a draw-order
// boundary: this
// engine draws the whole scene in one pass and decides what is on top from each shape's
// zIndex, scene-wide (see scene/picking.ts's collectZOrder). A layer changes none of that. A
// scene with no layers behaves exactly as it always did, and two shapes in different layers
// still order by their own zIndex rather than by which layer they are in.
//
// Switching one off is `visible = false`, inherited from Node like everything else about it:
// nothing in it draws, nothing can be picked, nothing is caught by a marquee. It costs one
// check rather than one per shape, because the walk turns back at a hidden layer rather than
// asking every shape about its ancestors, and it is a property of the layer alone - every shape
// keeps its own `visible`, so showing the layer again brings back exactly the shapes that were
// visible before.
//
// HOW IT DIFFERS FROM A GROUP, which is the whole reason it is not one:
//
//   - A group is a UNIT. A press on a shape inside a draggable group takes hold of the group,
//     and an application selecting `outermostGroup()` selects the group. That is what a group
//     is for, and it is exactly wrong for a layer: putting fifty shapes on a "background"
//     layer must not make them one draggable object.
//   - A layer is not one. It extends Container rather than Group, so closestGroup(),
//     outermostGroup() and draggableGroup() walk straight past it and every shape inside stays
//     independently reachable, draggable, selectable and transformable - as if the layer were
//     not there.
//
// It still carries a transform, because every Node does and composing it costs nothing while
// it is identity. Moving a layer moves its contents, which is occasionally what you want -
// a whole layer nudged - without any of the selection semantics that would come with a group.

import { Container } from './Container'
import type { NodeOptions } from './Node'

/** A layer adds no options of its own - everything it takes is a Node's. */
export type LayerOptions = NodeOptions

export class Layer extends Container {
  override readonly nodeName: string = 'Layer'
  override readonly nodeType: string = 'Layer'
}
