// The WebGL2 path's font families - one GlFontBook each, keyed by name.
//
// Same contract as webgpu/FontLibrary.ts, and deliberately the same shape, so which families a
// scene has and how a missing one resolves does not depend on which render path it got. See
// that file for why a family is a book and what a family change costs.
//
// Simpler here in one respect: WebGL binds a texture to a unit rather than through a bind group
// built against a pipeline's layout, so there is no shared layout object to thread through and
// a book owns everything it needs.

import { GlFontBook } from './GlFontBook'
import { DEFAULT_FONT_FAMILY, type FontFamilies, type FontProvider } from '../text/layout'
import { bumpFontEpoch, bumpTextShapingEpoch } from '../shapes/contentEpoch'
import type { MsdfAtlasSource } from '../text/msdfProvider'

export class GlFontLibrary implements FontFamilies {
  private readonly gl: WebGL2RenderingContext
  private readonly books = new Map<string, GlFontBook>()

  private constructor(gl: WebGL2RenderingContext, fallback: GlFontBook) {
    this.gl = gl
    this.books.set(DEFAULT_FONT_FAMILY, fallback)
  }

  /** Build a library holding one family - the default, from `sources`, or empty if none. */
  static async load(gl: WebGL2RenderingContext, sources?: readonly MsdfAtlasSource[]): Promise<GlFontLibrary> {
    return new GlFontLibrary(gl, await GlFontBook.load(gl, sources))
  }

  /** The book a family name resolves to - the default family for an unknown or absent name. */
  bookFor(family: string | undefined): GlFontBook {
    return (family !== undefined ? this.books.get(family) : undefined) ?? this.books.get(DEFAULT_FONT_FAMILY)!
  }

  resolveFamily(family: string | undefined): FontProvider {
    return this.bookFor(family)
  }

  /** Every family currently loaded, the default included. */
  families(): string[] {
    return [...this.books.keys()]
  }

  /** Load or replace one family's atlases - see webgpu/FontLibrary.ts for the semantics. */
  async setFonts(sources: readonly MsdfAtlasSource[], family: string = DEFAULT_FONT_FAMILY): Promise<void> {
    const existing = this.books.get(family)
    if (existing) {
      await existing.setFonts(sources)
      return
    }
    const book = await GlFontBook.load(this.gl, sources)
    this.books.set(family, book)
    // Nodes naming this family were falling back to the default and cached a layout against it.
    bumpFontEpoch()
    bumpTextShapingEpoch()
  }

  /** The atlases a family currently holds, or an empty list if it is not loaded. */
  sourcesOf(family: string = DEFAULT_FONT_FAMILY): readonly MsdfAtlasSource[] {
    return this.books.get(family)?.sources ?? []
  }

  destroy(): void {
    for (const book of this.books.values()) book.destroy()
    this.books.clear()
  }
}
