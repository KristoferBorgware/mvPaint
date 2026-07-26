// Self-test for the mesh-lane data path (no GPU). Tessellates shapes through a
// capturing MeshSink and asserts the vertex/index/isFill layout, the format constants,
// the fill-type encoding, and the general contour stroker (joins/caps/multi-contour).
// WGSL fragment-shader math (gradient evaluation) cannot run without a GPU and is not
// covered here - it's checked by numeric reference calculations instead.
// Run with: npx tsx src/render/selfTest.ts

import { Rect } from '../shapes/Rect'
import { Circle, circleSegments } from '../shapes/Circle'
import { Polyline } from '../shapes/Polyline'
import { Path } from '../shapes/Path'
import {
  FILL_TYPE_CODE,
  MESH_VERTEX_LAYOUT,
  MESH_VERTEX_STRIDE,
  OBJECT_STRIDE,
  type MeshSink,
  type RGBA,
} from './meshFormat'
import { strokeContours, strokePolyline, type LineCap, type Point2 } from './stroke'
import { Shape } from '../shapes/Shape'
import { hitTestShape } from '../scene/picking'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Vector3 } from '../math/Vector3'

let count = 0
function assert(cond: boolean, msg: string): void {
  count++
  if (!cond) throw new Error(`[render] self-test FAILED: ${msg}`)
}

interface CapturedVertex {
  x: number
  y: number
  isFill: boolean
}
interface Captured {
  verts: CapturedVertex[]
  tris: [number, number, number][]
}

function capturingSink(): { sink: MeshSink } & Captured {
  const verts: CapturedVertex[] = []
  const tris: [number, number, number][] = []
  const sink: MeshSink = {
    vertex: (x, y, isFill) => {
      verts.push({ x, y, isFill })
      return verts.length - 1
    },
    triangle: (a, b, c) => {
      tris.push([a, b, c])
    },
  }
  return { sink, verts, tris }
}

// A capturing sink that records exactly what a shape emits (indices local to the shape).
function capture(shape: Shape): Captured {
  const { sink, verts, tris } = capturingSink()
  shape.tessellate(sink)
  return { verts, tris }
}

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
const hasVertexNear = (verts: CapturedVertex[], x: number, y: number, eps = 1e-6) =>
  verts.some((v) => near(v.x, x, eps) && near(v.y, y, eps))

// --- format constants match the WGSL structs ---
assert(MESH_VERTEX_STRIDE === 12, 'mesh vertex stride is 12 bytes (position + packedId, no color)')
assert(MESH_VERTEX_LAYOUT.arrayStride === MESH_VERTEX_STRIDE, 'layout stride matches')
assert(
  OBJECT_STRIDE === 304,
  'object stride is one mat4 (64B) + gradient material (208B) + fillColor/strokeColor (32B)',
)

// --- stroked rect: fill (4v/2t) + a 4-corner miter-joined contour ---
{
  const fill: RGBA = [0.9, 0.2, 0.1, 1]
  const stroke: RGBA = [0, 0, 0, 1]
  const rect = new Rect({ x: 0, y: 0, width: 4, height: 2, fill, stroke, strokeWidth: 0.4 })
  const { verts, tris } = capture(rect)

  // Stroke = 4 edges * 4 verts (16v/8t) + 4 joints * (1 pivot + 2 concave + 3 miter) (24v/12t).
  assert(verts.length === 4 + 40, 'stroked rect: 4 fill + 40 general-stroker vertices')
  assert(tris.length === 2 + 20, 'stroked rect: 2 fill + 20 general-stroker triangles')

  // Fill verts (still emitted first, unchanged) carry no color of their own - just
  // marked isFill (gradient-eligible) - and sit at (±w/2,±h/2). The shape's fill/stroke
  // colors are read from the object buffer at fragment time, not from vertex data.
  assert(verts.slice(0, 4).every((v) => v.isFill), 'first 4 verts are marked isFill')
  assert(near(verts[0].x, -2) && near(verts[0].y, -1), 'fill corner at (-w/2,-h/2)')
  assert(near(verts[2].x, 2) && near(verts[2].y, 1), 'fill corner at (+w/2,+h/2)')
  assert(verts.slice(4).every((v) => !v.isFill), 'stroke verts are never marked isFill (no gradient on stroke)')
  assert(rect.fill === fill && rect.stroke === stroke, 'the shape retains the fill/stroke colors it was constructed with')

  // A 90° miter offsets the OUTER (convex) corner by strokeWidth/2 in x AND y
  // independently - the exact geometry the old hand-rolled Rect stroke produced, now
  // via the general engine. The concave (inner) side is the documented simplification
  // (fills to the original path point rather than a true inner-miter intersection), so
  // it lands at each edge's own per-normal offset instead of a symmetric diagonal point.
  assert(hasVertexNear(verts, -2.2, -1.2), 'outer miter corner at edge + sw/2 (matches the old formula)')
  assert(hasVertexNear(verts, 1.8, 1.0), 'inner offset along one edge at the (hw,hh) corner')
  assert(hasVertexNear(verts, 2.0, 0.8), 'inner offset along the other edge at the (hw,hh) corner')
}

// --- fill-only rect: 4 verts, 2 triangles (stroke path untouched) ---
{
  const rect = new Rect({ width: 3, height: 3, fill: [1, 1, 1, 1], strokeWidth: 0 })
  const { verts, tris } = capture(rect)
  assert(verts.length === 4, 'fill-only rect has 4 vertices')
  assert(tris.length === 2, 'fill-only rect has 2 triangles')
}

// --- circle: fill fan + a round-joined rim contour (structural checks; the general
//     stroker's exact per-joint vertex count depends on its round-arc step count) ---
{
  const n = 24
  const fill: RGBA = [0.2, 0.7, 0.35, 1]
  const stroke: RGBA = [0, 0, 0, 1]
  const r = 2
  const sw = 0.4
  const circle = new Circle({ x: 0, y: 0, radius: r, fill, stroke, strokeWidth: sw, segments: n })
  const { verts, tris } = capture(circle)

  const fillOnly = capture(new Circle({ radius: r, fill, strokeWidth: 0, segments: n }))
  assert(verts.length > fillOnly.verts.length, 'stroke adds geometry beyond the fill fan')
  assert(tris.length > fillOnly.tris.length, 'stroke adds triangles beyond the fill fan')
  assert(near(verts[0].x, 0) && near(verts[0].y, 0), 'fan center at origin')
  assert(near(Math.hypot(verts[1].x, verts[1].y), r), 'first rim vertex is at the radius')
  assert(verts.slice(0, n + 1).every((v) => v.isFill), 'fan verts are marked isFill')
  assert(verts.slice(n + 1).every((v) => !v.isFill), 'stroke verts are never marked isFill')
  assert(circle.fill === fill && circle.stroke === stroke, 'the shape retains the fill/stroke colors it was constructed with')
  // The round join tracks the true offset circle closely (not exactly, since the round
  // arc is discretized per joint and the straight segment quads facet slightly inward -
  // the same faceting any polygon approximation of a circle has). Check the overall
  // radial extent of the stroke geometry lands near r ± sw/2, within that faceting.
  const dists = verts.slice(n + 1).map((v) => Math.hypot(v.x, v.y))
  assert(near(Math.max(...dists), r + sw / 2, 0.01), 'outer stroke extent close to radius + sw/2')
  assert(near(Math.min(...dists), r - sw / 2, 0.01), 'inner stroke extent close to radius - sw/2')
}

// --- adaptive segment count grows with radius and is clamped ---
{
  assert(circleSegments(0.001) === 12, 'tiny circle clamps to the minimum segments')
  assert(circleSegments(1000) === 256, 'huge circle clamps to the maximum segments')
  assert(circleSegments(50) > circleSegments(2), 'more segments for a larger radius')
}

// --- localMatrix carries position + rotation but NO scale (size is in geometry) ---
{
  const rect = new Rect({ x: 5, y: -3, width: 10, height: 10, rotation: 0 })
  const world = rect.worldMatrix()
  // A local corner at (w/2, h/2) = (5,5) maps to center + corner (translation only).
  const p = world.transformPoint(new Vector3(5, 5, 0))
  assert(near(p.x, 10) && near(p.y, 2), 'no scale: corner offset is unscaled (5,5)->(10,2)')
}

// --- scaleX/scaleY scale local geometry about the shape's own local origin ---
{
  const rect = new Rect({ x: 100, y: 50, width: 10, height: 10, scaleX: 2, scaleY: 3 })
  const world = rect.worldMatrix()
  // Local corner (5,5) scales to (10,15), then translates by (x,y).
  const p = world.transformPoint(new Vector3(5, 5, 0))
  assert(near(p.x, 110) && near(p.y, 65), 'scaleX/scaleY scale local geometry independently')
}

// --- offsetX/offsetY shift the pivot (applied before scale/rotation, translation-only
//     case is unambiguous regardless of rotation sign convention) ---
{
  const rect = new Rect({ x: 100, y: 50, offsetX: 4, offsetY: -6 })
  const world = rect.worldMatrix()
  // Local origin (0,0) -> subtract offset -> (-4,6) -> translate by (x,y) -> (96,56).
  const p = world.transformPoint(new Vector3(0, 0, 0))
  assert(near(p.x, 96) && near(p.y, 56), 'offset shifts the pivot: origin -> (x-offsetX, y-offsetY)')
}

// --- localMatrix composes translate(x,y) * rotate(rotation) * scale(scaleX,scaleY) *
//     translate(-offsetX,-offsetY), matching the composition order of an established
//     2D canvas library's Node transform. Cross-checked against an independently
//     assembled equivalent using the same Matrix4x4 primitives, so this specifically
//     verifies ORDER (rotation sign/trig itself is covered by the math self-test). ---
{
  const rect = new Rect({ x: 40, y: -10, rotation: 0.7, scaleX: 2, scaleY: 0.5, offsetX: 3, offsetY: -2 })
  const expected = Matrix4x4.translation(new Vector3(40, -10, 0))
    .mul(Matrix4x4.rotationQuaternion(Quaternion.fromAxisAngle(Vector3.unitZ(), 0.7)))
    .mul(Matrix4x4.scaling(new Vector3(2, 0.5, 1)))
    .mul(Matrix4x4.translation(new Vector3(-3, 2, 0)))
  const p = new Vector3(1.5, -4.25, 0)
  assert(
    rect.localMatrix().transformPoint(p).nearEquals(expected.transformPoint(p), 1e-5),
    'localMatrix matches an independently composed T*R*S*T(-offset)',
  )
}

// --- Circle's width/height are derived from radius, not stored independently ---
{
  const circle = new Circle({ radius: 25 })
  assert(circle.width === 50 && circle.height === 50, 'width/height read as radius*2')
  circle.width = 200
  assert(circle.radius === 100, 'setting width updates radius (width/2)')
  circle.height = 10
  assert(circle.radius === 5, 'setting height also updates radius (height/2)')

  // Constructing via width/height (no radius given) derives radius correctly - this is
  // the scenario the constructor's radius/width/height priority logic must get right,
  // since Shape's own constructor writes a default width/height through the SAME
  // overridden accessor before Circle's constructor body runs.
  const viaWidth = new Circle({ width: 60 })
  assert(viaWidth.radius === 30, 'constructing via width alone sets radius = width/2')
  const viaRadius = new Circle({ radius: 15, width: 999 })
  assert(viaRadius.radius === 15, 'radius wins over width when both are given')
}

// ============================================================================
// Shape-level fill/gradient API (src/shapes/Shape.ts) and its numeric encoding.
// ============================================================================

// --- fill-type encoding matches the shader's expected FILL_COLOR/LINEAR/RADIAL values ---
{
  assert(FILL_TYPE_CODE.color === 0, 'solid color encodes to fill type 0')
  assert(FILL_TYPE_CODE['linear-gradient'] === 1, 'linear gradient encodes to fill type 1')
  assert(FILL_TYPE_CODE['radial-gradient'] === 2, 'radial gradient encodes to fill type 2')
}

// --- a shape defaults to a solid color fill with empty gradient stops ---
{
  const rect = new Rect({ fill: [0.5, 0.5, 0.5, 1] })
  assert(rect.fillPriority === 'color', 'default fillPriority is color')
  assert(rect.fillLinearGradientColorStops.length === 0, 'default linear stops are empty')
  assert(rect.fillRadialGradientColorStops.length === 0, 'default radial stops are empty')
  assert(rect.fillRadialGradientStartRadius === 0, 'default radial start radius is 0')

  // Switching fillPriority is a plain property assignment (Shape-level API), and it
  // doesn't affect what tessellate() emits per vertex - the fragment shader decides
  // whether to use the object's flat fillColor or a gradient, based on its fillType.
  rect.fillPriority = 'linear-gradient'
  rect.fillLinearGradientStartPoint = { x: -1, y: 0 }
  rect.fillLinearGradientEndPoint = { x: 1, y: 0 }
  rect.fillLinearGradientColorStops = [
    { offset: 0, color: [1, 0, 0, 1] },
    { offset: 1, color: [0, 0, 1, 1] },
  ]
  assert(rect.fillPriority === 'linear-gradient', 'fillPriority is mutable')
  assert(rect.fillLinearGradientColorStops.length === 2, 'gradient stops are mutable')
}

// --- stroke/lineJoin/lineCap/miterLimit live on Shape itself now, one declaration
//     shared by every concrete shape instead of each redeclaring the same fields ---
{
  const rect = new Rect()
  const circle = new Circle()
  const polyline = new Polyline({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })
  const path = new Path()

  assert(rect instanceof Shape && circle instanceof Shape && polyline instanceof Shape && path instanceof Shape, 'all four extend Shape directly')

  assert(rect.stroke[3] === 1 && circle.stroke[3] === 1 && polyline.stroke[3] === 1 && path.stroke[3] === 1, 'stroke defaults to opaque black across every shape kind')
  assert(rect.strokeWidth === 0 && circle.strokeWidth === 0 && path.strokeWidth === 0, 'strokeWidth defaults to 0 (no stroke) for fillable shapes')
  assert(polyline.strokeWidth === 1, 'Polyline overrides the default to a visible 1-unit stroke (it is stroke-only)')

  assert(rect.lineJoin === 'miter', "Rect inherits Shape's default lineJoin ('miter' suits its 90deg corners exactly)")
  assert(circle.lineJoin === 'round', "Circle overrides the default to 'round' so its segmented rim doesn't facet")
  assert(polyline.lineJoin === 'miter' && path.lineJoin === 'miter', 'Polyline/Path keep the inherited default')

  circle.lineJoin = 'bevel'
  assert(circle.lineJoin === 'bevel', 'lineJoin remains a plain mutable field, overridable after construction')
}

// ============================================================================
// tessellate() caching (src/shapes/Shape.ts) - buildGeometry() only reruns on a
// markGeometryDirty() cache miss, not on every tessellate() call.
// ============================================================================

// --- repeated tessellate() calls reuse the cache; markGeometryDirty() forces a rebuild
//     that reflects the shape's current (mutated) state ---
{
  class CountingShape extends Shape {
    buildCalls = 0
    size = 10
    protected override buildGeometry(sink: MeshSink): void {
      this.buildCalls++
      const h = this.size / 2
      const a = sink.vertex(-h, -h, true)
      const b = sink.vertex(h, -h, true)
      const c = sink.vertex(h, h, true)
      sink.triangle(a, b, c)
    }
  }

  const shape = new CountingShape()
  const first = capture(shape)
  assert(shape.buildCalls === 1, 'first tessellate() call runs buildGeometry()')
  assert(near(first.verts[1].x, 5), 'cached geometry reflects size at first tessellation (10/2)')

  const second = capture(shape)
  assert(shape.buildCalls === 1, 'a second tessellate() call with no markGeometryDirty() reuses the cache')
  assert(second.verts.length === first.verts.length, 'replayed geometry has the same vertex count')

  shape.size = 40
  const stale = capture(shape)
  assert(shape.buildCalls === 1, 'mutating a geometry-affecting field alone does not invalidate the cache')
  assert(near(stale.verts[1].x, 5), 'so tessellate() still replays the OLD geometry until told otherwise')

  shape.markGeometryDirty()
  const fresh = capture(shape)
  assert(shape.buildCalls === 2, 'markGeometryDirty() forces the next tessellate() to call buildGeometry() again')
  assert(near(fresh.verts[1].x, 20), 'the rebuilt geometry reflects the new size (40/2)')

  // Picking (scene/picking.ts) tessellates independently for hit-testing - it shares the
  // same cache, so repeated picks against an unchanged shape don't re-run buildGeometry().
  assert(hitTestShape(shape, 0, 0), 'sanity: the shape is hit-testable through the cache')
  assert(shape.buildCalls === 2, 'hitTestShape() reused the cache rather than rebuilding again')

  // A pure transform change never needs markGeometryDirty(): it's applied via the
  // object's world matrix, never baked into the cached local-space geometry.
  shape.x = 500
  shape.rotation = 1
  capture(shape)
  assert(shape.buildCalls === 2, 'transform-only changes never invalidate the geometry cache')
}

// ============================================================================
// General contour stroker (src/render/stroke.ts) - the shared engine itself.
// ============================================================================

// --- a 4-corner miter loop matches the closed-form 90° formula independent of Rect ---
{
  const corners: Point2[] = [
    { x: -2, y: -1 },
    { x: 2, y: -1 },
    { x: 2, y: 1 },
    { x: -2, y: 1 },
  ]
  const { sink, verts } = capturingSink()
  strokePolyline(corners, sink, { width: 0.4, closed: true, join: 'miter' })
  assert(hasVertexNear(verts, -2.2, -1.2), 'engine: outer miter corner (-hw-s,-hh-s)')
  assert(hasVertexNear(verts, 2.2, 1.2), 'engine: outer miter corner (hw+s,hh+s)')
  // Concave (inner) side: the documented simplification (see stroke.ts), landing at each
  // edge's own per-normal offset rather than a symmetric inner-miter intersection.
  assert(hasVertexNear(verts, -1.8, -1.0), 'engine: inner offset along one edge at (-hw,-hh)')
  assert(hasVertexNear(verts, -2.0, -0.8), 'engine: inner offset along the other edge at (-hw,-hh)')
}

// --- miter limit: a near-180° hairpin turn falls back to bevel below the limit ---
{
  // An open 3-point path with a single joint at the origin, folding back on itself.
  const points: Point2[] = [
    { x: -1, y: 0.05 },
    { x: 0, y: 0 },
    { x: -1, y: -0.05 },
  ]
  function counts(miterLimit: number): { v: number; t: number } {
    const { sink, verts, tris } = capturingSink()
    strokePolyline(points, sink, { width: 0.2, closed: false, join: 'miter', miterLimit })
    return { v: verts.length, t: tris.length }
  }
  const low = counts(1) // falls back to bevel: 2 edges (8v/4t) + 1 joint bevel (5v/2t)
  const high = counts(1000) // true miter: 2 edges (8v/4t) + 1 joint miter (6v/3t)
  assert(low.v === 13 && low.t === 6, 'low miterLimit forces the bevel fallback at the joint')
  assert(high.v === 14 && high.t === 7, 'high miterLimit allows the true (longer) miter point')
}

// --- round join: a clean 90° turn sweeps a quarter-circle arc of the expected size ---
{
  const points: Point2[] = [
    { x: 0, y: -1 },
    { x: 0, y: 0 },
    { x: 1, y: 0 },
  ]
  const { sink, verts, tris } = capturingSink()
  strokePolyline(points, sink, { width: 0.2, closed: false, join: 'round', roundSegments: 8 })
  // 2 edges (8v/4t) + 1 joint: pivot(1) + concave(2v/1t) + round(start(1) + 4 arc steps/4t).
  assert(verts.length === 16, 'round join at 90°: 8 segment + 8 joint vertices (1p+2+1+4 arc)')
  assert(tris.length === 9, 'round join at 90°: 4 segment + 5 joint triangles (1 concave + 4 arc)')
}

// --- caps: butt adds nothing, square/round add the expected fixed geometry per end ---
{
  const line: Point2[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
  ]
  function capCounts(cap: LineCap): { v: number; t: number } {
    const { sink, verts, tris } = capturingSink()
    strokePolyline(line, sink, { width: 0.2, closed: false, join: 'miter', cap })
    return { v: verts.length, t: tris.length }
  }
  const butt = capCounts('butt')
  const square = capCounts('square')
  const round = capCounts('round')
  assert(butt.v === 4 && butt.t === 2, 'butt cap: no extra geometry beyond the segment quad')
  assert(square.v === 4 + 2 * 4 && square.t === 2 + 2 * 2, 'square cap: 4v/2t per end, two ends')
  assert(round.v === 4 + 2 * 10 && round.t === 2 + 2 * 8, 'round cap: hub+first+8 arc verts/8 tris per end')
}

// --- multi-contour: an outer loop and a hole are stroked independently ---
{
  const outer: Point2[] = [
    { x: -2, y: -2 },
    { x: 2, y: -2 },
    { x: 2, y: 2 },
    { x: -2, y: 2 },
  ]
  const hole: Point2[] = [
    { x: -1, y: -1 },
    { x: 1, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
  ]
  const { sink, verts, tris } = capturingSink()
  strokeContours(
    [
      { points: outer, closed: true },
      { points: hole, closed: true },
    ],
    sink,
    { width: 0.2, join: 'miter' },
  )
  // Each independent 4-corner miter loop contributes 40 vertices / 20 triangles (as above).
  assert(verts.length === 80, 'two independent contours contribute 40 vertices each')
  assert(tris.length === 40, 'two independent contours contribute 20 triangles each')
  // Both loops' corners are offset AWAY from their own center - stroking treats a hole
  // boundary exactly like any other contour, independent of fill semantics.
  assert(hasVertexNear(verts, -2.1, -2.1), 'outer contour corner offset present')
  assert(hasVertexNear(verts, -1.1, -1.1), 'hole contour corner offset present, same convention')
}

console.log(`[render] self-test passed (${count} assertions)`)
