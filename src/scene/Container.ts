// Container - a Node that holds children (Konva-style). Concrete containers (a scene
// root / group) can be instantiated directly; Shape and Camera are leaf Nodes. Adds the
// child list and the eachChild() override that powers Node's traversal and search.

import { Node } from './Node'

export class Container extends Node {
  private readonly childNodes: Node[] = []

  get children(): readonly Node[] {
    return this.childNodes
  }

  // Adds an existing child (takes ownership of the reference), sets its parent, and
  // returns it (typed), so `const r = group.addChild(new Rect(...))` keeps the subtype.
  addChild<T extends Node>(child: T): T {
    child.parent = this
    this.childNodes.push(child)
    return child
  }

  removeChild(child: Node): boolean {
    const i = this.childNodes.indexOf(child)
    if (i < 0) return false
    this.childNodes.splice(i, 1)
    child.parent = null
    return true
  }

  protected override eachChild(visit: (child: Node) => void): void {
    for (const child of this.childNodes) visit(child)
  }
}
