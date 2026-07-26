// Z-order and hit-testing: what stacking order the scene's shapes/text render in, and
// which one sits under a world-space point. Both are derived from the SAME sorted list
// (collectZOrder) so they can never disagree - the renderer assigns each object's depth
// from its rank in that list, and pickNode walks it front-to-back.
//
// Shapes are hit-tested exactly, against the same triangles the mesh lane renders (fill
// + stroke) - tessellate() is fed into a recording MeshSink instead of the GPU batcher,
// then the point is tested against every triangle in the shape's own local space. Text
// is tested against its shaped quads' bounding box (glyph-accurate hit-testing isn't
// worth the cost here). Both also expose their local-space bounds, for building a
// selection highlight that matches a picked node's own geometry.

import { AABB } from '../math/AABB'
import { Vector3 } from '../math/Vector3'
import type { Node } from '../shapes/Node'
import { Scene } from './Scene'
import { Shape } from '../shapes/Shape'
import { Text } from '../shapes/Text'
import type { FontBook } from '../text/FontAtlas'
import type { MeshSink, RGBA } from '../render/meshFormat'

/** Anything pickNode()/collectZOrder() can return - every drawable is a Shape now. */
export type PickableNode = Shape

/** The corners textLocalBounds needs from each quad - satisfied by ShapedText's TextQuad. */
export interface QuadBounds {
  x0: number
  y0: number
  x1: number
  y1: number
}

class RecordingMeshSink implements MeshSink {
  private readonly xs: number[] = []
  private readonly ys: number[] = []
  private readonly tris: number[] = []
  private readonly bounds = new AABB()

  vertex(x: number, y: number, _color: RGBA, _isFill: boolean): number {
    const index = this.xs.length
    this.xs.push(x)
    this.ys.push(y)
    this.bounds.encapsulate(new Vector3(x, y, 0))
    return index
  }

  triangle(a: number, b: number, c: number): void {
    this.tris.push(a, b, c)
  }

  containsPoint(x: number, y: number): boolean {
    for (let i = 0; i < this.tris.length; i += 3) {
      const a = this.tris[i]
      const b = this.tris[i + 1]
      const c = this.tris[i + 2]
      if (pointInTriangle(x, y, this.xs[a], this.ys[a], this.xs[b], this.ys[b], this.xs[c], this.ys[c])) {
        return true
      }
    }
    return false
  }

  getBounds(): AABB {
    return this.bounds
  }
}

function edgeSign(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by)
}

// Tessellated geometry can legitimately include zero-area triangles (e.g. duplicate
// points from a stroke join) - harmless for the GPU rasterizer, which simply covers no
// pixels, but fatal for the sign-based test below: a degenerate triangle's three edge
// signs are all exactly 0, so "no negative and no positive" would call every point a
// hit. Reject anything without a real interior first.
const DEGENERATE_AREA_EPSILON = 1e-9

function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  const area2 = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
  if (Math.abs(area2) < DEGENERATE_AREA_EPSILON) return false

  const d1 = edgeSign(px, py, ax, ay, bx, by)
  const d2 = edgeSign(px, py, bx, by, cx, cy)
  const d3 = edgeSign(px, py, cx, cy, ax, ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

function worldToLocal(node: Node, worldX: number, worldY: number): Vector3 {
  return node.worldMatrix().inverse().transformPoint(new Vector3(worldX, worldY, 0))
}

/** A shape's fill+stroke triangles, tessellated fresh, as an axis-aligned box in its own local space. */
export function shapeLocalBounds(shape: Shape): AABB {
  const sink = new RecordingMeshSink()
  shape.tessellate(sink)
  return sink.getBounds()
}

/** True if the world point falls inside any of the shape's fill/stroke triangles. */
export function hitTestShape(shape: Shape, worldX: number, worldY: number): boolean {
  const local = worldToLocal(shape, worldX, worldY)
  const sink = new RecordingMeshSink()
  shape.tessellate(sink)
  return sink.containsPoint(local.x, local.y)
}

/** The union of a shaped text's glyph+decoration quads, in the Text node's own local space. */
export function textLocalBounds(shaped: { quads: readonly QuadBounds[] }): AABB {
  const box = new AABB()
  for (const q of shaped.quads) {
    box.encapsulate(new Vector3(q.x0, q.y0, 0))
    box.encapsulate(new Vector3(q.x1, q.y1, 0))
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
 */
export function collectZOrder(scene: Scene): Shape[] {
  return collectSortedShapes(scene, (shape) => shape.visible)
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
