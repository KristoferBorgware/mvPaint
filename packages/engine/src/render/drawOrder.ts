// The order the content lanes are actually drawn in.
//
// Lanes used to draw one after another, each in a single call: all the mesh shapes, then
// all the text, then all the images. That is fewer draw calls, but it makes stacking depend
// on which lane a thing happens to be in. Alpha blending and the depth test know nothing
// about each other, so a translucent shape at alpha 0.4 still writes depth - and whatever
// sits behind it in a LATER lane is then rejected outright rather than showing through it.
// Transparency worked in one direction and not the other, for no reason a caller could see.
//
// So the lanes are interleaved instead: strictly furthest first, whatever lane that is.
// Every fragment then arrives over what is already behind it, which is the only order alpha
// blending composites correctly in. The depth test still runs and still resolves the shadow
// lane against all of it; it just no longer has to arbitrate between the content lanes,
// because back-to-front means every fragment is at or nearer than what it lands on.
//
// The cost is one draw per lane CHANGE rather than one per lane. A scene that is all one
// kind - either stress test - still yields exactly one run. A page of shapes with text over
// it yields two or three. Only a scene that genuinely alternates kinds all the way down
// pays per object, and it pays that to be correct.

import type { Shape } from '../shapes/Shape'

/**
 * One uninterrupted stretch of a single lane in the back-to-front draw order. `from`/`to`
 * index into that lane's own visible list, which is packed in the same order.
 */
export interface DrawRun {
  lane: 'mesh' | 'text' | 'image' | 'shadow'
  from: number
  to: number
}

/**
 * Merges the three lanes' visible lists - each already in ascending zIndex rank - into one
 * back-to-front sequence, coalescing neighbours from the same lane. Rank 0 is furthest back
 * and every list is a subsequence of the same global order, so a three-way merge on rank
 * reproduces that order exactly.
 */
export function buildDrawRuns(
  meshShapes: readonly Shape[],
  meshCount: number,
  meshDepths: readonly number[],
  texts: readonly Shape[],
  images: readonly Shape[],
  depths: ReadonlyMap<Shape, number>,
  shadows: readonly Shape[] = [],
  shadowDepthNudge = 0,
): DrawRun[] {
  const runs: DrawRun[] = []
  let m = 0
  let t = 0
  let i = 0
  let s = 0
  // Depth runs the opposite way to rank: rank 0 is furthest back and carries the LARGEST
  // depth (see scene/picking.ts's depthForRank). Furthest first therefore means largest
  // first. Ranks are distinct, so no two nodes can tie.
  const depthOf = (node: Shape | undefined): number => (node === undefined ? -Infinity : (depths.get(node) ?? -Infinity))

  while (m < meshCount || t < texts.length || i < images.length || s < shadows.length) {
    const dm = m < meshCount ? (meshDepths[m] ?? depthOf(meshShapes[m])) : -Infinity
    const dt = t < texts.length ? depthOf(texts[t]) : -Infinity
    const di = i < images.length ? depthOf(images[i]) : -Infinity
    // A shadow sits just BEHIND the shape casting it, which is what the nudge is: far
    // enough back to lose to its own caster, near enough to stay in front of whatever is
    // below. Merging on that puts every shadow immediately before the shape that casts it.
    const ds = s < shadows.length ? depthOf(shadows[s]) + shadowDepthNudge : -Infinity

    let lane: DrawRun['lane']
    let cursor: number
    if (ds >= dm && ds >= dt && ds >= di) {
      lane = 'shadow'
      cursor = s++
    } else if (dm >= dt && dm >= di) {
      lane = 'mesh'
      cursor = m++
    } else if (dt >= di) {
      lane = 'text'
      cursor = t++
    } else {
      lane = 'image'
      cursor = i++
    }

    const last = runs[runs.length - 1]
    if (last && last.lane === lane) last.to = cursor + 1
    else runs.push({ lane, from: cursor, to: cursor + 1 })
  }
  return runs
}
