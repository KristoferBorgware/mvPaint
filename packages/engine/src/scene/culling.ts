// Viewport culling: which shapes/text are worth sending to the GPU this frame. A 2D
// orthographic camera's frustum is just a world-space rectangle (see
// OrthographicCamera.viewBounds()), so "on screen" is one AABB-vs-AABB overlap test per
// object, against its own (cached) local bounds transformed into world space - no
// spatial index needed at the object counts this engine targets. Objects here move
// constantly, and a tree (quadtree, BVH, ...) has to be kept up to date every time one
// does; a linear scan over cheap, allocation-light bounds checks avoids paying that
// maintenance cost at all, and scales fine until the scene is orders of magnitude larger
// than what this engine is built for.

import type { AABB } from '../math/AABB'
import type { Shape } from '../shapes/Shape'
import type { Text } from '../shapes/Text'
import type { FontBook } from '../text/FontAtlas'
import { textLocalBounds } from './picking'

/** True if `shape`'s world-space bounds overlap `viewBounds` (shapes with no geometry at all are never culled). */
export function isShapeOnScreen(shape: Shape, viewBounds: AABB): boolean {
  const worldBounds = shape.localBounds().transformed(shape.worldMatrix())
  return !worldBounds.valid() || worldBounds.intersects(viewBounds)
}

/** True if `text`'s shaped bounds overlap `viewBounds` (text with no shaped content at all is never culled). */
export function isTextOnScreen(text: Text, fontBook: FontBook, viewBounds: AABB): boolean {
  const worldBounds = textLocalBounds(text.shaped(fontBook)).transformed(text.worldMatrix())
  return !worldBounds.valid() || worldBounds.intersects(viewBounds)
}
