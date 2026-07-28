// Container - a Node that holds children. Concrete containers (a scene
// root / group) can be instantiated directly; Shape and Camera are leaf Nodes. Adds the
// child list and the eachChild() override that powers Node's traversal and search.
//
// Membership changes raise 'add' and 'remove' on the container, carrying the child and
// bubbling, so an ancestor can watch a whole subtree with one listener.

import { hasListener } from '../events/listenerCensus'
import { Node } from './Node'

export class Container extends Node {
  override readonly nodeName: string = 'Container'
  override readonly nodeType: string = 'Container'

  private readonly childNodes: Node[] = []

  get children(): readonly Node[] {
    return this.childNodes
  }

  // Adds an existing child (takes ownership of the reference), sets its parent, and
  // returns it (typed), so `const r = group.addChild(new Rect(...))` keeps the subtype.
  addChild<T extends Node>(child: T): T {
    child.parent = this
    this.childNodes.push(child)
    // Checked rather than fired unconditionally: populating a large scene is one call per
    // shape, and an event nothing listens for would still walk to the root on every one.
    if (hasListener('add')) this.fire('add', { child }, true)
    return child
  }

  removeChild(child: Node): boolean {
    const i = this.childNodes.indexOf(child)
    if (i < 0) return false
    this.childNodes.splice(i, 1)
    child.parent = null
    // Fired from the container the child just left, so the event still has somewhere to
    // bubble - the child itself is detached by now and would reach nothing.
    if (hasListener('remove')) this.fire('remove', { child }, true)
    return true
  }

  protected override eachChild(visit: (child: Node) => void): void {
    for (const child of this.childNodes) visit(child)
  }
}
