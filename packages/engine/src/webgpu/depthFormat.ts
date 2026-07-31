// Shared depth-buffer settings for both render lanes and the frame pass that owns the
// depth texture (SceneRenderer/FrameRenderer) - kept in one place so the pipelines and
// the pass they run in can never disagree on format/compare.
//
// 'less-equal' (not 'less'): objects at the exact same depth (same zIndex rank) must
// still resolve by draw order, matching today's painter-order behavior for ties - the
// later-drawn fragment passes the equal-depth test and overwrites/blends over the
// earlier one. Only distinct zIndex ranks get distinct depth values (see
// scene/picking.ts's depthForRank), so cross-rank stacking is never a tie.
export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus'
export const DEPTH_COMPARE: GPUCompareFunction = 'less-equal'
