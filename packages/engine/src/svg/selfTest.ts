// Self-test for the SVG pipeline (no GPU, no DOM). Exercises the pure stages the loader
// composes: path flattening -> contour/hole classification -> earcut triangulation ->
// CTM baking (matrix), color parsing, shape->path conversion, gradient mapping, and the
// Path shape's tessellation through a capturing MeshSink. The DOM document walk
// (loadSvg.ts, needs a browser DOMParser) is exercised on-screen, not here.
// Run with: npx tsx src/svg/selfTest.ts

import { flattenPathData } from './flattenPath'
import { classifyContours, signedArea, pointInPolygon } from '../render/contours'
import { triangulateGroup } from './triangulate'
import { applyPoint, multiply, parseTransform, scaleFactor, transformContours, IDENTITY } from './matrix'
import { parseColor } from './color'
import { elementToPathData } from './shapeToPath'
import { gradientToFill, type SvgGradient } from './gradient'
import { Path } from '../shapes/Path'
import type { MeshSink, Point2 } from '../render/meshFormat'

let count = 0
function assert(cond: boolean, msg: string): void {
  count++
  if (!cond) throw new Error(`[svg] self-test FAILED: ${msg}`)
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

// Area covered by a triangle list over a shared vertex array (sum of |signed area|).
function trianglesArea(vertices: Point2[], indices: number[]): number {
  let area = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = vertices[indices[i]], b = vertices[indices[i + 1]], c = vertices[indices[i + 2]]
    area += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2
  }
  return area
}

interface CapturedVertex { x: number; y: number; isFill: boolean }
function capturingSink(): { sink: MeshSink; verts: CapturedVertex[]; tris: [number, number, number][] } {
  const verts: CapturedVertex[] = []
  const tris: [number, number, number][] = []
  const sink: MeshSink = {
    vertex: (x, y, isFill) => (verts.push({ x, y, isFill }), verts.length - 1),
    triangle: (a, b, c) => void tris.push([a, b, c]),
  }
  return { sink, verts, tris }
}

// A 100x100 square (CCW-in-SVG) with a 50x50 inner square wound the opposite way (a hole).
const SQUARE_WITH_HOLE = 'M0 0 L100 0 L100 100 L0 100 Z M25 25 L25 75 L75 75 L75 25 Z'

// --- flatten: two closed contours with the expected signed-area signs ---
{
  const contours = flattenPathData(SQUARE_WITH_HOLE)
  assert(contours.length === 2, 'square-with-hole flattens to two contours')
  assert(contours.every((c) => c.closed), 'both contours are closed (ended with Z)')
  assert(contours[0].points.length === 4, 'outer square has 4 corners')
  assert(near(signedArea(contours[0].points), 10000), 'outer signed area is +10000 (CCW)')
  assert(near(signedArea(contours[1].points), -2500), 'inner signed area is -2500 (opposite wind = hole)')
}

// --- classify: one solid group holding one hole ---
{
  const groups = classifyContours(flattenPathData(SQUARE_WITH_HOLE))
  assert(groups.length === 1, 'one solid region')
  assert(groups[0].holes.length === 1, 'that region has exactly one hole')
  assert(Math.abs(signedArea(groups[0].outer)) === 10000, 'the outer ring is the big square')
  assert(Math.abs(signedArea(groups[0].holes[0])) === 2500, 'the hole is the small square')
}

// --- triangulate: covers (outer - hole) area, no triangle centroid inside the hole ---
{
  const group = classifyContours(flattenPathData(SQUARE_WITH_HOLE))[0]
  const { vertices, indices } = triangulateGroup(group)
  assert(indices.length % 3 === 0 && indices.length > 0, 'earcut returns whole triangles')
  assert(near(trianglesArea(vertices, indices), 7500, 1e-3), 'triangulated area equals outer 10000 - hole 2500')
  const hole = group.holes[0]
  let anyInHole = false
  for (let i = 0; i < indices.length; i += 3) {
    const a = vertices[indices[i]], b = vertices[indices[i + 1]], c = vertices[indices[i + 2]]
    const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3
    if (pointInPolygon(cx, cy, hole)) anyInHole = true
  }
  assert(!anyInHole, 'no triangle centroid falls inside the hole')
}

// --- matrix: parseTransform and CTM baking (matrix baked at flatten time) ---
{
  assert(applyPoint([1, 0, 0, 1, 5, -3], 2, 4).x === 7, 'translate applies to x')
  assert(applyPoint([1, 0, 0, 1, 5, -3], 2, 4).y === 1, 'translate applies to y')
  assert(near(scaleFactor([2, 0, 0, 2, 0, 0]), 2), 'uniform scale factor is 2')

  // translate(10,20) scale(2) around a rotate: composition order matches SVG left-to-right.
  const m = parseTransform('translate(10 20) scale(2)')
  const p = applyPoint(m, 3, 4)
  assert(near(p.x, 16) && near(p.y, 28), 'translate(10,20) scale(2): (3,4) -> (16,28)')

  // A 90° rotation of a unit square around origin lands the corner where expected.
  const r = parseTransform('rotate(90)')
  const rp = applyPoint(r, 1, 0)
  assert(near(rp.x, 0) && near(rp.y, 1), 'rotate(90): (1,0) -> (0,1)')

  // Baking a CTM into flattened points (used by the loader) equals transforming afterward.
  const ctm = multiply([1, 0, 0, -1, 0, 100], parseTransform('translate(10 10)'))
  const baked = flattenPathData('M0 0 L10 0 L10 10 Z', { matrix: ctm })
  const post = transformContours(flattenPathData('M0 0 L10 0 L10 10 Z'), ctm)
  assert(baked.length === post.length, 'baked and post-transformed contour counts match')
  assert(
    baked[0].points.every((pt, i) => near(pt.x, post[0].points[i].x) && near(pt.y, post[0].points[i].y)),
    'CTM baked at flatten time equals transforming the flattened points afterward',
  )
}

// --- color: hex/rgb/named/none/transparent ---
{
  assert(JSON.stringify(parseColor('#ff0000')) === JSON.stringify([1, 0, 0, 1]), 'hex #ff0000 -> red')
  const short = parseColor('#f00')!
  assert(near(short[0], 1) && near(short[1], 0) && near(short[2], 0), '#f00 shorthand -> red')
  const half = parseColor('rgba(0,128,255,0.5)')!
  assert(near(half[0], 0) && near(half[1], 128 / 255) && near(half[2], 1) && near(half[3], 0.5), 'rgba parses channels + alpha')
  assert(JSON.stringify(parseColor('white')) === JSON.stringify([1, 1, 1, 1]), 'named white -> [1,1,1,1]')
  assert(parseColor('none') === null, "'none' -> null (no paint)")
  assert(parseColor('transparent')![3] === 0, "'transparent' -> alpha 0")
}

// --- shapeToPath: geometry elements convert to path data ---
{
  const attrs = (m: Record<string, string>) => (name: string) => m[name] ?? null
  assert(elementToPathData('rect', attrs({ x: '1', y: '2', width: '4', height: '3' })) === 'M 1 2 H 5 V 5 H 1 Z', 'plain rect -> path')
  assert(elementToPathData('rect', attrs({ width: '0', height: '3' })) === null, 'zero-size rect -> null')
  const circle = elementToPathData('circle', attrs({ cx: '5', cy: '5', r: '3' }))!
  assert(circle.startsWith('M 2 5 A 3 3') && circle.endsWith('Z'), 'circle -> two-arc closed path')
  const rounded = elementToPathData('rect', attrs({ x: '0', y: '0', width: '10', height: '10', rx: '2' }))!
  assert(rounded.includes('A 2 2'), 'rounded rect uses arcs (svgpath later turns them into cubics)')
  // A rounded rect flattens and triangulates to a slightly-under-100 area (corners cut).
  const rr = triangulateGroup(classifyContours(flattenPathData(rounded))[0])
  const area = trianglesArea(rr.vertices, rr.indices)
  assert(area > 95 && area < 100, 'rounded 10x10 rect fills just under 100 (rounded corners)')
}

// --- gradient: objectBoundingBox linear + radial map into local (bbox) space ---
{
  const bbox = { x: 10, y: 20, width: 100, height: 40 }
  const lg: SvgGradient = {
    type: 'linear', units: 'objectBoundingBox', transform: IDENTITY,
    stops: [{ offset: 0, color: [1, 0, 0, 1] }, { offset: 1, color: [0, 0, 1, 1] }],
    x1: 0, y1: 0, x2: 1, y2: 0,
  }
  const lf = gradientToFill(lg, bbox)
  assert(lf.fillPriority === 'linear-gradient', 'linear gradient stays linear')
  assert(near(lf.start.x, 10) && near(lf.start.y, 20), 'objectBoundingBox (0,0) -> bbox top-left')
  assert(lf.fillPriority === 'linear-gradient' && near(lf.end.x, 110) && near(lf.end.y, 20), '(1,0) -> bbox right edge')
  assert(lf.stops.length === 2 && lf.stops[1].offset === 1, 'stops carried through with offsets')

  const rg: SvgGradient = {
    type: 'radial', units: 'objectBoundingBox', transform: IDENTITY,
    stops: [{ offset: 0, color: [1, 1, 1, 1] }, { offset: 1, color: [0, 0, 0, 1] }],
    cx: 0.5, cy: 0.5, r: 0.5, fx: 0.5, fy: 0.5,
  }
  const rf = gradientToFill(rg, bbox)
  assert(rf.fillPriority === 'radial-gradient', 'radial gradient stays radial')
  if (rf.fillPriority === 'radial-gradient') {
    assert(near(rf.start.x, 60) && near(rf.start.y, 40), 'focal 0.5,0.5 -> bbox center')
    assert(rf.startRadius === 0, 'focal circle has zero radius (two-circle radial)')
    assert(near(rf.end.x, 60) && near(rf.end.y, 40), 'outer circle centered at bbox center')
    assert(rf.endRadius > 0, 'outer radius is positive')
  }
}

// --- Path.tessellate: fill verts marked isFill, stroke verts not, no NaN, filled toggle ---
{
  const filled = new Path({ d: SQUARE_WITH_HOLE, fill: [1, 0, 0, 1], stroke: [0, 0, 0, 1], strokeWidth: 4 })
  const { sink, verts } = capturingSink()
  filled.tessellate(sink)
  const fillVerts = verts.filter((v) => v.isFill)
  const strokeVerts = verts.filter((v) => !v.isFill)
  assert(fillVerts.length > 0, 'fill emits vertices')
  assert(strokeVerts.length > 0, 'stroke emits vertices')
  assert(verts.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y)), 'no NaN/Infinity coordinates')

  // filled=false (SVG fill="none") skips the fill triangles but keeps the stroke.
  const strokeOnly = new Path({ d: SQUARE_WITH_HOLE, filled: false, stroke: [0, 0, 0, 1], strokeWidth: 4 })
  const cap2 = capturingSink()
  strokeOnly.tessellate(cap2.sink)
  assert(cap2.verts.some((v) => !v.isFill), 'stroke-only path still strokes')
  assert(!cap2.verts.some((v) => v.isFill), 'filled=false emits no fill vertices')

  // A curved open subpath (fill=none, stroke) flattens densely and strokes without fill.
  const curve = new Path({ d: 'M0 0 C0 55 45 100 100 100', filled: false, stroke: [0, 0, 0, 1], strokeWidth: 2 })
  const cap3 = capturingSink()
  curve.tessellate(cap3.sink)
  assert(cap3.verts.length > 0, 'open curve strokes')
  assert(!cap3.verts.some((v) => v.isFill), 'open curve has no fill (not closed / filled=false)')
}

console.log(`[svg] self-test passed (${count} assertions)`)
