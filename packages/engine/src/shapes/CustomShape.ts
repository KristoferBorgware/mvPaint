// CustomShape - a shape whose outline you write, rather than one the engine already knows.
//
// Subclass it and implement describe(), drawing the contour into the context you are handed:
//
//   class Arrow extends CustomShape {
//     constructor(private readonly span: number) { super({ fill: 'crimson' }) }
//     protected describe(ctx: ShapeContext): void {
//       ctx.moveTo(0, 0)
//       ctx.lineTo(this.span, 0)
//       ctx.lineTo(this.span - 20, 14)
//       ctx.closePath()
//       ctx.fill()
//     }
//   }
//
// That is the whole of the contract. Everything a built-in shape gets, this gets too, and
// for the same reason - it all reads the tessellated triangles rather than knowing what
// drew them: picking (a click tests the real outline, not a bounding box), bounds and
// therefore group extents and marquee selection, blurred shadows cast from the actual
// silhouette, object opacity, gradients, and a place in the one scene-wide stacking order
// alongside every other object. A custom shape is not a special case of anything.
//
// WHEN describe() RUNS. Once, lazily, and then not again until the geometry is invalidated -
// not per frame, and not when the shape moves. So it is the right place for real work
// (flattening curves, laying out a pattern, reading the node's own properties), and the
// wrong place for anything that varies per frame: nothing there will be re-read. Change a
// property the outline depends on and call markGeometryDirty() to ask for a fresh run - the
// same call Circle.radius or Polyline.points needs, for the same reason.
//
// NAMING A SUBCLASS FIELD. Node and Shape hand down about fifty accessors - x, y, rotation,
// fill, strokeWidth and the rest. A subclass field of the same name SHADOWS one. The field
// declaration defines an own data property on the instance, and an own property sits in front
// of a prototype accessor for writes as much as for reads. The accessor is untouched, every
// other instance still reaches it, and on this one instance it is unreachable.
//
// That holds for the life of the object rather than for its initial value alone. Later
// assignments - `ring.x = 200`, from a method or a caller - land on the own property as well,
// so the accessor's backing store keeps its default, the epoch bump that tells the renderer
// something moved never happens, and reads report whatever was last written. The shape stays
// where it started and the two views of `x` disagree quietly.
//
// Assignment is not the thing to avoid; declaration is. `this.x = 100` in a constructor, in a
// method, or from a caller all resolve along the prototype chain and run the setter. Declare
// fields for names of your own, and assign for names you inherit:
//
//   class Ring extends CustomShape {
//     private thickness = 4                    // a name of its own: a field is right
//     constructor() { super(); this.x = 100 }  // an inherited accessor: assign through it
//   }
//
// TypeScript reports this as TS2610, so `tsc` catches it. A build that only runs a bundler
// does not typecheck, and neither does JavaScript. Whether a field declaration defines or
// assigns follows the consumer's `useDefineForClassFields`, on by default from target ES2022.
//
// The other half of the API is on the context: see ShapeContext for the path vocabulary, and
// for style(), which gives an individual run of segments its own colour and thickness.

import type { MeshMaterial, MeshSink } from '../render/meshFormat'
import { strokePolyline } from '../render/stroke'
import { Shape, type ShapeOptions } from './Shape'
import { ShapeContext, type ShapeDescription } from './ShapeContext'

export interface CustomShapeOptions extends ShapeOptions {
  /**
   * Maximum distance a flattened curve may stray from the true one, in the shape's local
   * units. Default 0.25. Lower is smoother and costs more triangles; because the outline is
   * built once and then scaled by the transform like any other geometry, a shape meant to be
   * zoomed far in wants a smaller value rather than a rebuild.
   */
  tolerance?: number
}

export abstract class CustomShape extends Shape {
  override readonly nodeName: string = 'CustomShape'

  /** See CustomShapeOptions.tolerance. Changing it needs markGeometryDirty(). */
  tolerance: number

  // The description, not the triangles: Shape caches those separately and asks for them on
  // its own schedule. This exists because materials() has to answer before, and independently
  // of, any tessellation - the batchers count material records in a pass of their own - and
  // running describe() twice to answer twice would be the obvious way to get that wrong.
  private description: ShapeDescription | null = null

  constructor(options: CustomShapeOptions = {}) {
    super(options)
    this.tolerance = options.tolerance ?? 0.25
  }

  protected override attrKeys(): readonly string[] {
    return [...super.attrKeys(), 'tolerance']
  }

  /**
   * Draw this shape's outline into `ctx`. Coordinates are the shape's own local space,
   * y-down, with its origin at (0, 0) - the point that lands wherever x/y put the node.
   *
   * Nothing is drawn until you commit it: build a path, then call ctx.fill(), ctx.stroke()
   * or ctx.fillAndStroke(). A describe() that only builds a path produces an empty shape.
   */
  protected abstract describe(ctx: ShapeContext): void

  override markGeometryDirty(): void {
    this.description = null
    super.markGeometryDirty()
  }

  /**
   * One record per distinct paint the description asked for. Index 0 is the shape itself, so
   * a description that never calls style() has exactly the single material any other shape
   * has, and costs nothing extra to draw.
   */
  override materials(): readonly MeshMaterial[] {
    return this.ensureDescription().materials
  }

  protected override buildGeometry(sink: MeshSink): void {
    // In the order committed, so painter order within the shape is what the description
    // reads like: a later fill() covers an earlier one. Every part shares the node's one
    // depth, and 'less-equal' lets the later draw win the tie.
    for (const op of this.ensureDescription().ops) {
      if (op.kind === 'fill') {
        for (const region of op.regions) {
          const base = region.vertices.map((v) => sink.vertex(v.x, v.y, true, op.material))
          for (let i = 0; i < region.indices.length; i += 3) {
            sink.triangle(base[region.indices[i]], base[region.indices[i + 1]], base[region.indices[i + 2]])
          }
        }
        continue
      }

      // The stroker emits plain fill/stroke vertices and knows nothing about materials, so
      // the material this run is painted in is folded in on the way through.
      strokePolyline(op.points, materialSink(sink, op.material), {
        width: op.width,
        closed: op.closed,
        align: this.strokeAlign,
        join: op.join,
        cap: op.cap,
        miterLimit: op.miterLimit,
        gauge: this.strokeGauge(),
      })
    }
  }

  protected override releaseResources(): void {
    this.description = null
    super.releaseResources()
  }

  private ensureDescription(): ShapeDescription {
    if (!this.description) {
      const ctx = new ShapeContext(this, this.tolerance)
      this.describe(ctx)
      this.description = ctx.finish()
    }
    return this.description
  }
}

/** A view of `sink` that stamps every vertex with one material index. */
function materialSink(sink: MeshSink, material: number): MeshSink {
  return {
    vertex: (x, y, isFill) => sink.vertex(x, y, isFill, material),
    triangle: (a, b, c) => sink.triangle(a, b, c),
  }
}
