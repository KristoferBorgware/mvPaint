// The font families a renderer can draw with - one FontBook each, keyed by name.
//
// A FontBook is four styles of ONE typeface in one array texture, which is what lets a
// paragraph mixing regular, bold and italic draw in a single call. A second typeface cannot
// join it: array layers are indexed by STYLE_ORDER, and the text lane binds one texture per
// draw. So a family is a book, and a scene with two families has two books.
//
// WHAT THAT COSTS, precisely: a draw call per family CHANGE along the packed node order, not
// per family and not per node. A scene that draws one family - which is most of them - is
// exactly as cheap as before; one that alternates families node by node pays a bind and a draw
// each time. The text lane splits its own draw ranges (see lanes/TextBatcher.drawRange), so
// none of this reaches the cross-lane merge that keeps shadows behind their casters.
//
// The layout and the sampler are created ONCE here and handed to every book, because the text
// pipeline is built from that layout and a bind group is only usable with the pipeline whose
// layout it was made against.
//
// Resolution never fails. An unknown family - a typo, or an atlas still in flight - falls back
// to the default, so an MSDFText built before its family finished loading draws in the meantime and
// switches over on the next repack. That is deliberate: text vanishing or throwing because a
// network request has not landed yet is a worse failure than text in the wrong face for a
// moment.

import { createAtlasBindGroupLayout } from './layouts'
import { FontBook, createAtlasSampler } from './FontBook'
import { DEFAULT_FONT_FAMILY, type FontFamilies, type FontProvider } from '../text/layout'
import { bumpFontEpoch, bumpTextShapingEpoch } from '../shapes/contentEpoch'
import type { MsdfAtlasSource } from '../text/msdfProvider'

export class FontLibrary implements FontFamilies {
  /** group(2) layout, shared by every family and by the text pipeline built from it. */
  readonly atlasLayout: GPUBindGroupLayout

  private readonly device: GPUDevice
  private readonly sampler: GPUSampler
  private readonly books = new Map<string, FontBook>()

  private constructor(device: GPUDevice, atlasLayout: GPUBindGroupLayout, sampler: GPUSampler, fallback: FontBook) {
    this.device = device
    this.atlasLayout = atlasLayout
    this.sampler = sampler
    this.books.set(DEFAULT_FONT_FAMILY, fallback)
  }

  /**
   * Build a library holding one family - the default, from `sources`, or an empty book if none
   * were given. Either way the family exists, so nothing downstream has to test for its absence.
   * Further families arrive through setFonts() at any point afterwards.
   */
  static async load(device: GPUDevice, sources?: readonly MsdfAtlasSource[]): Promise<FontLibrary> {
    const atlasLayout = createAtlasBindGroupLayout(device, '2d-array')
    const sampler = createAtlasSampler(device)
    const fallback = await FontBook.loadWith(device, atlasLayout, sampler, sources)
    return new FontLibrary(device, atlasLayout, sampler, fallback)
  }

  /** The book a family name resolves to - the default family for an unknown or absent name. */
  bookFor(family: string | undefined): FontBook {
    return (family !== undefined ? this.books.get(family) : undefined) ?? this.books.get(DEFAULT_FONT_FAMILY)!
  }

  resolveFamily(family: string | undefined): FontProvider {
    return this.bookFor(family)
  }

  /** Every family currently loaded, the default included. */
  families(): string[] {
    return [...this.books.keys()]
  }

  /**
   * Load or replace one family's atlases.
   *
   * Replacing the family a node already draws with re-shapes it (FontBook.setFonts bumps the
   * font epoch); ADDING a family does not disturb anything already on screen - except that
   * nodes naming it were falling back to the default and now resolve to the real thing, which
   * the same epoch bump takes care of.
   */
  async setFonts(sources: readonly MsdfAtlasSource[], family: string = DEFAULT_FONT_FAMILY): Promise<void> {
    const existing = this.books.get(family)
    if (existing) {
      await existing.setFonts(sources)
      return
    }
    // A new family: build it before publishing it, so a failed fetch leaves the library exactly
    // as it was rather than holding a half-loaded book that nothing can draw.
    const book = await FontBook.loadWith(this.device, this.atlasLayout, this.sampler, sources)
    this.books.set(family, book)
    // Nodes naming this family have been resolving to the default and cached a layout measured
    // against it; they have to re-shape now that the real thing exists. The epoch is global, so
    // this re-shapes every text node and not just those - over-broad, and worth it here: adding
    // a family is a deliberate, rare act, and the alternative is asking each node which family
    // it names on every access. A node changing ITS OWN family stays precise (MSDFText.fontFamily).
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
