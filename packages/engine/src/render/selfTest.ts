// Self-test for the mesh-lane data path (no GPU). Tessellates shapes through a
// capturing MeshSink and asserts the vertex/index/isFill layout, the format constants,
// the fill-type encoding, and the general contour stroker (joins/caps/multi-contour).
// WGSL fragment-shader math (gradient evaluation, and the shadow atlas's silhouette /
// morphology / Gaussian passes) cannot run without a GPU and is not covered here - what IS
// covered is the CPU-side sizing and placement those passes are driven by.
// Run with: npx tsx src/render/selfTest.ts

import { Rect , type RectOptions } from '../shapes/Rect'
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
import { buildDrawRuns } from './drawOrder'
import { Text } from '../shapes/Text'
import { depthForRank } from '../scene/picking'
import {
  SLOT_GRANULARITY,
  blurMarginUnits,
  shadowMarginUnits,
  shadowQuadBounds,
  shadowRegion,
  shadowSigma,
  shadowWorldOffset,
  slotBucket,
  worldAxisScale,
} from './shadowMath'
import {
  SHADOW_OBJECT_DEPTH_OFFSET,
  SHADOW_OBJECT_QUAD_OFFSET,
  SHADOW_OBJECT_STRIDE,
  SHADOW_OBJECT_UV_OFFSET,
  SHADOW_VERTEX_LAYOUT,
  SHADOW_VERTEX_STRIDE,
} from './shadowFormat'
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

/**
 * A Rect CENTRED on (x, y). A Rect's own origin is its top-left corner (see Shape's
 * header), so this applies the pivot offset that puts its middle back on the position -
 * which is the frame the geometry below is written in.
 */
const centredRect = (options: RectOptions = {}): Rect =>
  new Rect({ ...options, offsetX: (options.width ?? 1) / 2, offsetY: -(options.height ?? 1) / 2 })


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
  // Geometry is emitted in the shape's own local frame, which a pivot offset never moves,
  // so this is a plain Rect: its origin IS the top-left corner of what it emits.
  const rect = new Rect({ x: 0, y: 0, width: 4, height: 2, fill, stroke, strokeWidth: 0.4 })
  const { verts, tris } = capture(rect)

  // Stroke = 4 edges * 4 verts (16v/8t) + 4 joints * (1 pivot + 2 concave + 3 miter) (24v/12t).
  assert(verts.length === 4 + 40, 'stroked rect: 4 fill + 40 general-stroker vertices')
  assert(tris.length === 2 + 20, 'stroked rect: 2 fill + 20 general-stroker triangles')

  // Fill verts (still emitted first, unchanged) carry no color of their own - just marked
  // isFill (gradient-eligible). A Rect hangs from its top-left corner at the local origin,
  // so it spans x in [0, width] and y in [-height, 0]. The shape's fill/stroke colors are
  // read from the object buffer at fragment time, not from vertex data.
  assert(verts.slice(0, 4).every((v) => v.isFill), 'first 4 verts are marked isFill')
  assert(near(verts[0].x, 0) && near(verts[0].y, -2), 'fill corner at the bottom-left, (0,-height)')
  assert(near(verts[2].x, 4) && near(verts[2].y, 0), 'fill corner at the top-right, (width,0)')
  const xs = verts.slice(0, 4).map((v) => v.x)
  const ys = verts.slice(0, 4).map((v) => v.y)
  assert(Math.min(...xs) === 0 && Math.max(...xs) === 4, 'the fill starts at x=0 and runs right')
  assert(Math.max(...ys) === 0 && Math.min(...ys) === -2, 'and starts at y=0 and hangs downward')
  assert(verts.slice(4).every((v) => !v.isFill), 'stroke verts are never marked isFill (no gradient on stroke)')
  assert(rect.fill === fill && rect.stroke === stroke, 'the shape retains the fill/stroke colors it was constructed with')

  // A 90° miter offsets the OUTER (convex) corner by strokeWidth/2 in x AND y
  // independently - the exact geometry the old hand-rolled Rect stroke produced, now
  // via the general engine. The concave (inner) side is the documented simplification
  // (fills to the original path point rather than a true inner-miter intersection), so
  // it lands at each edge's own per-normal offset instead of a symmetric diagonal point.
  // Corners are (0,0), (4,0), (4,-2), (0,-2) - the rectangle hangs from its origin.
  assert(hasVertexNear(verts, -0.2, -2.2), 'outer miter corner at the bottom-left corner + sw/2 on both axes')
  assert(hasVertexNear(verts, 3.8, 0.0), 'inner offset along one edge at the top-right corner')
  assert(hasVertexNear(verts, 4.0, -0.2), 'inner offset along the other edge at the top-right corner')
}

// --- fill-only rect: 4 verts, 2 triangles (stroke path untouched) ---
{
  const rect = centredRect({ width: 3, height: 3, fill: [1, 1, 1, 1], strokeWidth: 0 })
  const { verts, tris } = capture(rect)
  assert(verts.length === 4, 'fill-only rect has 4 vertices')
  assert(tris.length === 2, 'fill-only rect has 2 triangles')
}

// --- rounded rect: the corners become arcs, and the outline still spans the same box ---
{
  const seg = 4
  const r = 1
  const rect = new Rect({ width: 8, height: 6, cornerRadius: r, cornerSegments: seg, fill: [1, 1, 1, 1] })
  const { verts, tris } = capture(rect)

  // Four corners, each an arc of seg+1 points, fanned from the first: n verts, n-2 tris.
  const n = 4 * (seg + 1)
  assert(verts.length === n, `a rounded rect's fill is one point per arc sample (${n})`)
  assert(tris.length === n - 2, 'fanned from the first outline point, so two fewer triangles than points')
  assert(verts.every((v) => v.isFill), 'every rounded-fill vertex is marked isFill')

  // The arcs are tangent to the edges, so the outline still touches all four sides - a
  // rounded rect occupies the same box, it just cuts the corners off.
  const xs = verts.map((v) => v.x)
  const ys = verts.map((v) => v.y)
  assert(near(Math.min(...xs), 0) && near(Math.max(...xs), 8), 'still spans x in [0, width]')
  assert(near(Math.min(...ys), -6) && near(Math.max(...ys), 0), 'and y in [-height, 0]')
  assert(near(rect.localBounds().min.x, 0) && near(rect.localBounds().max.y, 0), 'so the bounds are unchanged too')

  // ...and the square corners themselves are gone: nothing sits within the radius of them.
  const square = [
    { x: 0, y: 0 },
    { x: 8, y: 0 },
    { x: 8, y: -6 },
    { x: 0, y: -6 },
  ]
  // The arc's closest approach to the corner it replaces is its 45-degree sample, at
  // r*(sqrt(2)-1) away - so nothing reaches the corner, and nothing crosses to the far side.
  const cut = r * (Math.SQRT2 - 1)
  assert(
    verts.every((v) => square.every((c) => Math.hypot(v.x - c.x, v.y - c.y) >= cut - 1e-9)),
    'no vertex comes closer to a square corner than the arc does',
  )
  assert(square.every((c) => !hasVertexNear(verts, c.x, c.y)), 'and none sits on one')
  // Every arc sample is exactly its radius from that corner's arc centre.
  const centres = [
    { x: r, y: -r },
    { x: 8 - r, y: -r },
    { x: 8 - r, y: -6 + r },
    { x: r, y: -6 + r },
  ]
  assert(
    verts.every((v) => centres.some((c) => near(Math.hypot(v.x - c.x, v.y - c.y), r, 1e-9))),
    'every vertex lies on one of the four corner arcs',
  )
}

// --- radius 0 keeps the plain four-vertex quad, so rounding costs the common case nothing ---
{
  const plain = capture(new Rect({ width: 4, height: 2 }))
  const explicitZero = capture(new Rect({ width: 4, height: 2, cornerRadius: 0 }))
  assert(plain.verts.length === 4 && plain.tris.length === 2, 'radius 0 is still 4 verts / 2 triangles')
  assert(explicitZero.verts.length === 4, 'passing 0 explicitly takes the same path')
  // A radius that fits nothing (a zero-sized rect) is scaled away to that same quad.
  assert(capture(new Rect({ width: 0, height: 0, cornerRadius: 5 })).verts.length === 4, 'a rect too small to round stays square')
}

// --- per-corner radii, and only the named corner is cut ---
{
  const seg = 3
  const rect = new Rect({ width: 10, height: 10, cornerRadius: [2, 0, 0, 0], cornerSegments: seg })
  const { verts } = capture(rect)
  // Three square corners contribute one point each, the rounded one contributes seg+1.
  assert(verts.length === 3 + (seg + 1), 'a square corner is one point, a rounded one is an arc')
  assert(hasVertexNear(verts, 10, 0) && hasVertexNear(verts, 10, -10) && hasVertexNear(verts, 0, -10), 'the three square corners are still sharp')
  assert(!hasVertexNear(verts, 0, 0), 'and the top-left one is not')
  assert(hasVertexNear(verts, 2, 0) && hasVertexNear(verts, 0, -2), 'its arc meets the two edges at the tangent points')
}

// --- oversized radii scale down together, keeping their proportions ---
{
  // 40 + 40 across a 40-wide edge: everything halves. Asked for 2:1 between the two top
  // corners, so the fitted radii must still be 2:1 - the shape of the rounding survives.
  const seg = 6
  const rect = new Rect({ width: 40, height: 40, cornerRadius: [40, 20, 0, 0], cornerSegments: seg })
  const { verts } = capture(rect)
  // Fitted: scale = min(40/(40+20), 40/(20+0), 40/(0+40)) = 2/3 (edges with no radius on
  // either end impose no limit).
  // So tl = 40*2/3 and tr = 20*2/3, still exactly 2:1.
  const tl = 40 * (2 / 3)
  const tr = 20 * (2 / 3)
  assert(hasVertexNear(verts, tl, 0, 1e-9), 'the top-left arc meets the top edge at the scaled radius')
  assert(hasVertexNear(verts, 40 - tr, 0, 1e-9), 'and the top-right arc at half of it, as asked')
  assert(near(tl / tr, 2), 'the two radii keep the 2:1 ratio they were given')
}

// --- the stroke follows the rounded outline, not the square one ---
{
  const seg = 4
  const r = 2
  const sw = 0.5
  const rect = new Rect({ width: 12, height: 12, cornerRadius: r, cornerSegments: seg, strokeWidth: sw })
  const { verts } = capture(rect)
  const stroke = verts.filter((v) => !v.isFill)
  assert(stroke.length > 0, 'a rounded rect strokes its outline')
  // The corner the stroke rides is an arc, so its outer edge sits at r + sw/2 from the arc
  // centre - not out at the square corner a miter join would have reached.
  const centre = { x: r, y: -r }
  const nearCorner = stroke.filter((v) => v.x < r && v.y > -r)
  assert(nearCorner.length > 0, 'some stroke geometry lies over the rounded corner')
  const dists = nearCorner.map((v) => Math.hypot(v.x - centre.x, v.y - centre.y))
  // The arc is a polyline, so its miter-joined outer edge is the offset POLYGON, which
  // stands off the true offset circle by 1/cos(half the segment turn) - the same faceting
  // a circle's rim has. The inner side needs no such correction and lands exactly.
  const miter = 1 / Math.cos(Math.PI / 2 / seg / 2)
  assert(near(Math.max(...dists), r + (sw / 2) * miter, 1e-9), 'the outer stroke edge is the arc offset by half the stroke width, mitered')
  assert(near(Math.min(...dists), r - sw / 2, 1e-9), 'and the inner edge is exactly that much inside the arc')
  assert(!hasVertexNear(stroke, -sw / 2, sw / 2), 'the square outer miter corner is not emitted')
}

// --- cornerRadius is geometry: changing it invalidates the cache and bumps the lane epoch ---
{
  const rect = new Rect({ width: 10, height: 10 })
  assert(capture(rect).verts.length === 4, 'square to start with')
  rect.cornerRadius = 3
  rect.cornerSegments = 2
  rect.markGeometryDirty()
  assert(capture(rect).verts.length === 4 * 3, 'after markGeometryDirty() the arcs are there')
  assert(rect.attrs.cornerRadius === 3, 'cornerRadius is an exposed attribute')
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
  // The rectangle's top-right corner is at (width, 0) in its own frame; with no scale or
  // offset in play, the matrix should do nothing to it but translate.
  const p = world.transformPoint(new Vector3(10, 0, 0))
  assert(near(p.x, 15) && near(p.y, -3), 'no scale: corner offset is unscaled (10,0)->(15,-3)')
}

// --- scaleX/scaleY scale local geometry about the shape's own local origin ---
{
  const rect = new Rect({ x: 100, y: 50, width: 10, height: 10, scaleX: 2, scaleY: 3 })
  const world = rect.worldMatrix()
  // The bottom-right corner is at (10,-10) in the rectangle's own frame; scaling takes it
  // to (20,-30), and the position then translates it.
  const p = world.transformPoint(new Vector3(10, -10, 0))
  assert(near(p.x, 120) && near(p.y, 20), 'scaleX/scaleY scale local geometry independently')
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
  const rect = centredRect({ fill: [0.5, 0.5, 0.5, 1] })
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
  const rect = centredRect()
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

// --- shadow atlas sizing: driven only by things a transform cannot change ---
{
  // Canvas 2D defines shadowBlur as a Gaussian of sigma = blur/2, padded to 3 sigma.
  assert(shadowSigma(10) === 5, 'shadowBlur maps to sigma = blur/2, the canvas rule')
  assert(shadowSigma(-4) === 0, 'a negative blur clamps to none')
  assert(blurMarginUnits(10) === 15, 'the blur margin is 3 sigma')

  // A small shape keeps 1 texel per local unit, and the margin lands on both sides.
  const small = shadowRegion(40, 20, 10, 0, 256)
  assert(small.texelsPerUnit === 1, 'a small shape bakes at full resolution')
  assert(small.padTexels === 15, 'the padding is 3 sigma, in texels')
  assert(small.width === 40 + 30 && small.height === 20 + 30, 'the slot is the silhouette plus a margin on each side')

  // A shape too big for the cap scales down INSTEAD of overflowing - and the padding
  // scales with it, rather than being added on top of an already-maxed silhouette.
  const huge = shadowRegion(4000, 4000, 40, 0, 256)
  assert(huge.texelsPerUnit < 1, 'a huge shape bakes at reduced resolution')
  assert(huge.width <= 256 && huge.height <= 256, 'and still fits the cap')
  assert(huge.padTexels >= 1, 'it keeps a blur margin even when scaled down')

  // The slot must NEVER exceed the cap, and the silhouette must never be cropped to make
  // it fit - the margin is symmetric and the shape whole, at whatever resolution that
  // takes. Rounding the two parts up separately is what makes this worth asserting over a
  // spread of awkward sizes rather than one tidy case.
  for (const [bw, bh, blur, spread] of [
    [206, 136, 24, 0],
    [255, 255, 1, 0],
    [256, 256, 0, 0],
    [1, 1, 90, 0],
    [4000, 10, 40, 0],
    [37, 611, 13, 0],
    [206, 136, 24, 30],
    [40, 40, 0, 100],
    [200, 200, 20, -15],
    [4000, 4000, 40, 200],
  ] as const) {
    const r = shadowRegion(bw, bh, blur, spread, 256)
    assert(r.width <= 256 && r.height <= 256, `slot ${bw}x${bh} blur ${blur} spread ${spread} fits the cap`)
    assert(
      r.width === Math.ceil(bw * r.texelsPerUnit) + 2 * r.padTexels &&
        r.height === Math.ceil(bh * r.texelsPerUnit) + 2 * r.padTexels,
      `slot ${bw}x${bh} blur ${blur} spread ${spread} keeps the full silhouette and a symmetric margin`,
    )
  }

  // --- spread (the CSS box-shadow extension) reserves its own room, outward only ---
  assert(shadowMarginUnits(10, 0) === 15, 'with no spread the margin is just the blur reach')
  assert(shadowMarginUnits(10, 6) === 21, 'a positive spread adds to the margin')
  assert(shadowMarginUnits(10, -6) === 15, 'a negative spread never grows the margin - it erodes inward')
  assert(shadowMarginUnits(0, 8) === 8, 'spread alone still reserves room, so a crisp halo is not clipped')

  const spreadOut = shadowRegion(40, 20, 0, 8, 256)
  assert(spreadOut.padTexels === 8 && spreadOut.width === 40 + 16, 'a pure spread grows the slot by itself')
  const spreadIn = shadowRegion(40, 20, 0, -8, 256)
  assert(spreadIn.padTexels === 0 && spreadIn.width === 40, 'an inward spread leaves the slot at the silhouette size')

  // Zero blur still yields a usable slot (a hard-edged, offset-only shadow).
  const crisp = shadowRegion(10, 10, 0, 0, 256)
  assert(crisp.padTexels === 0 && crisp.width === 10 && crisp.height === 10, 'no blur means no margin')

  // The quad must cover exactly what the slot covers, or the texture would be stretched.
  const quad = shadowQuadBounds(-20, -10, small)
  assert(quad.x1 - quad.x0 === small.width / small.texelsPerUnit, 'the quad spans the slot exactly in x')
  assert(quad.y1 - quad.y0 === small.height / small.texelsPerUnit, 'the quad spans the slot exactly in y')
  assert(quad.x0 === -35 && quad.y0 === -25, 'the quad starts a full margin before the silhouette')

  // Canvas offset semantics: scaled by absolute scale, downward-positive, and NOT
  // turned by rotation (that is what worldAxisScale extracts - lengths, not direction).
  const offset = shadowWorldOffset(4, 6, 2, 3)
  assert(offset.x === 8, 'offsetX scales with the absolute x scale')
  assert(offset.y === -18, 'offsetY is downward-positive, so it flips against a y-up scene')

  // A 90-degree rotation matrix: the axes have swapped direction but each is still unit
  // length, so the offset keeps its magnitude and stays world-axis aligned.
  const rotated = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const scale = worldAxisScale(rotated)
  assert(Math.abs(scale.x - 1) < 1e-9 && Math.abs(scale.y - 1) < 1e-9, 'pure rotation contributes no scale')
  const scaled = worldAxisScale([3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  assert(scaled.x === 3 && scaled.y === 5, 'axis lengths recover the absolute scale')
}

// --- slot reuse is deterministic: a swept parameter must reach a steady state ---
{
  assert(slotBucket(1, 256) === SLOT_GRANULARITY, 'a tiny region still reserves a whole grid cell')
  assert(slotBucket(32, 256) === 32, 'an exact multiple reserves itself')
  assert(slotBucket(33, 256) === 64, 'anything over rounds up to the next cell')
  assert(slotBucket(250, 256) === 256 && slotBucket(256, 256) === 256, 'the top cell is the cap, not past it')
  for (const n of [1, 7, 31, 32, 33, 100, 200, 255, 256]) {
    assert(slotBucket(n, 256) >= n, `a reservation is never smaller than the region (${n})`)
  }

  // Replay the atlas's own reuse rule over a blur sweep. The shape is card-sized, which puts
  // it right in the range where the region size wobbles against the cap - the case that used
  // to reallocate on a SHRINKING blur, because an exact-fit reservation could be missed by a
  // single texel of rounding noise.
  const sweepReallocations = (sizes: readonly number[], granular: boolean) => {
    let allocW = 0
    let allocH = 0
    let count = 0
    for (const blur of sizes) {
      const region = shadowRegion(260, 180, blur, 0, 256)
      if (allocW >= region.width && allocH >= region.height) continue
      allocW = granular ? slotBucket(region.width, 256) : region.width
      allocH = granular ? slotBucket(region.height, 256) : region.height
      count++
    }
    return count
  }

  const up = Array.from({ length: 41 }, (_, i) => i * 2) // 0..80
  const down = [...up].reverse()
  const sweep = [...up, ...down]

  // The property that matters: reallocation count is bounded by how many distinct grid cells
  // the region passes through, NOT by how many steps the slider takes. Without the grid, an
  // exact fit reallocates far more often over the same sweep.
  const granular = sweepReallocations(sweep, true)
  const exact = sweepReallocations(sweep, false)
  assert(granular < exact, 'reserving on a grid reallocates less often than fitting exactly')
  assert(granular <= 256 / SLOT_GRANULARITY, 'and never more often than there are grid cells to climb')

  // Steady state: once swept, sweeping again must reallocate NOTHING. This is the
  // determinism the reuse rule is for - a slider dragged back and forth stops churning.
  let allocW = 0
  let allocH = 0
  const run = (blurs: readonly number[]) => {
    let count = 0
    for (const blur of blurs) {
      const region = shadowRegion(260, 180, blur, 0, 256)
      if (allocW >= region.width && allocH >= region.height) continue
      allocW = slotBucket(region.width, 256)
      allocH = slotBucket(region.height, 256)
      count++
    }
    return count
  }
  run(sweep)
  assert(run(sweep) === 0, 'a second identical sweep reallocates nothing at all')
  assert(run([...sweep].reverse()) === 0, 'nor does sweeping it in the opposite order')

  // Specifically the reported case: blur 60 then 55 must keep the same reservation, even
  // though 55 asks for a marginally WIDER region than 60 did.
  const wide = shadowRegion(260, 180, 60, 0, 256)
  const narrower = shadowRegion(260, 180, 55, 0, 256)
  const reserved = slotBucket(wide.width, 256)
  assert(reserved >= narrower.width, 'a reservation made at blur 60 still holds blur 55')
}

// --- shadow vertex/object formats line up with the WGSL structs ---
{
  // The vertex carries a unit-square CORNER and an object id, nothing else: the quad's real
  // bounds and its atlas uv both come from the per-object record, because both describe the
  // shape's atlas slot and a slot can be re-baked into a different rectangle at any time.
  // Geometry that cached them would have no moment at which to notice it had gone stale.
  assert(SHADOW_VERTEX_STRIDE === 12, 'shadow vertex is a corner plus an object id')
  assert(SHADOW_VERTEX_LAYOUT.arrayStride === SHADOW_VERTEX_STRIDE, 'the layout agrees with the stride')
  const attrs = [...SHADOW_VERTEX_LAYOUT.attributes]
  assert(attrs.length === 2, 'two vertex attributes - no uv among them')
  assert(attrs[1].offset === 8 && attrs[1].format === 'uint32', 'the object id trails the corner')
  // std430: a struct containing a mat4x4/vec4 aligns to 16, so the record must round up.
  assert(SHADOW_OBJECT_STRIDE % 16 === 0, 'the shadow object record keeps 16-byte alignment')
  assert(
    SHADOW_OBJECT_QUAD_OFFSET % 16 === 0 && SHADOW_OBJECT_UV_OFFSET % 16 === 0,
    'the quad and uv vec4s sit on their required 16-byte boundaries',
  )
  assert(
    SHADOW_OBJECT_STRIDE >= SHADOW_OBJECT_DEPTH_OFFSET + 4,
    'the record holds a mat4x4, a tint, the slot quad + uv, and a depth',
  )
}

// --- the draw order that makes transparency work across lanes --------------------------
//
// Lanes used to draw one after another, which made stacking depend on which lane a thing
// was in: a translucent shape writes depth like any other fragment, so anything behind it
// in a later-drawn lane was rejected instead of showing through. buildDrawRuns merges the
// lanes into one furthest-first sequence, so every fragment lands over what is behind it.
{
  // Stand-ins for the three lanes. Only their identity and their depth matter here; the
  // merge never looks at geometry.
  const mesh = (n: number) => new Rect({ name: `m${n}`, width: 1, height: 1 })
  const text = (n: number) => new Text({ name: `t${n}`, text: 'x' })
  // An Image needs a GPU texture to construct, and the merge never touches one - it reads
  // nothing but each node's depth - so a plain Shape stands in for the image lane here.

  /** Builds a scene-wide order and hands back what buildDrawRuns makes of it. */
  const runsFor = (kinds: ('mesh' | 'text' | 'image')[]) => {
    const meshes: Shape[] = []
    const texts: Shape[] = []
    const images: Shape[] = []
    const depths = new Map<Shape, number>()
    const meshDepths: number[] = []
    kinds.forEach((kind, rank) => {
      // Rank 0 is furthest back and carries the LARGEST depth - the same relationship
      // depthForRank produces.
      const depth = depthForRank(rank, kinds.length)
      if (kind === 'mesh') {
        const s = mesh(rank)
        meshes.push(s)
        meshDepths.push(depth)
        depths.set(s, depth)
      } else if (kind === 'text') {
        const s = text(rank)
        texts.push(s)
        depths.set(s, depth)
      } else {
        const s = mesh(rank)
        images.push(s)
        depths.set(s, depth)
      }
    })
    return buildDrawRuns(meshes, meshes.length, meshDepths, texts, images, depths)
  }

  // A scene of one kind is still one draw, which is what keeps the stress tests unaffected.
  const allMesh = runsFor(['mesh', 'mesh', 'mesh', 'mesh', 'mesh'])
  assert(allMesh.length === 1, 'a scene of one lane is a single run')
  assert(allMesh[0].lane === 'mesh' && allMesh[0].from === 0 && allMesh[0].to === 5, 'covering all of it')

  // The ordinary case: a background, then content, then text over the top.
  const layered = runsFor(['image', 'mesh', 'mesh', 'text', 'text'])
  assert(layered.length === 3, 'a background, some shapes and text over them is three runs')
  assert(layered.map((r) => r.lane).join(',') === 'image,mesh,text', 'in the order they are stacked, furthest first')
  assert(layered[1].from === 0 && layered[1].to === 2, "each run indexes its own lane's list")

  // The whole point: a run boundary happens at every lane CHANGE, so an alternating scene
  // costs one draw per object - and gets the right answer, which it did not before.
  const alternating = runsFor(['mesh', 'text', 'mesh', 'text', 'mesh'])
  assert(alternating.length === 5, 'a scene that alternates lanes pays one draw per object')
  assert(alternating.map((r) => r.lane).join(',') === 'mesh,text,mesh,text,mesh', 'never reordered into lane batches')
  assert(alternating[2].from === 1 && alternating[2].to === 2, 'the second mesh run picks up where the first left off')

  // Every object appears exactly once, and the runs put them back in rank order. This is
  // the property everything else rests on: reordering or dropping one would show up as a
  // shape drawn at the wrong moment, which is exactly the bug being fixed.
  for (const kinds of [
    ['mesh', 'text', 'image', 'mesh', 'text', 'image'],
    ['text', 'text', 'image', 'image', 'mesh', 'mesh'],
    ['image'],
    ['text', 'mesh'],
  ] as ('mesh' | 'text' | 'image')[][]) {
    const runs = runsFor(kinds)
    const replayed: string[] = []
    const next = { mesh: 0, text: 0, image: 0 }
    for (const run of runs) {
      assert(run.from === next[run.lane], `${kinds.join('/')}: runs of a lane are contiguous and in order`)
      for (let i = run.from; i < run.to; i++) replayed.push(run.lane)
      next[run.lane] = run.to
    }
    assert(replayed.join(',') === kinds.join(','), `${kinds.join('/')}: the runs replay the scene order exactly`)
  }

  // Nothing in, nothing out.
  assert(buildDrawRuns([], 0, [], [], [], new Map()).length === 0, 'an empty scene draws nothing')

  // Overlays are excluded by passing a mesh count short of the list: they are a tail past
  // overlayStart and draw last of all, with depth off.
  const withOverlayTail = (() => {
    const a = new Rect({ width: 1, height: 1 })
    const b = new Rect({ width: 1, height: 1 })
    const overlay = new Rect({ width: 1, height: 1, overlay: true })
    const depths = new Map<Shape, number>([
      [a, 0.9],
      [b, 0.8],
      [overlay, 0.1],
    ])
    return buildDrawRuns([a, b, overlay], 2, [0.9, 0.8, 0.1], [], [], depths)
  })()
  assert(withOverlayTail.length === 1 && withOverlayTail[0].to === 2, 'the overlay tail is left out of the interleaved order')
}

console.log(`[render] self-test passed (${count} assertions)`)
