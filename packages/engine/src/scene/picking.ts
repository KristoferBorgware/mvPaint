// Z-order and hit-testing: what stacking order the scene's shapes/text render in, and
// which one sits under a world-space point. Both are derived from the SAME sorted list
// (collectZOrder) so they can never disagree - the renderer assigns each object's depth
// from its rank in that list, and pickNode walks it front-to-back.
//
// Shapes are hit-tested exactly, against the same triangles the mesh lane renders (fill
// + stroke) - via Shape.hitTestLocal(), which caches its own picking-friendly layout of
// buildGeometry()'s output (see Shape.ts), so this module does no tessellation or
// recording of its own. hitTestShape() rejects cheaply first: a shape's local bounds
// transformed into world space (a forward transform, no matrix inverse) either clears
// the point immediately or is followed by the exact (inverse + per-triangle) test - most
// shapes in a scene are nowhere near a given click, so this skips the expensive path for
// nearly all of them. Text is tested against its shaped quads' bounding box (glyph-
// accurate hit-testing isn't worth the cost here) - a single bounds check either way, so
// there's no equivalent cheap/exact split to make there.

import { AABB } from '../math/AABB'
import { Vector3 } from '../math/Vector3'
import type { Node } from '../shapes/Node'
import { Scene } from './Scene'
import { Shape } from '../shapes/Shape'
import { Text } from '../shapes/Text'
import type { FontBook } from '../text/FontAtlas'
import { quadCorner, type QuadTransform } from '../text/textQuad'

/** Anything pickNode()/collectZOrder() can return - every drawable is a Shape now. */
export type PickableNode = Shape

/** The corners textLocalBounds needs from each quad - satisfied by ShapedText's TextQuad. */
export interface QuadBounds extends QuadTransform {
  x0: number
  y0: number
  x1: number
  y1: number
}

function worldToLocal(node: Node, worldX: number, worldY: number): Vector3 {
  return node.worldMatrix().inverse().transformPoint(new Vector3(worldX, worldY, 0))
}

/** A shape's fill+stroke triangles, as an axis-aligned box in its own local space (cached - see Shape.ts). */
export function shapeLocalBounds(shape: Shape): AABB {
  return shape.localBounds()
}

/** True if the world point falls inside any of the shape's fill/stroke triangles. */
export function hitTestShape(shape: Shape, worldX: number, worldY: number): boolean {
  const world = shape.worldMatrix()
  const worldBounds = shape.localBounds().transformed(world)
  if (!worldBounds.valid() || !worldBounds.contains(new Vector3(worldX, worldY, 0))) return false
  const local = world.inverse().transformPoint(new Vector3(worldX, worldY, 0))
  return shape.hitTestLocal(local.x, local.y)
}

/**
 * The union of a shaped text's glyph+decoration quads, in the Text node's own local space.
 * All four corners go through the quad's own transform, so italic and curved text are
 * bounded by where their glyphs actually are rather than by the boxes they started as.
 */
export function textLocalBounds(shaped: { quads: readonly QuadBounds[] }): AABB {
  const box = new AABB()
  for (const q of shaped.quads) {
    for (const [x, y] of [
      [q.x0, q.y0],
      [q.x1, q.y0],
      [q.x1, q.y1],
      [q.x0, q.y1],
    ]) {
      const p = quadCorner(q, x, y)
      box.encapsulate(new Vector3(p.x, p.y, 0))
    }
  }
  return box
}

/** True if the world point falls inside the text's shaped bounding box. */
export function hitTestText(text: Text, fontBook: FontBook, worldX: number, worldY: number): boolean {
  const bounds = textLocalBounds(text.shaped(fontBook))
  if (!bounds.valid()) return false
  return bounds.contains(worldToLocal(text, worldX, worldY))
}

/**
 * Every Shape (mesh shape or Text) matching `predicate`, stable-sorted ascending by
 * zIndex (Array.prototype.sort is stable per spec, so ties keep scene-traversal order).
 * The renderer and pickNode() both build on this so "what's on top" and "what's under
 * the depth test" can never disagree.
 */
function collectSortedShapes(scene: Scene, predicate: (shape: Shape) => boolean): Shape[] {
  const all: Shape[] = []
  scene.root.traversePreOrder((node) => {
    if (node instanceof Shape && predicate(node)) all.push(node)
  })
  return all.sort((a, b) => a.zIndex - b.zIndex)
}

/**
 * Every visible Shape (mesh shape or Text) in the scene, ascending by zIndex (ties keep
 * scene order) - rank 0 is furthest back. Includes non-pickable shapes (e.g. a
 * selection-highlight overlay still needs a correct depth to render at).
 *
 * `sorted = false` skips the zIndex sort and returns plain traversal order instead - an
 * O(n log n) cost that's pure waste for a scene that never sets zIndex (every comparison
 * ties, so the stable sort reproduces traversal order anyway) or that doesn't care which
 * of its shapes ends up in front. The renderer exposes this as a per-scene opt-out (see
 * SceneRenderer.setZSortEnabled); pickNode always sorts, since picking still needs a
 * correct top-to-bottom order regardless of what depth the renderer is assigning.
 */
export function collectZOrder(scene: Scene, sorted = true): Shape[] {
  const all: Shape[] = []
  scene.root.traversePreOrder((node) => {
    if (node instanceof Shape && node.visible) all.push(node)
  })
  return sorted ? all.sort((a, b) => a.zIndex - b.zIndex) : all
}

/** Maps a zIndex rank (0 = furthest back) to an NDC depth strictly inside (0,1) - smaller wins under 'less-equal'. */
export function depthForRank(rank: number, count: number): number {
  return (count - rank) / (count + 1)
}

/**
 * The topmost pickable node under a world point, or null. Walks the SAME zIndex-sorted
 * order the renderer derives depth from (see collectZOrder), front-to-back (highest
 * zIndex/rank first), so picking always matches what's visually on top. Invisible and
 * non-pickable nodes (see `pickable`) are skipped. `fontBook` may be omitted when the
 * scene has no Text nodes worth testing (e.g. before the atlases have loaded) - text
 * candidates are then skipped rather than matched.
 */
export function pickNode(scene: Scene, worldX: number, worldY: number, fontBook?: FontBook): PickableNode | null {
  const ordered = collectSortedShapes(scene, (shape) => shape.visible && shape.pickable)
  for (let i = ordered.length - 1; i >= 0; i--) {
    const node = ordered[i]
    if (node instanceof Text) {
      if (fontBook && hitTestText(node, fontBook, worldX, worldY)) return node
    } else if (hitTestShape(node, worldX, worldY)) {
      return node
    }
  }
  return null
}

/** A pickable node's own local-space bounds (shape triangles, or shaped text quads). */
export function localBoundsOf(node: PickableNode, fontBook: FontBook): AABB {
  return node instanceof Text ? textLocalBounds(node.shaped(fontBook)) : shapeLocalBounds(node)
}
