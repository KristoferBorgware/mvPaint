// VectorText - the same styled text as Text, drawn as real geometry instead of sampled
// distance fields. It shapes its runs with the SAME shaper (text/layout.ts), then replaces
// each glyph's textured quad with the glyph's actual contours: filled by earcut and, where a
// run asks for it, outlined by the shared contour stroker. The result is ordinary mesh-lane
// geometry, so nothing downstream knows this node is text at all.
//
// Because it is a mesh shape, three things come free that Text has to do (or skip) itself:
// hit-testing is per-glyph rather than per-bounding-box, the shadow atlas casts a real
// blurred shadow from the letterforms, and a run's gradient is the mesh lane's own gradient
// rather than a second implementation of one. What it costs is triangles - a glyph is a few
// hundred vertices where the atlas needs four - so this is the path for display text, and
// Text remains the one for a page of body copy. Neither replaces the other; see
// text/VectorFont.ts for the full comparison.
//
// A run's independent styling survives the trip through a lane that paints one object in one
// color because a shape may claim several material records (see Shape.materials()): each
// (run feature, color) combination becomes one, and each vertex names the one that paints it.
// Everything else - shaping, wrapping, alignment, decorations, faux bold/italic, shadows and
// glows - is the shaper's output, identical to what the MSDF lane consumes.
//
// Fonts are supplied per node rather than by the renderer: parsed outlines own no GPU
// resources, so there is nothing for a device to hand out, and an app that never uses this
// path never loads the font files at all (see text/vectorFonts.ts).

import { TextBlock, type TextBlockOptions } from './TextBlock'
import type { MeshMaterial, MeshSink, Point2, RGBA } from '../render/meshFormat'
import { strokeContours, type Contour } from '../render/stroke'
import type { VectorFontBook } from '../text/VectorFont'
import { layoutText, type ShapedText, type TextMaterial, type TextQuad } from '../text/layout'

export interface VectorTextOptions extends TextBlockOptions {
  /** The parsed outlines this node draws from - see loadDefaultVectorFonts(). */
  fonts: VectorFontBook
}

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

export class VectorText extends TextBlock {
  readonly fonts: VectorFontBook

  private shapingCache: ShapingResult | null = null

  constructor(options: VectorTextOptions) {
    super(options)
    this.fonts = options.fonts
    // Round joins by default, unlike every other shape. A letterform has far sharper corners
    // than a rectangle or a hand-drawn path does - the apex of an A, the two of a W - and
    // Shape's default miter (limit 10) grows a spike out of each one. Measured on Inter at
    // 60px: 'AWM' outlined at width 8 is 51.7 units tall with round joins and 78.9 with
    // miter, all of that difference being spikes above the cap height. Nothing stops a
    // caller asking for miter explicitly.
    this.lineJoin = options.lineJoin ?? 'round'
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

  protected override invalidateShaping(): void {
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

      const mesh = this.fonts.fontByIndex(quad.atlasIndex)?.mesh(quad.codePoint)
      if (!mesh || mesh.vertices.length === 0) return

      const source = shaped.materials[quad.material]
      const place = (p: Point2): Point2 => {
        const y = quad.originY + p.y * quad.unitScale
        // Faux italic shears x about the line's baseline, matching the MSDF lane, which
        // applies the same shear to each corner of the glyph's quad.
        return { x: quad.originX + p.x * quad.unitScale + quad.skew * (y - quad.skewPivotY), y }
      }

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
          join: this.lineJoin,
          cap: this.lineCap,
          miterLimit: this.miterLimit,
        })
      }
    })
  }

  private ensureShaping(): ShapingResult {
    if (!this.shapingCache) {
      // Measure exactly the characters in play before shaping - the shaper reads the font's
      // glyph and kerning maps directly, and treats anything missing from them as a space.
      for (const run of this.runsData) this.fonts.prepare(run.style?.fontStyle ?? 'regular', run.text)
      const shaped = layoutText(this.runsData, this.layoutOptions(), this.fonts)

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
  const a = sink.vertex(quad.x0, quad.y0, true, material)
  const b = sink.vertex(quad.x1, quad.y0, true, material)
  const c = sink.vertex(quad.x1, quad.y1, true, material)
  const d = sink.vertex(quad.x0, quad.y1, true, material)
  sink.triangle(a, b, c)
  sink.triangle(a, c, d)
}
