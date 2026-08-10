// Container - a Node that holds children. Concrete containers (a scene
// root / group) can be instantiated directly; Shape and Camera are leaf Nodes. Adds the
// child list and the eachChild() override that powers Node's traversal and search.
//
// A NODE HAS ONE PARENT, and the add methods enforce it: handing a container a node that is
// already somewhere else takes it out of there first. Membership is what the whole scene is
// derived from - the render walk, picking, marquee selection and every bounds measurement each
// walk the tree - so a node reachable down two branches would be drawn twice, picked twice and
// counted twice in its group's extent, while its own `parent` pointer named only one of them.
//
// Membership changes raise 'add' and 'remove' on the container, carrying the child and
// bubbling, so an ancestor can watch a whole subtree with one listener. Moving a node between
// containers therefore raises 'remove' on the old one and 'add' on the new one, in that order.
//
// children is a live view of the internal list and read-only, because a node's parent pointer
// and its place in a list are one fact stored twice: splicing the array directly would leave
// the two disagreeing, with nothing to notice. getChildren() hands back a copy to sort, filter
// or hold on to, and add/addChild/removeChild/removeChildren are how the membership moves.

import { hasListener } from '../events/listenerCensus'
import { bumpObjectRecordEpoch } from './contentEpoch'
import { Node } from './Node'

export class Container extends Node {
  override readonly nodeName: string = 'Container'
  override readonly nodeType: string = 'Container'

  private readonly childNodes: Node[] = []

  /** This container's children, in order - a live view. See getChildren() for a copy. */
  get children(): readonly Node[] {
    return this.childNodes
  }

  /**
   * Adds one child and returns IT, typed - so `const r = group.addChild(new Rect(...))` keeps
   * the subtype. See add() for the variadic, chainable form.
   *
   * A child that already has a parent is taken out of it first, which raises 'remove' there.
   * Re-adding a node to the container it is already in moves it to the end of the list.
   *
   * The node keeps its own x/y/rotation/scale and lands wherever those mean inside this
   * container, so a node moved between containers with different transforms MOVES on screen.
   * Node.moveTo(parent, { keepWorldTransform: true }) is the one that holds it still.
   */
  addChild<T extends Node>(child: T): T {
    if (child === (this as unknown as Node)) throw new Error('Container.addChild: a node cannot contain itself.')
    if (child.isAncestorOf(this)) throw new Error('Container.addChild: cannot add a node to its own descendant.')
    // Before the push, and through remove() so the old parent hears 'remove' and its list is
    // spliced. A node re-added here leaves and rejoins, which is what moves it to the end.
    if (child.parent) child.remove()
    child.parent = this
    this.childNodes.push(child)
    // A world matrix is a chain, so joining or leaving one changes the whole subtree's -
    // without any of their own transform fields being touched. See contentEpoch.ts.
    bumpObjectRecordEpoch()
    // Checked rather than fired unconditionally: populating a large scene is one call per
    // shape, and an event nothing listens for would still walk to the root on every one.
    if (hasListener('add')) this.fire('add', { child }, true)
    return child
  }

  /**
   * Adds any number of children and returns the CONTAINER, so calls chain:
   *
   *   group.add(background, title).add(...rows)
   *
   * Each goes through addChild, so each is detached from wherever it was and each raises its
   * own 'add'. Adding nothing is allowed and does nothing.
   */
  add(...children: readonly Node[]): this {
    for (const child of children) this.addChild(child)
    return this
  }

  removeChild(child: Node): boolean {
    const i = this.childNodes.indexOf(child)
    if (i < 0) return false
    this.childNodes.splice(i, 1)
    child.parent = null
    bumpObjectRecordEpoch()
    // Fired from the container the child just left, so the event still has somewhere to
    // bubble - the child itself is detached by now and would reach nothing.
    if (hasListener('remove')) this.fire('remove', { child }, true)
    return true
  }

  /**
   * Takes every child out, leaving the container itself intact and usable. Each child is
   * fully usable too - this is removeChild() for all of them, not destroy().
   *
   * The 'remove' events fire before anything is spliced, so a handler that inspects
   * `children` sees the list it was told about rather than an empty one.
   */
  removeChildren(): this {
    const leaving = [...this.childNodes]
    if (hasListener('remove')) {
      for (const child of leaving) this.fire('remove', { child }, true)
    }
    for (const child of leaving) child.parent = null
    this.childNodes.length = 0
    if (leaving.length > 0) bumpObjectRecordEpoch()
    return this
  }

  /**
   * Destroys every child, leaving the container itself intact and empty. The children are
   * finished with - see Node.destroy for what that releases and what it does not.
   *
   * The distinction from removeChildren() is the children's future, not the container's:
   * emptying a group to refill it is a remove, and finishing with what was in it is this.
   */
  destroyChildren(): this {
    // Snapshotted, because each destroy() splices the child out of the list being walked.
    for (const child of [...this.childNodes]) child.destroy()
    return this
  }

  /**
   * A COPY of the child list, optionally narrowed - safe to sort, splice or keep, none of
   * which would be safe on `children`.
   *
   * The filter tests each direct child only. Use Node.find() for a selector over the whole
   * subtree.
   */
  getChildren(filter?: (child: Node) => boolean): Node[] {
    return filter ? this.childNodes.filter(filter) : [...this.childNodes]
  }

  /** Whether this container holds anything at all. */
  hasChildren(): boolean {
    return this.childNodes.length > 0
  }

  /**
   * A container's resource is its children: destroy() has already walked into them by the
   * time this runs (see Node.finalize), so all that is left is to let go of the list.
   */
  protected override releaseResources(): void {
    this.childNodes.length = 0
  }

  protected override eachChild(visit: (child: Node) => void): void {
    for (const child of this.childNodes) visit(child)
  }
}
