// Which typeface a name means.
//
// A node says `fontFamily: 'inter'` and something has to turn that into glyphs. This is that
// something, and it is the ONLY way in: a font reaches the engine by being registered under a
// name, whether it was fetched from a URL at startup or parsed out of a file the user dropped in
// a minute ago. Nothing takes a font object per node, and nothing takes one per RENDERER either -
// creating a renderer is about a canvas and a device, and it knows nothing about fonts.
//
// BOTH KINDS ARRIVE HERE, by different routes to the same door. Outlines are arrays of numbers
// and belong to no device, so they are held whole and answered synchronously - which is what
// VectorText needs, since it shapes with no renderer in reach. An atlas cannot be held that way:
// it is a texture, and a texture belongs to a device that may not exist yet and may be one of
// several. So what is held here is the atlas SOURCES - metrics and a URL, plain data - and every
// live renderer is told to build its own texture from them (see onFontFamilyRegistered). A
// renderer created later builds from whatever is already registered; one created earlier is
// caught up by the notification.
//
// That is what makes the two symmetrical from a caller's side, which is the whole point:
//
//   await loadFontFamily('inter', { vector: [...], msdf: [...] })
//
// works before or after any renderer exists, and awaiting it means the glyphs are ready - the
// outlines parsed, the atlases uploaded on every device drawing at the time.
//
// A family may hold one kind or both. Loading 'inter' with only outlines is an ordinary thing to
// do - an application that never draws MSDF text should not fetch four atlas PNGs to prove it.

import type { VectorFonts } from '../text/vectorGlyphs'
import type { MsdfAtlasSource } from '../text/msdfProvider'
import { loadPolygonFonts, type PolygonFontUrl } from './fontSources'

/** What a family name resolves to. Either half may be absent. */
interface RegisteredFamily {
  vector?: VectorFonts
  /** Plain data - the texture built from it belongs to whichever renderer built it. */
  msdf?: readonly MsdfAtlasSource[]
}

const families = new Map<string, RegisteredFamily>()

/**
 * Told when a family's atlas sources arrive or change, so a renderer can build its texture.
 *
 * Returning a promise is how a renderer says "not yet drawn with": registerFontFamily awaits
 * every listener, so an application awaiting it knows the atlases are on the device rather than
 * merely in flight.
 */
export type FontFamilyListener = (family: string, msdf: readonly MsdfAtlasSource[]) => void | Promise<void>

const listeners = new Set<FontFamilyListener>()

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

/** The atlas sources a family name means, or undefined if it has none. */
export function msdfSourcesFor(family: string): readonly MsdfAtlasSource[] | undefined {
  return families.get(family)?.msdf
}

/** Every family that has atlas sources, for a renderer catching up on what it missed. */
export function registeredMsdfFamilies(): { family: string; msdf: readonly MsdfAtlasSource[] }[] {
  const out: { family: string; msdf: readonly MsdfAtlasSource[] }[] = []
  for (const [family, registered] of families) {
    if (registered.msdf) out.push({ family, msdf: registered.msdf })
  }
  return out
}

/**
 * Subscribe to atlas registrations, and unsubscribe with what comes back.
 *
 * For renderers. A renderer subscribes when it is created, catches up on
 * registeredMsdfFamilies(), and unsubscribes when it is destroyed - so a canvas that has gone
 * away is not asked to build a texture on a device that has gone with it.
 */
export function onFontFamilyRegistered(listener: FontFamilyListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Puts a font under a name, and returns when every renderer has taken it up.
 *
 * For fonts the application already has - outlines parsed from a file at runtime by
 * @mvpaint/ttf, atlas metrics it imported rather than fetched. Registering REPLACES whichever
 * halves are named and leaves the others alone, so a family can gain its atlases long after its
 * outlines.
 *
 * ```ts
 * registerFontFamily('dropped-file', { vector: await parseTtf(file) })
 * new VectorText({ text, fontFamily: 'dropped-file' })
 * ```
 *
 * The outlines are in place the moment this is called; only the atlases are worth awaiting, and
 * only because a texture has to be built for each device drawing at the time.
 */
export function registerFontFamily(
  family: string,
  fonts: { vector?: VectorFonts; msdf?: readonly MsdfAtlasSource[] },
): Promise<void> {
  const existing = families.get(family)
  families.set(family, {
    vector: fonts.vector ?? existing?.vector,
    msdf: fonts.msdf ?? existing?.msdf,
  })
  // A name that drew nothing a moment ago now draws something; if it is ever unresolvable again
  // that is worth hearing about again.
  warned.delete(family)

  if (!fonts.msdf) return Promise.resolve()
  const msdf = fonts.msdf
  return Promise.all([...listeners].map((listener) => listener(family, msdf))).then(() => undefined)
}

/**
 * Fetches a family and registers it under `name`.
 *
 * The two halves are independent - give it either, or both. Outlines are fetched and parsed
 * here; atlases are handed on as they are, since what is fetched for those is a PNG per style and
 * only a device can receive it.
 *
 * ```ts
 * const handle = await createSceneRenderer(canvas)          // first the renderer,
 * await loadFontFamily('inter', { vector, msdf })           // then the fonts,
 * buildScene(handle.scene)                                  // then the scene
 * ```
 */
export async function loadFontFamily(
  family: string,
  sources: { vector?: readonly PolygonFontUrl[]; msdf?: readonly MsdfAtlasSource[] },
): Promise<void> {
  await registerFontFamily(family, {
    vector: sources.vector ? await loadPolygonFonts(sources.vector) : undefined,
    msdf: sources.msdf,
  })
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
