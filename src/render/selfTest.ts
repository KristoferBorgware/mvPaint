// Self-test for the mesh-lane data path (no GPU). Tessellates rects through a capturing
// MeshSink and asserts the vertex/index/color/objectId layout and the format constants.
// Run with: npx tsx src/render/selfTest.ts

import { Rect } from '../shapes/Rect'
import { MESH_VERTEX_LAYOUT, MESH_VERTEX_STRIDE, OBJECT_STRIDE, type MeshSink, type RGBA } from './meshFormat'
import { Vector3 } from '../math/Vector3'

let count = 0
function assert(cond: boolean, msg: string): void {
  count++
  if (!cond) throw new Error(`[render] self-test FAILED: ${msg}`)
}

interface CapturedVertex {
  x: number
  y: number
  color: RGBA
}

// A capturing sink that records exactly what a shape emits (indices local to the shape).
function capture(shape: Rect): { verts: CapturedVertex[]; tris: [number, number, number][] } {
  const verts: CapturedVertex[] = []
  const tris: [number, number, number][] = []
  const sink: MeshSink = {
    vertex: (x, y, color) => {
      verts.push({ x, y, color })
      return verts.length - 1
    },
    triangle: (a, b, c) => {
      tris.push([a, b, c])
    },
  }
  shape.tessellate(sink)
  return { verts, tris }
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6

// --- format constants match the WGSL structs ---
assert(MESH_VERTEX_STRIDE === 28, 'mesh vertex stride is 28 bytes')
assert(MESH_VERTEX_LAYOUT.arrayStride === MESH_VERTEX_STRIDE, 'layout stride matches')
assert(OBJECT_STRIDE === 64, 'object stride is one mat4 (64B)')

// --- stroked rect: 4 fill verts + 8 stroke verts, 2 + 8 triangles ---
{
  const fill: RGBA = [0.9, 0.2, 0.1, 1]
  const stroke: RGBA = [0, 0, 0, 1]
  const rect = new Rect({ x: 0, y: 0, width: 4, height: 2, fill, stroke, strokeWidth: 0.4 })
  const { verts, tris } = capture(rect)

  assert(verts.length === 12, 'stroked rect has 12 vertices (4 fill + 8 ring)')
  assert(tris.length === 10, 'stroked rect has 10 triangles (2 fill + 8 ring)')

  // Fill verts carry the fill color and sit at (±w/2, ±h/2).
  assert(verts.slice(0, 4).every((v) => v.color === fill), 'first 4 verts are fill-colored')
  assert(near(verts[0].x, -2) && near(verts[0].y, -1), 'fill corner at (-w/2,-h/2)')
  assert(near(verts[2].x, 2) && near(verts[2].y, 1), 'fill corner at (+w/2,+h/2)')

  // Ring verts carry the stroke color; outer corner extends beyond the fill by sw/2.
  assert(verts.slice(4).every((v) => v.color === stroke), 'ring verts are stroke-colored')
  assert(near(verts[4].x, -2.2) && near(verts[4].y, -1.2), 'outer ring corner at edge + sw/2')
}

// --- fill-only rect: 4 verts, 2 triangles ---
{
  const rect = new Rect({ width: 3, height: 3, fill: [1, 1, 1, 1], strokeWidth: 0 })
  const { verts, tris } = capture(rect)
  assert(verts.length === 4, 'fill-only rect has 4 vertices')
  assert(tris.length === 2, 'fill-only rect has 2 triangles')
}

// --- localMatrix carries position + rotation but NO scale (size is in geometry) ---
{
  const rect = new Rect({ x: 5, y: -3, width: 10, height: 10, rotation: 0 })
  const world = rect.worldMatrix()
  // A local corner at (w/2, h/2) = (5,5) maps to center + corner (translation only).
  const p = world.transformPoint(new Vector3(5, 5, 0))
  assert(near(p.x, 10) && near(p.y, 2), 'no scale: corner offset is unscaled (5,5)->(10,2)')
}

console.log(`[render] self-test passed (${count} assertions)`)
