// The order the lanes are actually drawn in.
//
// Lanes used to draw one after another, each in a single call: all the mesh shapes, then
// all the text, then all the images. That is fewer draw calls, but it makes stacking depend
// on which lane a thing happens to be in. Alpha blending and the depth test know nothing
// about each other, so a translucent shape at alpha 0.4 still writes depth - and whatever
// sits behind it in a LATER lane is then rejected outright rather than showing through it.
// Transparency worked in one direction and not the other, for no reason a caller could see.
//
// Drawing everything strictly furthest-first fixes that, but charges every scene for it:
// each lane CHANGE is a draw call, so a scene that alternates kinds all the way down pays
// one draw per object even where nothing is translucent at all.
//
// So the frame is split in two instead (see webgpu/SceneRenderer's draw()):
//
//   1. THE OPAQUE PASS. Objects that provably paint no partial alpha (see
//      render/opacity.ts). Order is irrelevant - the depth buffer resolves them - so each
//      lane draws as one batch, and each writes depth.
//   2. THE TRANSLUCENT PASS. Everything else, strictly furthest first, whatever lane that
//      is - which is what this function builds. Depth is still TESTED, so an opaque object
//      in front still hides what is behind it; depth is not WRITTEN, so translucent objects
//      never reject each other and each one blends over what is already there.
//
// The cost of interleaving is therefore paid only by the objects that need it. A stress
// field of solid shapes is one draw. A page of opaque shapes with text over it is two,
// however finely the two are stacked together. Only genuinely translucent content
// alternating between lanes pays per object, and it pays that to be correct.

/** The lanes that can appear in the interleaved order, in tie-break priority. */
export type LaneName = 'shadow' | 'mesh' | 'text' | 'image'

/**
 * One uninterrupted stretch of a single lane in the back-to-front draw order. `from`/`to`
 * index into that lane's own packed list, which is in the same order.
 */
export interface DrawRun {
  lane: LaneName
  from: number
  to: number
}

/** The part of one lane's packed list that takes part in the merge. */
export interface LaneSlice {
  /** Every packed entry's depth, index-aligned with the lane's own list. */
  depths: readonly number[]
  /** The half-open span of that list to merge; anything outside it is drawn elsewhere. */
  from: number
  to: number
}

export type LaneSlices = Partial<Record<LaneName, LaneSlice>>

// Ties go to the lane listed first. Ranks are distinct so the content lanes never tie with
// each other; a shadow only ever ties with its own caster, and drawing it first is what
// puts it behind. See SceneRenderer's shadow nudge.
const MERGE_ORDER: readonly LaneName[] = ['shadow', 'mesh', 'text', 'image']

/**
 * Merges each lane's slice - all already in ascending zIndex rank - into one back-to-front
 * sequence, coalescing neighbours from the same lane into a single run. Rank 0 is furthest
 * back and carries the LARGEST depth (see scene/picking.ts's depthForRank), so furthest
 * first means largest first, and every slice is a subsequence of the same global order.
 */
export function buildDrawRuns(lanes: LaneSlices): DrawRun[] {
  const names: LaneName[] = []
  const slices: LaneSlice[] = []
  const cursors: number[] = []
  for (const name of MERGE_ORDER) {
    const slice = lanes[name]
    if (!slice || slice.to <= slice.from) continue
    names.push(name)
    slices.push(slice)
    cursors.push(slice.from)
  }

  const runs: DrawRun[] = []
  for (;;) {
    let best = -1
    let bestDepth = 0
    for (let k = 0; k < slices.length; k++) {
      const cursor = cursors[k]
      if (cursor >= slices[k].to) continue
      const depth = slices[k].depths[cursor]
      if (best < 0 || depth > bestDepth) {
        best = k
        bestDepth = depth
      }
    }
    if (best < 0) break

    const cursor = cursors[best]++
    const lane = names[best]
    const last = runs[runs.length - 1]
    if (last && last.lane === lane) last.to = cursor + 1
    else runs.push({ lane, from: cursor, to: cursor + 1 })
  }
  return runs
}
