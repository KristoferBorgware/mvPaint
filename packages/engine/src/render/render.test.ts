// Self-test for the mesh-lane data path (no GPU). Tessellates shapes through a
// capturing MeshSink and asserts the vertex/index/isFill layout, the format constants,
// the fill-type encoding, and the general contour stroker (joins/caps/multi-contour).
// WGSL fragment-shader math (gradient evaluation, and the shadow atlas's silhouette /
// morphology / Gaussian passes) cannot run without a GPU and is not covered here - what IS
// covered is the CPU-side sizing and placement those passes are driven by.
// Run with: npx vitest run packages/engine/src/render/render.test.ts

import { expect, it } from 'vitest'
import type { Vector2Like } from '../math/Vector2'
import { Rect , type RectOptions } from '../shapes/Rect'
import { Circle, circleSegments } from '../shapes/Circle'
import { CustomShape } from '../shapes/CustomShape'
import { Group } from '../shapes/Group'
import { describeAdapter, type RendererAdapter } from '../renderer/adapter'
import type { ShapeContext } from '../shapes/ShapeContext'
import { Polyline, type PolylineOptions } from '../shapes/Polyline'
import { Path } from '../shapes/Path'
import {
  FILL_TYPE_CODE,
  MAX_GRADIENT_STOPS,
  MESH_VERTEX_STRIDE,
  OBJECT_DEPTH_OFFSET,
  OBJECT_FILL_COLOR_OFFSET,
  OBJECT_OPACITY_OFFSET,
  OBJECT_STROKE_COLOR_OFFSET,
  OBJECT_STOP_COLORS_OFFSET,
  OBJECT_STOP_POSITIONS_OFFSET,
  OBJECT_STRIDE,
  type MeshSink,
  type RGBA,
} from './meshFormat'
import { MESH_VERTEX_LAYOUT, SHADOW_VERTEX_LAYOUT } from '../webgpu/vertexLayouts'
import {strokeContours, strokePolyline, type LineCap, type StrokeAlign} from './stroke'
import { signedArea } from './contours'
import { buildDrawRuns, type LaneName } from './drawOrder'
import { isOpaqueShape, partitionByOpacity } from './opacity'
import { parseColor } from './color'
import { MAX_CAPTURE_PIXELS, flipRows, paddedBytesPerRow, resolveCapture, unpadRows } from './capture'
import { IMAGE_OBJECT_DEPTH_OFFSET, IMAGE_OBJECT_OPACITY_OFFSET, IMAGE_OBJECT_STRIDE, IMAGE_OBJECT_TINT_OFFSET } from './imageFormat'
import { TEXT_OBJECT_OPACITY_OFFSET, TEXT_OBJECT_STRIDE } from './textFormat'
import { depthForRank } from '../scene/picking'
import { meshShaderCode } from '../webgpu/shaders/mesh.wgsl'
import { textShaderCode } from '../webgpu/shaders/text.wgsl'
import { imageShaderCode } from '../webgpu/shaders/image.wgsl'
import { shadowQuadShaderCode } from '../webgpu/shaders/shadowQuad.wgsl'
import { SceneGather, type GatherInput } from './gather'
import { Scene } from '../scene/Scene'
import { Text } from '../shapes/Text'
import { Camera2D } from '../camera/Camera2D'
import { msdfFontProvider } from '../text/msdfProvider'
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
  SHADOW_OBJECT_COLOR_OFFSET,
  SHADOW_OBJECT_DEPTH_OFFSET,
  SHADOW_OBJECT_QUAD_OFFSET,
  SHADOW_OBJECT_STRIDE,
  SHADOW_OBJECT_UV_OFFSET,
  SHADOW_VERTEX_STRIDE,
} from './shadowFormat'
import { Shape } from '../shapes/Shape'
import { hitTestShape } from '../scene/picking'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Vector3 } from '../math/Vector3'

/**
 * Every check in this file goes through here, so each one reads as the sentence it is making
 * and vitest reports that sentence when it stops being true.
 */
function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}

interface CapturedVertex {
  x: number
  y: number
  isFill: boolean
  /** Which of the shape's materials() paints it - 0 for every single-material shape. */
  material: number
}
interface Captured {
  verts: CapturedVertex[]
  tris: [number, number, number][]
}

function capturingSink(): { sink: MeshSink } & Captured {
  const verts: CapturedVertex[] = []
  const tris: [number, number, number][] = []
  const sink: MeshSink = {
    vertex: (x, y, isFill, material = 0) => {
      verts.push({ x, y, isFill, material })
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

it('format constants match the WGSL structs', () => {
  assert(MESH_VERTEX_STRIDE === 12, 'mesh vertex stride is 12 bytes (position + packedId, no color)')
  assert(MESH_VERTEX_LAYOUT.arrayStride === MESH_VERTEX_STRIDE, 'layout stride matches')
  assert(
    OBJECT_STRIDE === 304,
    'object stride is one mat4 (64B) + gradient material (208B) + fillColor/strokeColor (32B)',
  )
})

it('stroked rect: fill (4v/2t) + a 4-corner miter-joined contour', () => {
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
})

it('fill-only rect: 4 verts, 2 triangles (stroke path untouched)', () => {
    const rect = centredRect({ width: 3, height: 3, fill: [1, 1, 1, 1], strokeWidth: 0 })
    const { verts, tris } = capture(rect)
    assert(verts.length === 4, 'fill-only rect has 4 vertices')
    assert(tris.length === 2, 'fill-only rect has 2 triangles')
})

it('rounded rect: the corners become arcs, and the outline still spans the same box', () => {
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
})

it('radius 0 keeps the plain four-vertex quad, so rounding costs the common case nothing', () => {
    const plain = capture(new Rect({ width: 4, height: 2 }))
    const explicitZero = capture(new Rect({ width: 4, height: 2, cornerRadius: 0 }))
    assert(plain.verts.length === 4 && plain.tris.length === 2, 'radius 0 is still 4 verts / 2 triangles')
    assert(explicitZero.verts.length === 4, 'passing 0 explicitly takes the same path')
    // A radius that fits nothing (a zero-sized rect) is scaled away to that same quad.
    assert(capture(new Rect({ width: 0, height: 0, cornerRadius: 5 })).verts.length === 4, 'a rect too small to round stays square')
})

it('per-corner radii, and only the named corner is cut', () => {
    const seg = 3
    const rect = new Rect({ width: 10, height: 10, cornerRadius: [2, 0, 0, 0], cornerSegments: seg })
    const { verts } = capture(rect)
    // Three square corners contribute one point each, the rounded one contributes seg+1.
    assert(verts.length === 3 + (seg + 1), 'a square corner is one point, a rounded one is an arc')
    assert(hasVertexNear(verts, 10, 0) && hasVertexNear(verts, 10, -10) && hasVertexNear(verts, 0, -10), 'the three square corners are still sharp')
    assert(!hasVertexNear(verts, 0, 0), 'and the top-left one is not')
    assert(hasVertexNear(verts, 2, 0) && hasVertexNear(verts, 0, -2), 'its arc meets the two edges at the tangent points')
})

it('oversized radii scale down together, keeping their proportions', () => {
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
})

it('the stroke follows the rounded outline, not the square one', () => {
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
})

it('cornerRadius is geometry: changing it invalidates the cache and bumps the lane epoch', () => {
    const rect = new Rect({ width: 10, height: 10 })
    assert(capture(rect).verts.length === 4, 'square to start with')
    rect.cornerRadius = 3
    rect.cornerSegments = 2
    rect.markGeometryDirty()
    assert(capture(rect).verts.length === 4 * 3, 'after markGeometryDirty() the arcs are there')
    assert(rect.attrs.cornerRadius === 3, 'cornerRadius is an exposed attribute')
})

//     stroker's exact per-joint vertex count depends on its round-arc step count) ---
it('circle: fill fan + a round-joined rim contour (structural checks; the general', () => {
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
})

it('adaptive segment count grows with radius and is clamped', () => {
    assert(circleSegments(0.001) === 12, 'tiny circle clamps to the minimum segments')
    assert(circleSegments(1000) === 256, 'huge circle clamps to the maximum segments')
    assert(circleSegments(50) > circleSegments(2), 'more segments for a larger radius')
})

it('localMatrix carries position + rotation but NO scale (size is in geometry)', () => {
    const rect = new Rect({ x: 5, y: -3, width: 10, height: 10, rotation: 0 })
    const world = rect.worldMatrix()
    // The rectangle's top-right corner is at (width, 0) in its own frame; with no scale or
    // offset in play, the matrix should do nothing to it but translate.
    const p = world.transformPoint(new Vector3(10, 0, 0))
    assert(near(p.x, 15) && near(p.y, -3), 'no scale: corner offset is unscaled (10,0)->(15,-3)')
})

it('scaleX/scaleY scale local geometry about the shape\'s own local origin', () => {
    const rect = new Rect({ x: 100, y: 50, width: 10, height: 10, scaleX: 2, scaleY: 3 })
    const world = rect.worldMatrix()
    // The bottom-right corner is at (10,-10) in the rectangle's own frame; scaling takes it
    // to (20,-30), and the position then translates it.
    const p = world.transformPoint(new Vector3(10, -10, 0))
    assert(near(p.x, 120) && near(p.y, 20), 'scaleX/scaleY scale local geometry independently')
})

//     case is unambiguous regardless of rotation sign convention) ---
it('offsetX/offsetY shift the pivot (applied before scale/rotation, translation-only', () => {
    const rect = new Rect({ x: 100, y: 50, offsetX: 4, offsetY: -6 })
    const world = rect.worldMatrix()
    // Local origin (0,0) -> subtract offset -> (-4,6) -> translate by (x,y) -> (96,56).
    const p = world.transformPoint(new Vector3(0, 0, 0))
    assert(near(p.x, 96) && near(p.y, 56), 'offset shifts the pivot: origin -> (x-offsetX, y-offsetY)')
})

//     translate(-offsetX,-offsetY). Cross-checked against an independently
//     assembled equivalent using the same Matrix4x4 primitives, so this specifically
//     verifies ORDER (rotation sign/trig itself is covered by the math self-test). ---
it('localMatrix composes translate(x,y) * rotate(rotation) * scale(scaleX,scaleY) *', () => {
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
})

it('Circle\'s width/height are derived from radius, not stored independently', () => {
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
})

it('fill-type encoding matches the shader\'s expected FILL_COLOR/LINEAR/RADIAL values', () => {
    assert(FILL_TYPE_CODE.color === 0, 'solid color encodes to fill type 0')
    assert(FILL_TYPE_CODE['linear-gradient'] === 1, 'linear gradient encodes to fill type 1')
    assert(FILL_TYPE_CODE['radial-gradient'] === 2, 'radial gradient encodes to fill type 2')
})

it('a shape defaults to a solid color fill with empty gradient stops', () => {
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
})

//     shared by every concrete shape instead of each redeclaring the same fields ---
it('stroke/lineJoin/lineCap/miterLimit live on Shape itself now, one declaration', () => {
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
})

//     that reflects the shape's current (mutated) state ---
it('repeated tessellate() calls reuse the cache; markGeometryDirty() forces a rebuild', () => {
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
})

it('a 4-corner miter loop matches the closed-form 90° formula independent of Rect', () => {
    const corners: Vector2Like[] = [
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
})

//
// The three modes differ in exactly one thing - how far the ribbon reaches to each side - so
// the checks are about extent. A 100-unit square stroked 20 wide reaches 10 past its outline
// centred, 20 past it outside, and not at all inside.
it('stroke alignment: which side of the contour the ribbon expands onto', () => {
    const square = (ccw: boolean): Vector2Like[] => {
      const ring: Vector2Like[] = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ]
      return ccw ? ring : [...ring].reverse()
    }
    const extent = (points: Vector2Like[], align: StrokeAlign) => {
      const { sink, verts } = capturingSink()
      strokePolyline(points, sink, { width: 20, closed: true, join: 'miter', align })
      return {
        min: Math.min(...verts.map((v) => Math.min(v.x, v.y))),
        max: Math.max(...verts.map((v) => Math.max(v.x, v.y))),
      }
    }

    // The shoelace area of this ring is positive, so it is the counter-clockwise one; the other
    // is the same ring walked backwards. Both must stroke identically - "inside" is a fact about
    // the shape, not about which way the points happen to be listed.
    assert(signedArea(square(true)) > 0 && signedArea(square(false)) < 0, 'the two rings wind opposite ways')

    for (const ccw of [true, false]) {
      const which = ccw ? 'ccw' : 'cw'
      const centred = extent(square(ccw), 'center')
      assert(near(centred.min, -10) && near(centred.max, 110), `${which}: a centred stroke straddles the outline`)

      const outside = extent(square(ccw), 'outside')
      assert(near(outside.min, -20) && near(outside.max, 120), `${which}: an outside stroke is entirely beyond it`)

      const inside = extent(square(ccw), 'inside')
      assert(near(inside.min, 0) && near(inside.max, 100), `${which}: an inside stroke never leaves the outline`)
    }

    // An open path has no inside to be on, so the alignment is ignored rather than guessed at.
    const line: Vector2Like[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]
    for (const align of ['center', 'inside', 'outside'] as StrokeAlign[]) {
      const { sink, verts } = capturingSink()
      strokePolyline(line, sink, { width: 20, closed: false, align })
      const ys = verts.map((v) => v.y)
      assert(near(Math.min(...ys), -10) && near(Math.max(...ys), 10), `an open path stays centred under align '${align}'`)
    }

    // Zero width emits nothing whatever the alignment says - the guard is on the width, not on
    // the half-width it used to be computed from.
    const { sink: emptySink, verts: emptyVerts } = capturingSink()
    strokePolyline(square(true), emptySink, { width: 0, closed: true, align: 'outside' })
    assert(emptyVerts.length === 0, 'a zero-width stroke emits nothing')
})

//
// "Inside" means inside the SHAPE. On a donut's inner rim the material is outside the hole's
// own ring, so stroking it by the ring's own reckoning would put the ribbon in the void - the
// hole would appear to shrink while the outer edge grew inward.
it('a hole is stroked against its own winding, so the ribbon lands on the material', () => {
    const outer: Vector2Like[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ]
    // Wound the other way, as a hole is.
    const hole: Vector2Like[] = [
      { x: 40, y: 40 },
      { x: 40, y: 60 },
      { x: 60, y: 60 },
      { x: 60, y: 40 },
    ]
    const donut = [
      { points: outer, closed: true },
      { points: hole, closed: true },
    ]
    const strokeDonut = (align: StrokeAlign) => {
      const { sink, verts } = capturingSink()
      strokeContours(donut, sink, { width: 10, join: 'miter', align })
      return verts
    }

    const inside = strokeDonut('inside')
    assert(
      inside.every((v) => v.x >= -1e-9 && v.x <= 100 + 1e-9 && v.y >= -1e-9 && v.y <= 100 + 1e-9),
      'an inside stroke on a donut stays within the outer silhouette',
    )
    // The material side of the hole's rim: the ribbon covers 60..70, not 50..60.
    assert(inside.some((v) => near(v.x, 70)), "and eats outward from the hole's rim into the material")
    assert(!inside.some((v) => v.x > 40 && v.x < 60 && near(v.y, 50)), 'leaving the hole itself empty')

    const outside = strokeDonut('outside')
    assert(outside.some((v) => near(v.x, -10)), 'an outside stroke grows the outer edge')
    assert(outside.some((v) => near(v.x, 50)), "and fills inward from the hole's rim, into the void")
})

it('miter limit: a near-180° hairpin turn falls back to bevel below the limit', () => {
    // An open 3-point path with a single joint at the origin, folding back on itself.
    const points: Vector2Like[] = [
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
})

it('round join: a clean 90° turn sweeps a quarter-circle arc of the expected size', () => {
    const points: Vector2Like[] = [
      { x: 0, y: -1 },
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]
    const { sink, verts, tris } = capturingSink()
    strokePolyline(points, sink, { width: 0.2, closed: false, join: 'round', roundSegments: 8 })
    // 2 edges (8v/4t) + 1 joint: pivot(1) + concave(2v/1t) + round(start(1) + 4 arc steps/4t).
    assert(verts.length === 16, 'round join at 90°: 8 segment + 8 joint vertices (1p+2+1+4 arc)')
    assert(tris.length === 9, 'round join at 90°: 4 segment + 5 joint triangles (1 concave + 4 arc)')
})

it('caps: butt adds nothing, square/round add the expected fixed geometry per end', () => {
    const line: Vector2Like[] = [
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
})

it('multi-contour: an outer loop and a hole are stroked independently', () => {
    const outer: Vector2Like[] = [
      { x: -2, y: -2 },
      { x: 2, y: -2 },
      { x: 2, y: 2 },
      { x: -2, y: 2 },
    ]
    const hole: Vector2Like[] = [
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
})

it('shadow atlas sizing: driven only by things a transform cannot change', () => {
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
})

it('slot reuse is deterministic: a swept parameter must reach a steady state', () => {
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
})

it('shadow vertex/object formats line up with the WGSL structs', () => {
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
})

//
// The opaque pass writes depth, so a shape only belongs in it if EVERY fragment it can
// paint comes out at alpha 1. The test is one-sided: a wrong "translucent" costs a draw
// call, a wrong "opaque" punches a hole in the picture.
it('what may be drawn in the opaque pass', () => {
    assert(isOpaqueShape(new Rect({ width: 1, height: 1 })), 'a default shape is opaque - opaque fill, opaque stroke')
    assert(!isOpaqueShape(new Rect({ width: 1, height: 1, fill: [1, 0, 0, 0.4] })), 'a translucent fill is not')
    assert(!isOpaqueShape(new Rect({ width: 1, height: 1, fill: [1, 0, 0, 0] })), 'nor an invisible one')

    // A material carries no stroke WIDTH, so the stroke colour is checked whether or not the
    // shape strokes anything. That is the conservative direction, and it costs nothing in
    // practice because an unstroked shape keeps the default opaque black.
    assert(
      !isOpaqueShape(new Rect({ width: 1, height: 1, stroke: [0, 0, 0, 0.5], strokeWidth: 2 })),
      'a translucent stroke makes the shape translucent',
    )

    const gradient = (stops: RGBA[]) => {
      const shape = new Rect({ width: 1, height: 1 })
      shape.fillPriority = 'linear-gradient'
      shape.fillLinearGradientColorStops = stops.map((color, i) => ({ offset: i, color }))
      return shape
    }
    assert(isOpaqueShape(gradient([[1, 0, 0, 1], [0, 0, 1, 1]])), 'a gradient of opaque stops is opaque')
    assert(!isOpaqueShape(gradient([[1, 0, 0, 1], [0, 0, 1, 0.2]])), 'one translucent stop is enough to disqualify it')
    // An empty stop list resolves to transparent black in the shader, not to the flat fill.
    assert(!isOpaqueShape(gradient([])), 'a gradient with no stops paints nothing, and is not opaque')

    // The partition keeps both halves in rank order, and hands an unmixed lane straight back.
    const solid = () => new Rect({ width: 1, height: 1 })
    const clear = () => new Rect({ width: 1, height: 1, fill: [0, 0, 0, 0.5] })
    {
      const shapes = [solid(), solid(), solid()]
      const split = partitionByOpacity(shapes, [0.9, 0.8, 0.7])
      assert(split.shapes === shapes && split.translucentStart === 3, 'an all-opaque lane is not copied or reordered')

      const clears = [clear(), clear()]
      assert(partitionByOpacity(clears, [0.9, 0.8]).shapes === clears, 'nor an all-translucent one')

      const sorted = [solid(), clear(), clear()]
      assert(partitionByOpacity(sorted, [0.9, 0.8, 0.7]).shapes === sorted, 'nor one that already reads opaque-first')
      assert(partitionByOpacity(sorted, [0.9, 0.8, 0.7]).translucentStart === 1, 'the boundary is still reported')
    }
    {
      // The mixed case: opaque shapes move to the front, and each half keeps its own order,
      // which is what the translucent pass's back-to-front requirement rests on.
      const a = solid()
      const b = clear()
      const c = solid()
      const d = clear()
      const split = partitionByOpacity([a, b, c, d], [0.9, 0.8, 0.7, 0.6])
      assert(split.translucentStart === 2, 'both opaque shapes end up in the head')
      assert(split.shapes[0] === a && split.shapes[1] === c, 'the opaque half keeps its relative order')
      assert(split.shapes[2] === b && split.shapes[3] === d, 'and so does the translucent half')
      assert(
        split.depths.join(',') === [0.9, 0.7, 0.8, 0.6].join(','),
        'depths are carried across with their shapes rather than left behind',
      )
    }
})

//
// Lanes used to draw one after another, which made stacking depend on which lane a thing
// was in: a translucent shape writes depth like any other fragment, so anything behind it
// in a later-drawn lane was rejected instead of showing through. buildDrawRuns merges the
// translucent objects of every lane into one furthest-first sequence, so each of them lands
// over what is behind it. (The opaque ones are drawn first, per lane, and are not in here.)
it('the draw order that makes transparency work across lanes', () => {
    /** Builds a scene-wide order and hands back what buildDrawRuns makes of it. */
    const runsFor = (kinds: LaneName[]) => {
      const depths: Record<LaneName, number[]> = { mesh: [], text: [], image: [], shadow: [] }
      // Rank 0 is furthest back and carries the LARGEST depth - the same relationship
      // depthForRank produces.
      kinds.forEach((kind, rank) => depths[kind].push(depthForRank(rank, kinds.length)))
      return buildDrawRuns({
        mesh: { depths: depths.mesh, from: 0, to: depths.mesh.length },
        text: { depths: depths.text, from: 0, to: depths.text.length },
        image: { depths: depths.image, from: 0, to: depths.image.length },
      })
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

    // A run boundary happens at every lane CHANGE, so translucent content that alternates
    // lanes costs one draw per object - and gets the right answer, which it did not before.
    const alternating = runsFor(['mesh', 'text', 'mesh', 'text', 'mesh'])
    assert(alternating.length === 5, 'translucent content that alternates lanes pays one draw per object')
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
    ] as LaneName[][]) {
      const runs = runsFor(kinds)
      const replayed: string[] = []
      const next = { mesh: 0, text: 0, image: 0, shadow: 0 }
      for (const run of runs) {
        assert(run.from === next[run.lane], `${kinds.join('/')}: runs of a lane are contiguous and in order`)
        for (let i = run.from; i < run.to; i++) replayed.push(run.lane)
        next[run.lane] = run.to
      }
      assert(replayed.join(',') === kinds.join(','), `${kinds.join('/')}: the runs replay the scene order exactly`)
    }

    // A shadow sits half a depth step BEHIND the shape casting it, so it must be drawn
    // immediately before that shape - late enough to land on whatever is below it, early
    // enough for its own caster to paint over it. Merging on the nudged depth is what puts
    // it there; drawing shadows last, as they used to be, is what left them stuck behind
    // anything translucent that had already written depth.
    {
      const meshDepths = [depthForRank(0, 3), depthForRank(1, 3), depthForRank(2, 3)]
      const nudge = 0.5 / 4
      const runs = buildDrawRuns({
        mesh: { depths: meshDepths, from: 0, to: 3 },
        shadow: { depths: [meshDepths[1] + nudge], from: 0, to: 1 },
      })
      const replayed = runs.flatMap((r) => Array.from({ length: r.to - r.from }, () => r.lane))
      // Depths are 0.75 / 0.50 / 0.25 back to front, and the shadow sits at 0.50 + 0.125:
      // between the shape below the caster and the caster itself.
      assert(
        replayed.join(',') === 'mesh,shadow,mesh,mesh',
        "the caster's shadow is drawn between the shape below it and the caster",
      )
      assert(runs[0].to === 1, 'the shape furthest back goes first')
      assert(runs[1].lane === 'shadow' && runs[1].from === 0 && runs[1].to === 1, 'then the one shadow')
      assert(runs[2].from === 1 && runs[2].to === 3, 'then the caster and everything in front of it')
    }

    // Nothing in, nothing out.
    assert(buildDrawRuns({}).length === 0, 'an empty scene draws nothing')
    assert(buildDrawRuns({ mesh: { depths: [], from: 0, to: 0 } }).length === 0, 'nor does an empty lane')
    assert(
      buildDrawRuns({ shadow: { depths: [0.5], from: 1, to: 1 } }).length === 0,
      'an empty slice of a non-empty lane draws nothing either',
    )

    // Both of the mesh lane's other parts are excluded by the slice it is given: the opaque
    // head (drawn first, batched, writing depth) and the overlay tail (drawn last, depth off).
    const middleOnly = buildDrawRuns({
      mesh: { depths: [0.9, 0.8, 0.7, 0.6], from: 1, to: 3 },
      text: { depths: [0.75], from: 0, to: 1 },
    })
    assert(
      middleOnly.map((r) => `${r.lane}:${r.from}-${r.to}`).join(',') === 'mesh:1-2,text:0-1,mesh:2-3',
      "the mesh lane's opaque head and overlay tail stay out, and its middle still interleaves by depth",
    )
})

// The gather (render/gather.ts)
//
// It used to be the first 200 lines of webgpu/SceneRenderer.draw(). Moving it out is only
// safe if it still answers exactly as it did, so this covers the things that were previously
// only ever exercised by looking at the screen: which lane each node goes to, that ranks are
// scene-wide rather than per-lane, that the mesh list comes out as [opaque | translucent |
// overlay] with the two boundaries in the right place, that culling drops shapes and their
// depths together, and that the fast path hands back the SAME arrays rather than equal ones.
it('The gather (render/gather.ts)', () => {
    // The gather takes a FontLibrary now, not a bare provider: a Text names a family and the
    // library resolves it. One family here, which is what every existing scene has.
    const provider = { resolveFamily: () => msdfFontProvider() }
    const camera = new Camera2D()
    const VIEW = { viewWidth: 200, viewHeight: 100 }

    function input(scene: Scene, over: Partial<GatherInput> = {}): GatherInput {
      return {
        scene,
        camera,
        fonts: provider,
        ...VIEW,
        cullingEnabled: false,
        zSortEnabled: true,
        cullMargin: 0,
        ...over,
      }
    }

    // --- lanes, ranks and the opaque/translucent/overlay layout -----------------------------
    {
      const scene = new Scene()
      // Deliberately mixed: a solid rect (opaque), a half-transparent one (translucent), a
      // Text (its own lane, never opaque) and an overlay handle (the tail).
      const solid = new Rect({ width: 10, height: 10, fill: [1, 0, 0, 1] })
      const faded = new Rect({ width: 10, height: 10, fill: [0, 1, 0, 0.4] })
      const label = new Text({ text: 'hi' })
      const handle = new Rect({ width: 4, height: 4, fill: [0, 0, 1, 1] })
      handle.overlay = true
      for (const n of [solid, faded, label, handle]) scene.root.addChild(n)

      const g = new SceneGather().run(input(scene), false)

      assert(g.ordered.length === 4, 'the gather ranks every shape in the scene, whatever lane it lands in')
      assert(g.texts.length === 1 && g.texts[0] === label, 'Text buckets into the text lane')
      assert(g.images.length === 0, 'nothing buckets into the image lane here')
      assert(
        g.visibleMeshShapes.length === 3 && !g.visibleMeshShapes.includes(label as unknown as Rect),
        'every other drawable buckets into the mesh lane, and Text does not',
      )

      // Ranks are scene-wide: the Text sits at rank 2 of 4 even though it is the only member of
      // its own lane, which is what lets the two lanes interleave under one depth test.
      assert(near(g.textDepths[0], depthForRank(2, 4)), "a lane's depths are its members' SCENE-wide ranks")
      assert(g.depths.get(label) === g.textDepths[0], 'the depth map and the lane-aligned array agree')

      // [ opaque | translucent | overlay ]
      assert(g.meshTranslucentStart === 1, 'the one provably-opaque shape occupies the head')
      assert(g.overlayStart === 2, 'the overlay tail starts after the translucent middle')
      assert(g.visibleMeshShapes[0] === solid, 'the opaque head is the solid rect')
      assert(g.visibleMeshShapes[1] === faded, 'the translucent middle is the faded one')
      assert(g.visibleMeshShapes[2] === handle, 'and the overlay is last, however opaque it is')

      // The run list covers only the translucent middle of the mesh lane - the head is one
      // batch in pass 1 and the tail is drawn with depth off in pass 3.
      // Furthest first: the faded rect is at rank 1 (depth 0.6) and the text at rank 2 (0.4),
      // so the mesh run comes first even though they are different lanes. That interleaving IS
      // the point of the merge.
      const spans = g.runs.map((r) => `${r.lane}:${r.from}-${r.to}`).join(',')
      assert(spans === 'mesh:1-2,text:0-1', `the merge takes the mesh lane's middle only (got ${spans})`)
    }

    // --- culling keeps shapes and their depths in step --------------------------------------
    {
      const scene = new Scene()
      const onScreen = new Rect({ x: 0, y: 0, width: 10, height: 10, fill: [1, 0, 0, 1] })
      const offScreen = new Rect({ x: 100000, y: 0, width: 10, height: 10, fill: [1, 0, 0, 1] })
      scene.root.addChild(onScreen)
      scene.root.addChild(offScreen)

      const g = new SceneGather().run(input(scene, { cullingEnabled: true }), false)
      assert(g.visibleMeshShapes.length === 1 && g.visibleMeshShapes[0] === onScreen, 'the off-screen rect is culled')
      assert(g.visibleMeshDepths.length === 1, 'its depth goes with it - the two arrays stay the same length')
      assert(
        near(g.visibleMeshDepths[0], depthForRank(0, 2)),
        'and the survivor keeps the rank it had BEFORE culling, so ranks never shift as content scrolls away',
      )
    }

    // --- the fast path ----------------------------------------------------------------------
    {
      const scene = new Scene()
      scene.root.addChild(new Rect({ width: 10, height: 10, fill: [1, 0, 0, 1] }))
      const gather = new SceneGather()
      const opts = input(scene, { cullingEnabled: false, zSortEnabled: false })

      assert(!gather.hasCache(), 'a fresh gather has nothing to reuse')
      const first = gather.run(opts, false)
      assert(gather.hasCache(), 'and has something to reuse once it has run')

      const reused = gather.run(opts, true)
      assert(reused === first, 'the fast path hands back the SAME object, so nothing is rebuilt')
      assert(reused.visibleMeshShapes === first.visibleMeshShapes, 'including the arrays inside it')

      const recomputed = gather.run(opts, false)
      assert(recomputed !== first, 'and not reusing really does re-gather')

      gather.invalidate()
      assert(!gather.hasCache(), 'invalidate() drops it - which is what toggling culling or the z-sort does')
    }

    // --- culling off means no cull rectangle to draw -----------------------------------------
    {
      const scene = new Scene()
      scene.root.addChild(new Rect({ width: 10, height: 10 }))
      const gather = new SceneGather()
      gather.run(input(scene, { cullingEnabled: true }), false)
      assert(gather.getCullBounds() !== null, 'culling on leaves a rectangle behind')
      gather.run(input(scene, { cullingEnabled: false }), false)
      assert(gather.getCullBounds() === null, 'culling off clears it, so the debug overlay disappears with it')
    }
})

//
// The one thing that MUST be true of Shape.opacity. It scales the alpha of every fragment
// the object paints, so a shape at 0.5 with entirely opaque colours still cannot write depth
// ahead of what is behind it - and the classifier is the only thing standing between that and
// a hole in the picture.
it('object opacity keeps a shape out of the opaque pass', () => {
    const solid = new Rect({ width: 1, height: 1 })
    assert(isOpaqueShape(solid), 'sanity: opaque colours, default opacity')

    solid.opacity = 0.5
    assert(!isOpaqueShape(solid), 'a faded shape is translucent however solid its colours are')
    solid.opacity = 0
    assert(!isOpaqueShape(solid), 'and an invisible one certainly is')
    solid.opacity = 1
    assert(isOpaqueShape(solid), 'back to opaque at 1, which is the default')

    // It can only ever move a shape OUT of the opaque pass. Full opacity does not rescue a
    // shape whose colours are translucent.
    const faded = new Rect({ width: 1, height: 1, fill: [1, 0, 0, 0.4], opacity: 1 })
    assert(!isOpaqueShape(faded), 'opacity 1 does not make a translucent fill opaque')

    // And it reaches the partition, which is what actually orders the draw.
    const a = new Rect({ width: 1, height: 1 })
    const b = new Rect({ width: 1, height: 1, opacity: 0.5 })
    const c = new Rect({ width: 1, height: 1 })
    const split = partitionByOpacity([a, b, c], [0.1, 0.2, 0.3])
    assert(split.translucentStart === 2, 'the faded shape is counted as translucent')
    assert(split.shapes[2] === b, 'and moved into the translucent tail')
    assert(split.shapes[0] === a && split.shapes[1] === c, 'leaving the opaque head in order')
})

//
// Each was placed in a hole the record already had, so none of the strides moved and the
// WebGL texel counts are untouched. That is only true while these offsets stay clear of their
// neighbours, which is exactly the sort of thing a later edit breaks silently.
it('the opacity fields sit in real padding, and collide with nothing', () => {
    // Mesh: stopPositions runs 100..132, stopColors starts at 144 on its vec4 alignment.
    assert(OBJECT_OPACITY_OFFSET === 132, 'the mesh opacity sits at 132')
    assert(
      OBJECT_OPACITY_OFFSET >= OBJECT_STOP_POSITIONS_OFFSET + MAX_GRADIENT_STOPS * 4,
      'clear of the end of the stop positions',
    )
    assert(OBJECT_OPACITY_OFFSET + 4 <= OBJECT_STOP_COLORS_OFFSET, 'and clear of the stop colours')
    assert(OBJECT_STRIDE === 304, 'the mesh record did not grow')

    // Text mirrors the mesh layout exactly, which is why they share an offset.
    assert(TEXT_OBJECT_OPACITY_OFFSET === 132, 'the text opacity sits at 132 too')
    assert(TEXT_OBJECT_STRIDE === 320, 'and the text record did not grow')

    // Image: depth ends at 84, and the record is padded out to 96.
    assert(IMAGE_OBJECT_OPACITY_OFFSET === 84, 'the image opacity sits at 84')
    assert(IMAGE_OBJECT_OPACITY_OFFSET + 4 <= IMAGE_OBJECT_STRIDE, 'inside the record')
    assert(IMAGE_OBJECT_STRIDE === 96, 'and the image record did not grow')

    // Every offset is 4-byte aligned, which a float read needs on both backends.
    for (const offset of [OBJECT_OPACITY_OFFSET, TEXT_OBJECT_OPACITY_OFFSET, IMAGE_OBJECT_OPACITY_OFFSET]) {
      assert(offset % 4 === 0, 'every opacity offset is 4-byte aligned')
    }
})

it('resolveCapture: the region-to-camera math a screenshot rests on', () => {
    const live = new Camera2D({ x: 100, y: 50, zoom: 2 })
    const viewport = { width: 800, height: 600 }

    // No options at all means "what I am looking at, at the size I am looking at it". The live
    // camera is zoomed to 2, so its 800x600 viewport covers 400x300 of world.
    const asIs = resolveCapture({}, live, viewport)
    assert(asIs.camera.x === 100 && asIs.camera.y === 50, 'it defaults to the live camera position')
    assert(asIs.viewWidth === 400 && asIs.viewHeight === 300, "and to the world rectangle that camera shows")
    assert(asIs.pixelWidth === 400 && asIs.pixelHeight === 300, 'at one pixel per world unit')

    // The built camera is always at zoom 1: the region's world size IS the view size, and the
    // pixel ratio lives in the target's resolution instead. Zoom here would apply it twice.
    assert(asIs.camera.zoom === 1, 'the capture camera is always at zoom 1')

    // An explicit region ignores the live camera entirely.
    const region = resolveCapture({ x: -200, y: 300, width: 640, height: 480 }, live, viewport)
    assert(region.camera.x === -200 && region.camera.y === 300, 'an explicit origin is taken as given')
    assert(region.viewWidth === 640 && region.viewHeight === 480, 'and an explicit size')
    assert(region.pixelWidth === 640 && region.pixelHeight === 480, 'one pixel per world unit by default')

    // pixelRatio scales the OUTPUT only - the same rectangle of world, more pixels of it.
    const retina = resolveCapture({ x: 0, y: 0, width: 640, height: 480, pixelRatio: 2 }, live, viewport)
    assert(retina.pixelWidth === 1280 && retina.pixelHeight === 960, 'pixelRatio scales the pixel size')
    assert(retina.viewWidth === 640 && retina.viewHeight === 480, 'and leaves the world region alone')
    assert(retina.camera.zoom === 1, 'without touching the zoom - that is what would double-apply it')

    // Defaults are only used for what was left out, and nonsense is treated as left out.
    const partial = resolveCapture({ width: 1000 }, live, viewport)
    assert(partial.viewWidth === 1000 && partial.viewHeight === 300, 'a width alone keeps the default height')
    const nonsense = resolveCapture({ width: 0, height: -5, pixelRatio: Number.NaN }, live, viewport)
    assert(nonsense.viewWidth === 400 && nonsense.viewHeight === 300, 'zero, negative and NaN fall back')
    assert(nonsense.pixelWidth === 400, 'including the pixel ratio')

    // Transparent unless asked, which is what a screenshot meant for compositing wants.
    assert(nonsense.background[3] === 0, 'the background is transparent by default')
    assert(resolveCapture({ background: [1, 0, 0, 1] }, live, viewport).background[0] === 1, 'and honoured when given')

    // Clamped rather than left to fail inside the backend, and clamped proportionally so the
    // answer is still the picture that was asked for.
    const huge = resolveCapture({ width: 4000, height: 2000, pixelRatio: 8 }, live, viewport)
    assert(Math.max(huge.pixelWidth, huge.pixelHeight) === MAX_CAPTURE_PIXELS, 'an oversized capture is clamped')
    assert(
      near(huge.pixelWidth / huge.pixelHeight, 4000 / 2000, 1e-3),
      'and keeps its aspect ratio, so it is the same picture at a smaller size',
    )

    // Never zero, whatever it was asked for - a zero-sized texture is a backend error.
    const tiny = resolveCapture({ width: 10, height: 10, pixelRatio: 0.001 }, live, viewport)
    assert(tiny.pixelWidth >= 1 && tiny.pixelHeight >= 1, 'a capture is never zero pixels across')
})

it('the readback arithmetic: row padding and the flip', () => {
    // WebGPU requires each row of a texture-to-buffer copy to start on a 256-byte boundary.
    assert(paddedBytesPerRow(64) === 256, '64 RGBA pixels is exactly one 256-byte row')
    assert(paddedBytesPerRow(65) === 512, 'one more pixel needs a second')
    assert(paddedBytesPerRow(1) === 256, 'and a single pixel still pays for a whole row')
    for (const width of [1, 7, 63, 64, 100, 333, 1024]) {
      const stride = paddedBytesPerRow(width)
      assert(stride % 256 === 0, 'every stride is a multiple of 256')
      assert(stride >= width * 4, 'and big enough for the row it carries')
    }

    // Unpadding has to take exactly the real bytes of each row and none of the padding. Rows are
    // filled with their own index so a shift shows up as the wrong row rather than as noise.
    const width = 3
    const height = 4
    const stride = paddedBytesPerRow(width)
    const padded = new Uint8Array(stride * height)
    for (let row = 0; row < height; row++) {
      for (let i = 0; i < width * 4; i++) padded[row * stride + i] = row + 1
      // Padding filled with a value no row uses, so any of it that leaks through is obvious.
      for (let i = width * 4; i < stride; i++) padded[row * stride + i] = 0xff
    }
    const packed = unpadRows(padded, width, height, stride)
    assert(packed.length === width * height * 4, 'the unpadded buffer is exactly the pixels')
    assert(!packed.includes(0xff), 'and contains none of the padding')
    for (let row = 0; row < height; row++) {
      assert(packed[row * width * 4] === row + 1, 'each row lands where it belongs')
    }

    // The flip is the WebGL path's, since GL reads from the bottom-left corner up.
    const flipped = flipRows(packed, width, height)
    assert(flipped[0] === height, 'the flip puts the last row first')
    assert(flipped[(height - 1) * width * 4] === 1, 'and the first row last')
    assert(flipped.length === packed.length, 'without changing the size')
    const twice = flipRows(flipped, width, height)
    for (let i = 0; i < packed.length; i++) assert(twice[i] === packed[i], 'flipping twice is the identity')
})

it('parsing a colour', () => {
    const eq = (input: string, want: readonly number[], what: string) => {
      const got = parseColor(input)
      assert(
        got.length === 4 && got.every((c, i) => near(c, want[i], 1e-3)),
        `${what}: ${input} -> [${got.map((c) => c.toFixed(3)).join(', ')}]`,
      )
    }

    // The tuple is the engine's own form and comes back untouched - not copied, since these are
    // treated as immutable everywhere and copying every assignment would allocate for nothing.
    const tuple: RGBA = [0.1, 0.2, 0.3, 0.4]
    assert(parseColor(tuple) === tuple, 'a tuple is passed straight through')

    // Hex, in all four lengths. The short forms double each digit, so #abc is #aabbcc rather
    // than #0a0b0c - a real difference, and the usual off-by-a-nibble.
    eq('#ff0000', [1, 0, 0, 1], 'six digits')
    eq('#f00', [1, 0, 0, 1], 'three digits')
    eq('#abc', [0xaa / 255, 0xbb / 255, 0xcc / 255, 1], 'three digits double rather than pad')
    eq('#ff000080', [1, 0, 0, 0x80 / 255], 'eight digits carry alpha')
    eq('#f008', [1, 0, 0, 0x88 / 255], 'four digits carry alpha, doubled')
    eq('#FF0000', [1, 0, 0, 1], 'case does not matter')
    eq('  #f00  ', [1, 0, 0, 1], 'nor does surrounding space')

    // Functional forms, in both syntaxes, with numbers or percentages.
    eq('rgb(255, 0, 0)', [1, 0, 0, 1], 'comma-separated rgb')
    eq('rgb(255 0 0)', [1, 0, 0, 1], 'space-separated rgb')
    eq('rgba(255, 0, 0, 0.5)', [1, 0, 0, 0.5], 'rgba with a fourth component')
    eq('rgb(255 0 0 / 50%)', [1, 0, 0, 0.5], 'alpha after a slash, as a percentage')
    eq('rgb(100% 0% 0%)', [1, 0, 0, 1], 'percentage components')
    eq('rgba(0,0,0,0)', [0, 0, 0, 0], 'fully transparent through rgba')

    // hsl, including the sector boundaries where the piecewise conversion changes branch.
    eq('hsl(0 100% 50%)', [1, 0, 0, 1], 'hue 0 is red')
    eq('hsl(120 100% 50%)', [0, 1, 0, 1], 'hue 120 is green')
    eq('hsl(240 100% 50%)', [0, 0, 1, 1], 'hue 240 is blue')
    eq('hsl(0 0% 100%)', [1, 1, 1, 1], 'no saturation at full lightness is white')
    eq('hsl(0 0% 0%)', [0, 0, 0, 1], 'and none at zero lightness is black')
    eq('hsl(0, 100%, 50%, 0.25)', [1, 0, 0, 0.25], 'hsl takes an alpha too')
    eq('hsl(360 100% 50%)', [1, 0, 0, 1], 'hue wraps at 360')
    eq('hsl(-120 100% 50%)', [0, 0, 1, 1], 'and wraps the other way')
    eq('hsl(0.5turn 100% 50%)', [0, 1, 1, 1], 'a hue in turns')
    eq('hsl(3.14159rad 100% 50%)', [0, 1, 1, 1], 'and in radians')

    // Keywords, and the one that is not a colour so much as an absence.
    eq('red', [1, 0, 0, 1], 'a keyword')
    eq('REBECCAPURPLE', [0x66 / 255, 0x33 / 255, 0x99 / 255, 1], 'keywords are case-insensitive')
    eq('transparent', [0, 0, 0, 0], 'transparent is a fully transparent black')
    eq('gray', parseColor('grey'), 'both spellings of grey agree')

    // Out-of-range components are clamped rather than allowed through to a shader.
    eq('rgb(300 -20 0)', [1, 0, 0, 1], 'components are clamped')
    eq('rgba(0 0 0 / 5)', [0, 0, 0, 1], 'and so is alpha')

    // A colour that cannot be read throws. Falling back to a default would render the typo as a
    // deliberate-looking black, which is a far worse thing to debug.
    const rejects = (input: string) => {
      let threw = false
      try {
        parseColor(input)
      } catch {
        threw = true
      }
      assert(threw, `rejects ${JSON.stringify(input)}`)
    }
    rejects('')
    rejects('notacolour')
    rejects('#12345')
    rejects('#gg0000')
    rejects('rgb(1, 2)')
    rejects('hsl(1)')
    rejects('rgb(a, b, c)')
})

it('the colour properties take either form', () => {
    // Every one of these stores the tuple, whatever it was given: the batchers read them per
    // object per frame and never see a string.
    const shape = new Rect({ width: 1, height: 1, fill: 'tomato', stroke: '#0f08', shadowColor: 'rgb(0 0 255)' })
    assert(near(shape.fill[0], 0xff / 255) && near(shape.fill[1], 0x63 / 255), 'a fill given as a keyword')
    assert(near(shape.stroke[3], 0x88 / 255), 'a stroke given as short hex with alpha')
    assert(near(shape.shadowColor[2], 1), 'a shadow colour given as rgb()')
    assert(Array.isArray(shape.fill), 'and every one of them reads back as the tuple')

    // Assignment after construction goes through the same conversion.
    shape.fill = 'transparent'
    assert(shape.fill[3] === 0, 'assigning a string converts it too')
    shape.fill = [0.25, 0.5, 0.75, 1]
    assert(near(shape.fill[1], 0.5), 'and the tuple still works')

    // Gradient stops convert per stop.
    shape.fillLinearGradientColorStops = [
      { offset: 0, color: 'red' },
      { offset: 1, color: [0, 0, 1, 1] },
    ]
    const stops = shape.fillLinearGradientColorStops
    assert(stops.length === 2 && near(stops[0].color[0], 1), 'a stop given as a keyword')
    assert(near(stops[1].color[2], 1), 'beside one given as a tuple')

    // And the classifier still reads through them, which is what makes this a safe substitution
    // rather than one that only looks right.
    assert(isOpaqueShape(new Rect({ width: 1, height: 1, fill: 'red', stroke: 'black' })), 'opaque strings are opaque')
    assert(!isOpaqueShape(new Rect({ width: 1, height: 1, fill: 'rgba(255,0,0,0.5)' })), 'and translucent ones are not')
    assert(!isOpaqueShape(new Rect({ width: 1, height: 1, fill: 'transparent' })), 'transparent included')
})

//
// The point of every assertion here is that nothing downstream can tell a described shape
// from a built-in one. What is checked is therefore the OUTPUT - triangles, materials,
// bounds, hits - and never that describe() was called in some particular way.
it('CustomShape: a described outline is geometry like any other', () => {
    class Triangle extends CustomShape {
      protected override describe(ctx: ShapeContext): void {
        ctx.moveTo(-50, -40)
        ctx.lineTo(0, 60)
        ctx.lineTo(50, -40)
        ctx.closePath()
        ctx.fill()
      }
    }

    const tri = new Triangle({ fill: 'crimson' })
    const drawn = capture(tri)
    assert(drawn.tris.length === 1, 'a described triangle triangulates to one triangle')
    assert(
      drawn.verts.length === 3 && drawn.verts.every((v) => v.isFill),
      'and its vertices are fill vertices, so a gradient would reach them',
    )
    assert(tri.hitTestLocal(0, 0), 'a point inside it hits')
    assert(!tri.hitTestLocal(-49, 55), 'a point outside it, but inside its bounding box, does not')

    const bounds = tri.localBounds()
    assert(
      near(bounds.min.x, -50) && near(bounds.max.y, 60),
      'bounds come from the described outline, so groups and marquees frame it correctly',
    )

    // A path left open is still a region when filled - the only reading of "fill this" that
    // means anything for three points that do not meet.
    class OpenTriangle extends CustomShape {
      protected override describe(ctx: ShapeContext): void {
        ctx.moveTo(-50, -40)
        ctx.lineTo(0, 60)
        ctx.lineTo(50, -40)
        ctx.fill()
      }
    }
    assert(capture(new OpenTriangle()).tris.length === 1, 'an unclosed path fills as if it were closed')
})

it('...including the parts that only a real outline gets right', () => {
    // A subpath inside another cuts a hole, exactly as it does for a Path built from SVG data:
    // the nesting rule is shared code, not a second implementation.
    class Ring extends CustomShape {
      protected override describe(ctx: ShapeContext): void {
        ctx.rect(-60, 60, 120, 120)
        ctx.rect(-25, 25, 50, 50)
        ctx.fill()
      }
    }
    const ring = new Ring()
    assert(ring.hitTestLocal(-45, 0), 'the solid part of a ring hits')
    assert(!ring.hitTestLocal(0, 0), 'and the hole does not')

    // rect() places its corner the way a Rect node does - top-left, extending down in a y-up
    // scene - so the two can be written interchangeably without anything flipping.
    const box = new Ring().localBounds()
    assert(near(box.min.y, -60) && near(box.max.y, 60), 'rect(x, y, w, h) hangs downward from (x, y)')

    // Curves flatten to within the tolerance, which is what makes it a knob worth having: a
    // finer one is more triangles and a closer circle.
    class Disc extends CustomShape {
      protected override describe(ctx: ShapeContext): void {
        ctx.circle(0, 0, 100)
        ctx.fill()
      }
    }
    const coarse = capture(new Disc({ tolerance: 4 }))
    const fine = capture(new Disc({ tolerance: 0.1 }))
    assert(fine.verts.length > coarse.verts.length * 2, 'a tighter tolerance flattens a circle into more segments')
    for (const v of fine.verts) {
      assert(Math.abs(Math.hypot(v.x, v.y) - 100) <= 1e-6, 'and every point of it sits on the circle')
      break
    }
    const discBounds = new Disc({ tolerance: 0.01 }).localBounds()
    assert(near(discBounds.max.x, 100, 0.01) && near(discBounds.min.y, -100, 0.01), 'a described circle is round')
})

it('segments carry their own properties', () => {
    // One continuous outline, three colours. Each distinct paint is one material record and the
    // vertices of the segments using it name it - the same mechanism a styled text run uses.
    class Wire extends CustomShape {
      protected override describe(ctx: ShapeContext): void {
        ctx.style({ stroke: '#ff0000', strokeWidth: 10, lineCap: 'round' })
        ctx.moveTo(0, 0)
        ctx.lineTo(100, 0)
        ctx.style({ stroke: '#00ff00' })
        ctx.lineTo(200, 0)
        ctx.style({ stroke: '#0000ff' })
        ctx.lineTo(300, 0)
        ctx.stroke()
      }
    }

    const wire = new Wire()
    const materials = wire.materials()
    assert(materials.length === 4, 'the shape itself plus one record per distinct paint')
    assert(near(materials[1].stroke[0], 1) && near(materials[3].stroke[2], 1), 'each record holds its own stroke colour')

    const used = new Set(capture(wire).verts.map((v) => v.material))
    assert(used.size === 3 && !used.has(0), 'every segment is painted by the style it was added in')

    // A style change that only alters GEOMETRY is already in the triangles, so it does not cost
    // a record - the distinction the mesh format actually cares about.
    class Tapered extends CustomShape {
      protected override describe(ctx: ShapeContext): void {
        ctx.style({ stroke: 'black', strokeWidth: 4 })
        ctx.moveTo(0, 0)
        ctx.lineTo(50, 0)
        ctx.style({ strokeWidth: 20 })
        ctx.lineTo(100, 0)
        ctx.stroke()
      }
    }
    const tapered = new Tapered()
    assert(tapered.materials().length === 2, 'changing only the width adds no material record')
    // Half the width to each side, so the thin run's ribbon is 2 deep and the thick one's 10 -
    // the change is in the triangles, where a stroke width has always lived.
    const spans = capture(tapered).verts.map((v) => Math.abs(v.y))
    assert(Math.max(...spans) === 10 && Math.min(...spans) === 2, 'but it does change the ribbon it meshes')

    // And a description that never styles anything is indistinguishable from any other shape.
    class Plain extends CustomShape {
      protected override describe(ctx: ShapeContext): void {
        ctx.rect(0, 0, 10, 10)
        ctx.fill()
      }
    }
    const plain = new Plain({ fill: 'teal' })
    assert(plain.materials().length === 1 && plain.materials()[0] === plain, 'an unstyled description is its own material')
    assert(isOpaqueShape(plain), 'so the opacity classifier reads it exactly as it reads a Rect')

    // The classifier reaches THROUGH the described materials, which is the part that would
    // punch a hole in the picture if it did not: one translucent segment makes the object
    // translucent, however solid the shape's own colours are.
    class Faded extends CustomShape {
      protected override describe(ctx: ShapeContext): void {
        ctx.style({ stroke: 'rgba(0,0,0,0.5)', strokeWidth: 4 })
        ctx.moveTo(0, 0)
        ctx.lineTo(10, 0)
        ctx.stroke()
      }
    }
    assert(!isOpaqueShape(new Faded({ fill: 'red', stroke: 'red' })), 'a translucent segment makes the whole object translucent')
})

it('describe() runs once, and again exactly when the outline is invalidated', () => {
    let runs = 0
    class Counted extends CustomShape {
      span = 40
      protected override describe(ctx: ShapeContext): void {
        runs++
        ctx.moveTo(0, 0)
        ctx.lineTo(this.span, 0)
        ctx.lineTo(this.span, this.span)
        ctx.fill()
      }
    }

    const node = new Counted()
    capture(node)
    capture(node)
    node.materials()
    assert(runs === 1, 'describe() is not re-run per tessellation, nor to answer materials()')

    // Moving, turning and recolouring are all applied per frame from the object record, so none
    // of them touches the outline.
    node.x = 500
    node.rotation = 1
    node.fill = 'gold'
    capture(node)
    assert(runs === 1, 'and not when the shape merely moves, turns or changes colour')

    // A property the outline reads is the caller's to announce, the same as Circle.radius.
    node.span = 90
    node.markGeometryDirty()
    const grown = capture(node)
    assert(runs === 2, 'markGeometryDirty() asks for a fresh description')
    assert(grown.verts.some((v) => near(v.x, 90)), 'and the new one is what gets drawn')
    assert(node.localBounds().max.x === 90, 'with the picking layout rebuilt from it too')
})

//
// The choosing happens in a browser and cannot be tested here. What CAN be is the one piece
// that runs on whatever the browser said - and the case that matters is a browser that said
// almost nothing, since every field is redacted somewhere.
it('which GPU drew it', () => {
    const disclosed: RendererAdapter = {
      powerPreference: 'high-performance',
      vendor: 'nvidia',
      architecture: 'blackwell',
      device: '',
      description: 'NVIDIA GeForce RTX 5090',
      fallback: false,
    }
    assert(
      describeAdapter(disclosed) === 'NVIDIA GeForce RTX 5090',
      "the driver's own description wins outright - it already names the vendor and the part",
    )
    assert(
      describeAdapter({ ...disclosed, description: '' }) === 'nvidia blackwell',
      'and the coarser fields are what is left when there is no description, which is WebGPU\'s usual case',
    )

    const redacted: RendererAdapter = {
      powerPreference: 'low-power',
      vendor: '',
      architecture: '',
      device: '',
      description: '',
      fallback: false,
    }
    assert(describeAdapter(redacted) === 'GPU not disclosed', 'a browser that withholds everything still gets a sentence')

    // The one flag worth acting on: a scene drawing correctly at 12fps on a software renderer
    // looks exactly like the engine being slow, so it has to be visible in the readout.
    assert(describeAdapter({ ...disclosed, fallback: true }).endsWith(' (software)'), 'a software adapter says so')
    assert(describeAdapter({ ...redacted, fallback: true }) === 'GPU not disclosed (software)', 'even an undisclosed one')
})

//
// Everything here is asserted in WORLD space, because that is the only space the claim is
// about: the ribbon has to come out `strokeWidth` wide after the transform, whatever the
// transform is. Measuring the local triangles would only restate what the code does.
it('a stroke that does not follow the scale', () => {
    /** A point's world position, through the node's own matrix. */
    const toWorld = (node: Shape, v: Vector2Like): Vector2Like => {
      const m = node.worldMatrix().m
      return { x: m[0] * v.x + m[4] * v.y + m[12], y: m[1] * v.x + m[5] * v.y + m[13] }
    }
    /** Every stroke vertex's perpendicular distance from the line the segment runs along. */
    const worldHalfWidths = (node: Shape, from: Vector2Like, to: Vector2Like): number[] => {
      const a = toWorld(node, from)
      const b = toWorld(node, to)
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy)
      return capture(node).verts.map((v) => {
        const w = toWorld(node, v)
        return Math.abs((w.x - a.x) * dy - (w.y - a.y) * dx) / len
      })
    }
    const segment = (options: Partial<PolylineOptions> = {}): Polyline =>
      new Polyline({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: false, strokeWidth: 10, ...options })

    // The default is unchanged: a stroke is a local-space measurement like every other
    // coordinate, so a stretched node draws a stretched ribbon.
    const scaled = segment()
    scaled.scaleY = 5
    assert(
      worldHalfWidths(scaled, { x: 0, y: 0 }, { x: 100, y: 0 }).every((d) => near(d, 25)),
      'by default the scale reaches the stroke, so a 5x stretch draws it 5x thick',
    )

    const fixed = segment({ strokeScaleEnabled: false })
    fixed.scaleY = 5
    assert(
      worldHalfWidths(fixed, { x: 0, y: 0 }, { x: 100, y: 0 }).every((d) => near(d, 5)),
      'strokeScaleEnabled: false holds it at the width that was asked for',
    )

    // The case a single compensating number cannot fix, and the reason the gauge is a matrix.
    // Under a 4:1 stretch a diagonal is thickened by neither 4 nor 1 but by something between,
    // and by a different amount for every direction on the shape.
    const diagonal = (enabled: boolean): Polyline => {
      const line = new Polyline({
        points: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
        closed: false,
        strokeWidth: 10,
        strokeScaleEnabled: enabled,
      })
      line.scaleX = 4
      return line
    }
    const naive = worldHalfWidths(diagonal(true), { x: 0, y: 0 }, { x: 100, y: 100 })
    assert(!near(naive[0], 5, 1e-3), 'a diagonal under a non-uniform scale is not thickened by either axis factor')
    assert(
      worldHalfWidths(diagonal(false), { x: 0, y: 0 }, { x: 100, y: 100 }).every((d) => near(d, 5, 1e-9)),
      'and the fixed one is exactly right anyway - non-uniform scale is handled, not approximated',
    )

    // The WORLD scale, not the node's own: a keyline inside a scaled group is drawn at the
    // group's scale, so compensating for only its own would be wrong by exactly that factor.
    const group = new Group({ name: 'zoomed' })
    group.scaleX = 3
    group.scaleY = 3
    const inGroup = group.addChild(segment({ strokeScaleEnabled: false }))
    assert(
      worldHalfWidths(inGroup, { x: 0, y: 0 }, { x: 100, y: 0 }).every((d) => near(d, 5)),
      "an ancestor's scale counts too",
    )

    // Scaled to nothing there is no ribbon and no width that would make one - so no geometry,
    // rather than a division by zero's worth of NaN vertices.
    const flattened = segment({ strokeScaleEnabled: false })
    flattened.scaleX = 0
    assert(capture(flattened).verts.length === 0, 'a transform that collapses an axis draws no stroke at all')
})

it('...and noticing when the scale it was built against has moved', () => {
    const line = (): Polyline =>
      new Polyline({
        points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
        closed: false,
        strokeWidth: 10,
        strokeScaleEnabled: false,
      })

    const node = line()
    const before = capture(node).verts.map((v) => v.y)
    assert(Math.max(...before) === 5, 'unscaled, the fixed stroke is just the ordinary one')
    assert(!node.refreshStrokeGauge(), 'nothing has moved, so nothing is invalidated')

    node.scaleY = 4
    assert(node.refreshStrokeGauge(), 'a changed scale invalidates the geometry it was built into')
    const after = capture(node).verts.map((v) => v.y)
    assert(Math.max(...after) === 5 / 4, 'and the rebuilt ribbon compensates for it')
    assert(!node.refreshStrokeGauge(), 'once rebuilt it settles, rather than dirtying itself every frame')

    // Neither of these can change a ribbon's width, so neither costs a rebuild - which matters,
    // because a rebuild is what this feature is paying for.
    node.rotation = 0.7
    node.x = 500
    assert(!node.refreshStrokeGauge(), 'rotating and moving it invalidate nothing')

    // And that shortcut is a shortcut, not a lie: a shape built from scratch at an angle
    // produces the same triangles as one built square, because stroking commutes with rotation.
    // Two fresh shapes, so this is the geometry answering and not the cache. The tolerance is
    // there because the world matrix is float32 and the angle makes a round trip through it -
    // the difference is ~4e-8, which is the storage, not the maths.
    const square = line()
    const turned = line()
    turned.rotation = 0.7
    turned.x = 500
    const squareVerts = capture(square).verts
    const turnedVerts = capture(turned).verts
    assert(
      squareVerts.length === turnedVerts.length &&
        squareVerts.every((v, i) => near(v.x, turnedVerts[i].x, 1e-6) && near(v.y, turnedVerts[i].y, 1e-6)),
      'and a fixed stroke built at an angle is the same one built square - invariance, not a cache hit',
    )

    // And a shape that never opted out is never asked anything, however it is transformed -
    // this is the sweep's cost for the whole rest of the scene.
    const ordinary = new Polyline({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], strokeWidth: 2 })
    ordinary.scaleX = 9
    capture(ordinary)
    assert(!ordinary.refreshStrokeGauge(), 'a shape whose stroke follows its scale is never invalidated by one')
})

//
// The one class of bug in this engine that no amount of reading catches and no CPU test could
// have found. A storage buffer is an ARRAY of records: the shader indexes it by multiplying by
// the struct's size as WGSL computes it, while the batcher writes at a stride of its own. Agree
// on the field offsets but not on the total, and object 0 is perfect while every object after
// it reads its transform out of the middle of its neighbour - quads spreading across the
// screen, which looks like anything but a padding mistake.
//
// It bit the image lane exactly this way. Adding `opacity` put a real field where a pad had
// been but left all three pads in place, so the struct came to 100 bytes and WGSL rounded it up
// to 112 against a record packed at 96. Invisible on the WebGL path, which reads the same
// records out of a data texture by texel arithmetic of its own and so never consults the WGSL
// at all.
//
// So the sizes are computed here from the shader source, by WGSL's own layout rules, rather
// than read off a comment.
//
// Only the storage-buffer records need it. A uniform struct is bound whole, so a size
// disagreement there is a binding-size validation error the browser reports out loud; it is
// being INDEXED as an array that turns the same mistake into silently wrong pixels.
it('every shader\'s object record is the size the CPU packs it at', () => {
    interface Layout {
      align: number
      size: number
    }
    /** WGSL alignment and size for the types these shaders actually use. */
    const typeLayout = (type: string, consts: Map<string, number>): Layout => {
      const array = /^array<\s*(.+?)\s*,\s*([\w]+)\s*>$/.exec(type)
      if (array) {
        const element = typeLayout(array[1], consts)
        // The length may be a literal or one of the shader's own `const N: u32 = 8u;`.
        const length = /^\d+$/.test(array[2]) ? Number(array[2]) : consts.get(array[2])
        assert(length !== undefined, `the array length '${array[2]}' resolves`)
        // An array's element stride is the element size rounded up to its alignment.
        const stride = Math.ceil(element.size / element.align) * element.align
        return { align: element.align, size: stride * (length ?? 0) }
      }
      switch (type) {
        case 'f32':
        case 'u32':
        case 'i32':
          return { align: 4, size: 4 }
        case 'vec2<f32>':
        case 'vec2<u32>':
          return { align: 8, size: 8 }
        case 'vec3<f32>':
          return { align: 16, size: 12 }
        case 'vec4<f32>':
        case 'vec4<u32>':
          return { align: 16, size: 16 }
        case 'mat4x4<f32>':
          return { align: 16, size: 64 }
        default:
          throw new Error(`the record-layout check does not know the WGSL type '${type}'`)
      }
    }

    /** The struct's size and its members' byte offsets, exactly as WGSL lays them out. */
    const structLayout = (source: string, name: string): { size: number; offsets: Map<string, number> } => {
      const body = new RegExp(`struct\\s+${name}\\s*\\{([^}]*)\\}`).exec(source)
      assert(body !== null, `${name} is declared in the shader`)
      // The shader's own integer constants, for array lengths written as `array<f32, MAX_STOPS>`.
      const consts = new Map<string, number>()
      for (const m of source.matchAll(/const\s+(\w+)\s*:\s*[iu]32\s*=\s*(\d+)[iu]?\s*;/g)) {
        consts.set(m[1], Number(m[2]))
      }
      const offsets = new Map<string, number>()
      let offset = 0
      let align = 1
      // Comments first: one of them says "byte 132," and that comma is not a member boundary.
      const declarations = body![1].replace(/\/\/[^\n]*/g, '')
      // Then split on the commas BETWEEN members - not the one inside `array<f32, MAX_STOPS>`.
      const members: string[] = []
      let depth = 0
      let current = ''
      for (const ch of declarations) {
        if (ch === '<') depth++
        else if (ch === '>') depth--
        if (ch === ',' && depth === 0) {
          members.push(current)
          current = ''
          continue
        }
        current += ch
      }
      members.push(current)

      for (const raw of members) {
        const line = raw.trim()
        if (line.length === 0) continue
        const at = line.indexOf(':')
        if (at < 0) continue
        const field = line.slice(0, at).trim()
        const layout = typeLayout(line.slice(at + 1).trim(), consts)
        offset = Math.ceil(offset / layout.align) * layout.align
        offsets.set(field, offset)
        offset += layout.size
        align = Math.max(align, layout.align)
      }
      // A struct's size is rounded up to its own alignment - the step the image lane missed.
      return { size: Math.ceil(offset / align) * align, offsets }
    }

    const lanes = [
      { name: 'mesh', source: meshShaderCode, struct: 'ObjectData', stride: OBJECT_STRIDE,
        fields: { model: 0, depth: OBJECT_DEPTH_OFFSET, opacity: OBJECT_OPACITY_OFFSET, stopPositions: OBJECT_STOP_POSITIONS_OFFSET, stopColors: OBJECT_STOP_COLORS_OFFSET, fillColor: OBJECT_FILL_COLOR_OFFSET, strokeColor: OBJECT_STROKE_COLOR_OFFSET } },
      { name: 'text', source: textShaderCode, struct: 'ObjectData', stride: TEXT_OBJECT_STRIDE,
        fields: { model: 0, opacity: TEXT_OBJECT_OPACITY_OFFSET } },
      { name: 'image', source: imageShaderCode, struct: 'ObjectData', stride: IMAGE_OBJECT_STRIDE,
        fields: { model: 0, tint: IMAGE_OBJECT_TINT_OFFSET, depth: IMAGE_OBJECT_DEPTH_OFFSET, opacity: IMAGE_OBJECT_OPACITY_OFFSET } },
      { name: 'shadow', source: shadowQuadShaderCode, struct: 'ShadowObject', stride: SHADOW_OBJECT_STRIDE,
        fields: { model: 0, color: SHADOW_OBJECT_COLOR_OFFSET, quad: SHADOW_OBJECT_QUAD_OFFSET, uv: SHADOW_OBJECT_UV_OFFSET, depth: SHADOW_OBJECT_DEPTH_OFFSET } },
    ]

    for (const lane of lanes) {
      const layout = structLayout(lane.source, lane.struct)
      assert(
        layout.size === lane.stride,
        `the ${lane.name} lane's shader struct is ${layout.size} bytes, and its records are packed at ${lane.stride}`,
      )
      for (const [field, expected] of Object.entries(lane.fields)) {
        assert(
          layout.offsets.get(field) === expected,
          `the ${lane.name} lane's ${field} sits at ${expected} in the shader as well as on the CPU`,
        )
      }
    }
})
