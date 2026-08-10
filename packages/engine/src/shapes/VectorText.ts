// VectorText - the same styled text as MSDFText, drawn as real geometry instead of sampled
// distance fields. It shapes its runs with the SAME shaper (text/layout.ts), then replaces
// each glyph's textured quad with the glyph's actual contours: filled by earcut and, where a
// run asks for it, outlined by the shared contour stroker. The result is ordinary mesh-lane
// geometry, so nothing downstream knows this node is text at all.
//
// Because it is a mesh shape, three things come free that MSDFText has to do (or skip) itself:
// hit-testing is per-glyph rather than per-bounding-box, the shadow atlas casts a real
// blurred shadow from the letterforms, and a run's gradient is the mesh lane's own gradient
// rather than a second implementation of one. What it costs is triangles - a glyph is a few
// hundred vertices where the atlas needs four - so this is the path for display text, and
// MSDFText remains the one for a page of body copy. Neither replaces the other; see
// text/vectorGlyphs.ts for the full comparison.
//
// A run's independent styling survives the trip through a lane that paints one object in one
// color because a shape may claim several material records (see Shape.materials()): each
// (run feature, color) combination becomes one, and each vertex names the one that paints it.
// Everything else - shaping, wrapping, alignment, decorations, faux bold/italic, shadows and
// glows - is the shaper's output, identical to what the MSDF lane consumes.
//
// Fonts are supplied per node rather than by the renderer: glyph outlines own no GPU
// resources, so there is nothing for a device to hand out, and the engine ships none of them -
// an app that never uses this path pays nothing for it. Where they come from is the
// application's choice - a polygon atlas it supplies (packages/example-app has this
// repository's, under public/fonts/polygons/),
// or a font file parsed at runtime through @mvpaint/ttf - and this node cannot tell the
// difference (see text/vectorGlyphs.ts).

import type { Vector2Like } from '../math/Vector2'
import { AABB } from '../math/AABB'
import { Vector3 } from '../math/Vector3'
import { Text, type TextOptions } from './Text'
import type {MeshMaterial, MeshSink, RGBA} from '../render/meshFormat'
import { strokeContours, type Contour } from '../render/stroke'
import type { VectorFonts } from '../text/vectorGlyphs'
import { vectorFontsFor, warnUnresolvedFamily } from '../resources/FontRegistry'
import { blockRect, layoutText, type ShapedText, type TextMaterial } from '../text/layout'
import { quadCorner, type TextQuad } from '../text/textQuad'

/** VectorText adds nothing to Text's options; `fontFamily` names the outlines it tessellates. */
export type VectorTextOptions = TextOptions

// Round joins on the dilation ring: a glow or a faux-bold thickening follows the letterform,
// and a mitred corner would grow spikes out of every sharp junction in the outline.
const DILATE_STROKE = { join: 'round', cap: 'round' } as const

/** A material record with everything but the paint left at the mesh lane's defaults. */
function meshMaterialFrom(source: TextMaterial, isGlyph: boolean, color: RGBA): MeshMaterial {
  // Decorations and highlights are flat even inside a gradient run - the same choice the
  // MSDF shader makes, so the two paths render a gradient run's underline identically.
  const gradient = isGlyph && source.fillPriority !== 'color'
  return {
    fillPriority: gradient ? source.fillPriority : 'color',
    fill: color,
    stroke: source.strokeColor,
    fillLinearGradientStartPoint: source.gradientStart,
    fillLinearGradientEndPoint: source.gradientEnd,
    fillLinearGradientColorStops: gradient ? source.stops : [],
    fillRadialGradientStartPoint: source.gradientStart,
    fillRadialGradientStartRadius: source.gradientStartRadius,
    fillRadialGradientEndPoint: source.gradientEnd,
    fillRadialGradientEndRadius: source.gradientEndRadius,
    fillRadialGradientColorStops: gradient ? source.stops : [],
  }
}

/** Everything derived from one shaping pass, invalidated together. */
interface ShapingResult {
  shaped: ShapedText
  materials: MeshMaterial[]
  /** Material index per quad, parallel to `shaped.quads`. */
  quadMaterials: number[]
}

/** What a node with no resolvable family shapes to: nothing, laid out at no size. */
const NOTHING: ShapingResult = {
  shaped: { quads: [], materials: [], width: 0, height: 0, blockX: 0, blockY: 0, lineCount: 0, referenceBaseline: 0 },
  materials: [],
  quadMaterials: [],
}

export class VectorText extends Text {
  override readonly nodeName: string = 'VectorText'

  private shapingCache: ShapingResult | null = null

  constructor(options: VectorTextOptions = {}) {
    super(options)
    // Round joins by default, unlike every other shape. A letterform has far sharper corners
    // than a rectangle or a hand-drawn path does - the apex of an A, the two of a W - and
    // Shape's default miter (limit 10) grows a spike out of each one. Measured on Inter at
    // 60px: 'AWM' outlined at width 8 is 51.7 units tall with round joins and 78.9 with
    // miter, all of that difference being spikes above the cap height. Nothing stops a
    // caller asking for miter explicitly.
    this.lineJoin = options.lineJoin ?? 'round'
  }

  /**
   * The outlines this node draws from, resolved from `fontFamily` through the registry, or
   * undefined when nothing is registered under that name.
   *
   * Read-only and resolved on every access rather than held: a family registered after this node
   * was built has to reach it, and the alternative is every node subscribing to the registry.
   * Resolution is one Map lookup.
   */
  get fonts(): VectorFonts | undefined {
    return this.fontFamily === undefined ? undefined : vectorFontsFor(this.fontFamily)
  }

  /** Shape the runs into quads + materials, cached until the content or layout changes. */
  shaped(): ShapedText {
    return this.ensureShaping().shaped
  }

  /**
   * One record per (run material, color) pair the shaping produced - a run's glyph body, its
   * outline, its highlight and its shadow copy are separately painted parts of one node.
   */
  override materials(): readonly MeshMaterial[] {
    return this.ensureShaping().materials
  }

  /**
   * The block this text was laid out in, together with the glyph geometry in it.
   *
   * Every other Shape measures the triangles it emits, and for a text node that is the ink alone:
   * the blank space `padding` puts around the letters is real layout with nothing in it to
   * tessellate, and a line of x-height letters is shorter than the line it sits on. Both belong
   * to the node, so the block goes in alongside the geometry - which is also what puts a
   * VectorText and an MSDFText on the same footing, since textLocalBounds measures the other one
   * the same way.
   *
   * Not cached here: the geometry half already is (see Shape.localBounds) and the shaping half is
   * a cache hit, so what this adds per call is a union of two boxes.
   */
  override localBounds(): AABB {
    const box = super.localBounds().clone()
    const block = blockRect(this.ensureShaping().shaped)
    if (block) {
      box.encapsulate(new Vector3(block.x, block.y, 0))
      box.encapsulate(new Vector3(block.x + block.width, block.y + block.height, 0))
    }
    return box
  }

  protected override dropShapingCache(): void {
    this.shapingCache = null
    // The geometry IS the shaping here, so anything that re-shapes also re-tessellates.
    // (As with any other geometry change, the renderer still needs its own rebuild - see
    // SceneRendererHandle.markGeometryDirty.)
    this.markGeometryDirty()
  }

  protected override buildGeometry(sink: MeshSink): void {
    const { shaped, quadMaterials } = this.ensureShaping()

    // Quads arrive back-to-front (highlights, shadows, glows, glyph bodies, then rules) and
    // are emitted in that order, so painter order within the node is preserved: every part
    // shares the node's single depth, and 'less-equal' lets the later draw win a tie.
    shaped.quads.forEach((quad, index) => {
      const material = quadMaterials[index]
      if (!quad.isGlyph) {
        emitRect(sink, quad, material)
        return
      }

      const mesh = this.fonts?.fontByIndex(quad.atlasIndex)?.mesh(quad.codePoint)
      if (!mesh || mesh.vertices.length === 0) return

      const source = shaped.materials[quad.material]
      // Every outline point goes through the same corner transform the MSDF lane applies to
      // the glyph's quad - the faux-italic shear, then any curve rotation - so an outline
      // shears and bends exactly as its box does.
      //
      // A font's own units are y-up - an ascender has positive y - and the scene is y-down,
      // so the glyph's y is subtracted from the baseline rather than added to it.
      const place = (p: Vector2Like): Vector2Like =>
        quadCorner(quad, quad.originX + p.x * quad.unitScale, quad.originY - p.y * quad.unitScale)

      // Fill: the cached triangulation, transformed into this instance's place on the line.
      const base = mesh.vertices.map((v) => {
        const p = place(v)
        return sink.vertex(p.x, p.y, true, material)
      })
      for (let i = 0; i < mesh.indices.length; i += 3) {
        sink.triangle(base[mesh.indices[i]], base[mesh.indices[i + 1]], base[mesh.indices[i + 2]])
      }

      const dilate = source?.dilate ?? 0
      const outline = source?.strokeWidth ?? 0
      if (dilate <= 0 && outline <= 0) return

      const contours: Contour[] = mesh.contours.map((contour) => ({
        points: contour.points.map(place),
        closed: contour.closed,
      }))

      // A dilation - faux bold, or a glow's spread - is a ring centred on the outline, so
      // stroking it at twice the radius grows the letterform by exactly that much. It is
      // emitted as FILL, not stroke: it thickens the glyph body and so must take the run's
      // fill (and its gradient), leaving the stroke slot free for a real outline below.
      if (dilate > 0) {
        strokeContours(contours, redirect(sink, material, true), { width: dilate * 2, ...DILATE_STROKE })
      }
      if (outline > 0) {
        strokeContours(contours, redirect(sink, material, false), {
          width: outline,
          // A per-letter outline obeys strokeAlign like any other stroke: inside keeps the
          // letterform's silhouette exactly, outside grows it. The counters of an 'o' or a 'B'
          // are hole rings, and strokeContours puts their ribbon on the material either way.
          align: this.strokeAlign,
          join: this.lineJoin,
          cap: this.lineCap,
          miterLimit: this.miterLimit,
          // A per-letter outline is a stroke and obeys strokeScaleEnabled like any other. The
          // dilation above deliberately does not: a glow or a faux-bold weight is part of the
          // letterform, and holding it at a fixed width while the glyphs grew would make the
          // text change typeface as it scaled.
          gauge: this.strokeGauge(),
        })
      }
    })
  }

  private ensureShaping(): ShapingResult {
    if (!this.shapingCache) {
      const fonts = this.fonts
      if (!fonts) {
        // Nothing is registered under this name, so there are no glyphs to lay out and no shape
        // to fall back to. Said once, in the console, rather than left as text that never appears.
        if (this.fontFamily !== undefined) warnUnresolvedFamily(this.fontFamily, 'outline')
        else warnUnresolvedFamily('(none)', 'outline')
        // Not cached: registering the family later has to take effect, and the epoch bump that
        // announces it only reaches nodes that re-shape.
        return NOTHING
      }
      // Measure exactly the characters in play before shaping - the shaper reads the font's
      // glyph and kerning maps directly, and treats anything missing from them as a space.
      for (const run of this.runsData) fonts.prepare(run.style?.fontStyle ?? 'regular', run.text)
      const shaped = layoutText(this.runsData, this.layoutOptions(), fonts)

      // Intern (run material, color) pairs. The shaper's own materials carry no solid color -
      // in the MSDF lane that rides on the vertices - so a run's body, its highlight and its
      // shadow copy can share one material there and must not here.
      const materials: MeshMaterial[] = []
      const byKey = new Map<string, number>()
      const quadMaterials = shaped.quads.map((quad) => {
        const key = `${quad.material}|${quad.isGlyph ? 1 : 0}|${quad.color.join(',')}`
        let index = byKey.get(key)
        if (index === undefined) {
          index = materials.length
          byKey.set(key, index)
          materials.push(meshMaterialFrom(shaped.materials[quad.material], quad.isGlyph, quad.color))
        }
        return index
      })

      this.shapingCache = { shaped, materials, quadMaterials }
    }
    return this.shapingCache
  }
}

/** A view of `sink` that stamps every vertex with one material and fill flag. */
function redirect(sink: MeshSink, material: number, isFill: boolean): MeshSink {
  return {
    vertex: (x, y) => sink.vertex(x, y, isFill, material),
    triangle: (a, b, c) => sink.triangle(a, b, c),
  }
}

/** A decoration or highlight: the quad itself, with no outline behind it. */
function emitRect(sink: MeshSink, quad: TextQuad, material: number): void {
  const corner = (x: number, y: number): number => {
    const p = quadCorner(quad, x, y)
    return sink.vertex(p.x, p.y, true, material)
  }
  const a = corner(quad.x0, quad.y0)
  const b = corner(quad.x1, quad.y0)
  const c = corner(quad.x1, quad.y1)
  const d = corner(quad.x0, quad.y1)
  sink.triangle(a, b, c)
  sink.triangle(a, c, d)
}
