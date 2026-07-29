// MarqueeTool - the rubber-band rectangle, as a thing that is switched on rather than
// something that happens.
//
// It holds the two world-space corners, announces them as they move, and resolves the
// finished rectangle to the nodes it covered. What it does NOT do is decide when a marquee
// should start, or what covering a node means: an application pulls one out because it
// chose to (a selection tool being active, a modifier held, a long press recognised) and
// decides for itself what the result is for. Dragging out a box means "select these" in one
// editor and "delete these" or "group these" in another, and the engine has no business
// assuming.
//
// begin/update/end are separate calls rather than one gesture handler because the pointer
// that drives them belongs to SceneInputController, which feeds this while it is active.
// That keeps a marquee drag from having to open the hover-event path just to read where the
// pointer is - see listenerCensus for why that would cost a hit-test per move.

import type { Vector2 } from '../math/Vector2'
import { hasListener } from '../events/listenerCensus'
import type { Node } from '../shapes/Node'
import type { Shape } from '../shapes/Shape'

/** The two opposite corners of the rectangle, in world space. */
export interface MarqueeCorners {
  from: Vector2
  to: Vector2
}

export class MarqueeTool {
  private from: Vector2 | null = null
  private to: Vector2 | null = null

  /**
   * @param root  where the marquee events are raised - normally the scene root.
   * @param resolve  the nodes a finished rectangle covers, e.g. SceneRendererHandle.nodesInBox.
   */
  constructor(
    private readonly root: Node,
    private readonly resolve: (from: Vector2, to: Vector2) => Shape[],
  ) {}

  /** Whether a rectangle is currently being pulled out. */
  get active(): boolean {
    return this.from !== null
  }

  /** The current corners, or null when no marquee is in progress. */
  get corners(): MarqueeCorners | null {
    return this.from && this.to ? { from: this.from, to: this.to } : null
  }

  /** Starts a rectangle at a world point. Raises 'marqueestart'. */
  begin(world: Vector2): void {
    this.from = world
    this.to = world
    this.announce('marqueestart', { from: world, to: world })
  }

  /** Moves the free corner. Raises 'marqueemove'. Ignored when nothing is in progress. */
  update(world: Vector2): void {
    if (!this.from) return
    this.to = world
    this.announce('marqueemove', { from: this.from, to: world })
  }

  /**
   * Finishes the rectangle and returns the nodes it covered, which it also carries on
   * 'marqueeend'. Returns nothing and raises nothing when no marquee was in progress.
   */
  end(): Shape[] {
    const from = this.from
    const to = this.to
    this.from = null
    this.to = null
    if (!from || !to) return []
    const nodes = this.resolve(from, to)
    this.announce('marqueeend', { from, to, nodes })
    return nodes
  }

  /**
   * Abandons the rectangle without resolving it - a press that dragged out no area, or a
   * second finger arriving. Still raises 'marqueeend', carrying nothing, so that every
   * 'marqueestart' has exactly one end however the gesture turned out.
   */
  cancel(): void {
    const from = this.from
    const to = this.to
    this.from = null
    this.to = null
    if (!from || !to) return
    this.announce('marqueeend', { from, to, nodes: [] })
  }

  private announce(type: string, payload: Record<string, unknown>): void {
    if (!hasListener(type)) return
    this.root.fire(type, payload, true)
  }
}
