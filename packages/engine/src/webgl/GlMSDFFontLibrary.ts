// The WebGL2 path's MSDF font families - one GlMSDFFontBook each, keyed by name.
//
// Same contract as webgpu/MSDFFontLibrary.ts, and deliberately the same shape, so which families a
// scene has and how a missing one resolves does not depend on which render path it got. See
// that file for why a family is a book and what a family change costs.
//
// Simpler here in one respect: WebGL binds a texture to a unit rather than through a bind group
// built against a pipeline's layout, so there is no shared layout object to thread through and
// a book owns everything it needs.

import { GlMSDFFontBook } from './GlMSDFFontBook'
import { DEFAULT_FONT_FAMILY, type MSDFFontFamilies, type FontProvider } from '../text/layout'
import { bumpFontEpoch, bumpTextShapingEpoch } from '../shapes/contentEpoch'
import { onFontFamilyRegistered, registeredMsdfFamilies, warnUnresolvedFamily } from '../resources/FontRegistry'
import type { MsdfAtlasSource } from '../text/msdfProvider'

export class GlMSDFFontLibrary implements MSDFFontFamilies {
  private readonly gl: WebGL2RenderingContext
  private readonly books = new Map<string, GlMSDFFontBook>()
  /** What an unregistered name resolves to: no atlases, so no glyphs, so nothing drawn. */
  private readonly unresolved: GlMSDFFontBook

  private constructor(gl: WebGL2RenderingContext, initial: GlMSDFFontBook, unresolved: GlMSDFFontBook) {
    this.gl = gl
    this.unresolved = unresolved
    this.books.set(DEFAULT_FONT_FAMILY, initial)
  }

  /** Build a library holding the empty default family, then fill it from the registry. */
  static async load(gl: WebGL2RenderingContext): Promise<GlMSDFFontLibrary> {
    const library = new GlMSDFFontLibrary(gl, await GlMSDFFontBook.load(gl), await GlMSDFFontBook.load(gl))
    await library.followRegistry()
    return library
  }

  private unsubscribe: (() => void) | null = null

  /** See MSDFFontLibrary.followRegistry - the same contract on the fallback path. */
  private async followRegistry(): Promise<void> {
    this.unsubscribe = onFontFamilyRegistered((family, msdf) => this.setMSDFFonts(msdf, family))
    await Promise.all(registeredMsdfFamilies().map(({ family, msdf }) => this.setMSDFFonts(msdf, family)))
  }

  /**
   * The book a family name resolves to. An absent name is the default family - the one a node
   * gets when it does not choose. A name nothing was loaded under resolves to an EMPTY book, so
   * the node draws nothing, and says so once in the console.
   *
   * There is no fallback face, because the engine ships no typeface: falling back would mean
   * drawing in whatever the application happened to load first, under a name that asked for
   * something else.
   */
  bookFor(family: string | undefined): GlMSDFFontBook {
    if (family === undefined) return this.books.get(DEFAULT_FONT_FAMILY)!
    const book = this.books.get(family)
    if (book) return book
    warnUnresolvedFamily(family, 'atlas')
    return this.unresolved
  }

  resolveFamily(family: string | undefined): FontProvider {
    return this.bookFor(family)
  }

  /** Every family currently loaded, the default included. */
  families(): string[] {
    return [...this.books.keys()]
  }

  /** Load or replace one family's atlases - see webgpu/MSDFFontLibrary.ts for the semantics. */
  async setMSDFFonts(sources: readonly MsdfAtlasSource[], family: string = DEFAULT_FONT_FAMILY): Promise<void> {
    const existing = this.books.get(family)
    if (existing) {
      await existing.setMSDFFonts(sources)
      return
    }
    const book = await GlMSDFFontBook.load(this.gl, sources)
    this.books.set(family, book)
    // Nodes naming this family were drawing nothing and cached a layout that said so.
    bumpFontEpoch()
    bumpTextShapingEpoch()
  }

  /** The atlases a family currently holds, or an empty list if it is not loaded. */
  sourcesOf(family: string = DEFAULT_FONT_FAMILY): readonly MsdfAtlasSource[] {
    return this.books.get(family)?.sources ?? []
  }

  destroy(): void {
    // Before the books, so a registration landing mid-teardown is not handed a context that is
    // going away with them.
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const book of this.books.values()) book.destroy()
    this.books.clear()
    this.unresolved.destroy()
  }
}
