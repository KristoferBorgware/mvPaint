// Which typeface a name means.
//
// A node says `fontFamily: 'inter'` and something has to turn that into glyphs. This is that
// something, and it is the ONLY way in: a font reaches the engine by being registered under a
// name, whether it was fetched from a URL at startup or parsed out of a file the user dropped in
// a minute ago. Nothing takes a font object per node.
//
// WHY OUTLINES LIVE HERE AND ATLASES DO NOT. A PolygonFontBook is arrays of numbers and belongs
// to no device, so it can sit in module state and be resolved synchronously by any node that asks
// - which is what VectorText needs, since it shapes without a renderer in reach. An MSDF book
// holds a GPUTexture, so it lives in the renderer's FontLibrary and is resolved through it. Both
// are reached by the same name, which is the part that matters to a caller.
//
// A family may hold one kind or both. Loading 'inter' with only outlines is an ordinary thing to
// do - an application that never draws MSDF text should not fetch four atlas PNGs to prove it.

import type { VectorFonts } from '../text/vectorGlyphs'
import { loadPolygonFonts, type PolygonFontUrl } from './fontSources'

/** What a family name resolves to. Either half may be absent. */
interface RegisteredFamily {
  vector?: VectorFonts
}

const families = new Map<string, RegisteredFamily>()

// Warned-about names, so an unresolvable family is reported once rather than once per frame.
// The gather runs every frame and a text node re-resolves on every shaping, so an ungated warn
// turns a log into a wall inside a second.
const warned = new Set<string>()

/**
 * The outlines a family name means, or undefined if the name is not registered.
 *
 * Synchronous, which is the point: a VectorText resolves its own fonts while it shapes, and
 * shaping happens with no renderer and no await in reach.
 */
export function vectorFontsFor(family: string): VectorFonts | undefined {
  return families.get(family)?.vector
}

/**
 * Puts a font under a name.
 *
 * For outlines the application already has - parsed from a file at runtime by @mvpaint/ttf, or
 * built by hand. Registering replaces whatever that name held.
 *
 * ```ts
 * registerFontFamily('dropped-file', { vector: await parseTtf(file) })
 * new VectorText({ text, fontFamily: 'dropped-file' })
 * ```
 */
export function registerFontFamily(family: string, fonts: { vector: VectorFonts }): void {
  families.set(family, { ...families.get(family), vector: fonts.vector })
  // A name that drew nothing a moment ago now draws something; if it is ever unresolvable again
  // that is worth hearing about again.
  warned.delete(family)
}

/**
 * Fetches a family's outlines and registers them under `name`.
 *
 * The MSDF half of a family is loaded through the renderer (`handle.loadFontFamily`), because
 * building an atlas needs a device. This is the half that does not.
 */
export async function loadFontFamily(family: string, sources: { vector: readonly PolygonFontUrl[] }): Promise<void> {
  registerFontFamily(family, { vector: await loadPolygonFonts(sources.vector) })
}

/** Every family name currently registered. */
export function fontFamilies(): string[] {
  return [...families.keys()]
}

/** Forgets a name. The book itself goes when its last holder lets go, like any other resource. */
export function unregisterFontFamily(family: string): void {
  families.delete(family)
  warned.delete(family)
}

/**
 * Reports a family nothing can draw, once per name.
 *
 * The engine ships no typeface, so there is nothing to fall back to and the node draws nothing.
 * Saying so out loud is the whole error handling: text that silently fails to appear is otherwise
 * indistinguishable from text positioned off screen, coloured transparent, or never added.
 */
export function warnUnresolvedFamily(family: string, kind: 'outline' | 'atlas'): void {
  if (warned.has(family)) return
  warned.add(family)
  console.warn(
    `mvPaint: no ${kind} font is registered under '${family}', so nothing will be drawn with it. ` +
      `Load one first - loadFontFamily('${family}', …) or registerFontFamily('${family}', …). ` +
      `The engine ships no typeface, so there is nothing to fall back to.`,
  )
}
