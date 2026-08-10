// Self-test for the font registry: how an atlas gets to a device without any renderer ever
// being told about fonts.
//
// The outline half needs no test of its own - it is a map, answered synchronously, and the text
// suite draws through it. The ATLAS half is the one with a rule in it, because a texture belongs
// to a device and the registry has none: what it holds is the sources, and every live renderer is
// told to build its own texture from them.
//
// Which makes two orders that both have to work, and they are what this pins. A font registered
// BEFORE a renderer exists has to be picked up when that renderer is created; one registered
// AFTER has to reach the renderers already drawing. Get either wrong and the failure is a page of
// invisible text - no error, no exception, nothing in the console except the one warning that
// says a family resolved to nothing.
//
// A listener stands in for a renderer here, which is the whole of what a renderer is to this
// module. Run with: npx vitest run packages/engine/src/resources/fontRegistry.test.ts

import { expect, it } from 'vitest'
import {
  msdfSourcesFor,
  onFontFamilyRegistered,
  registerFontFamily,
  registeredMsdfFamilies,
  unregisterFontFamily,
  vectorFontsFor,
} from './FontRegistry'
import type { MsdfAtlasSource } from '../text/msdfProvider'
import type { VectorFonts } from '../text/vectorGlyphs'

function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}

/** Enough of an atlas source to be told apart from another; nothing here reads inside one. */
const atlas = (url: string): MsdfAtlasSource => ({ style: 'regular', url, json: { url } } as unknown as MsdfAtlasSource)

/** Enough of a book to be stored and handed back. */
const outlines = (tag: string): VectorFonts => ({ tag } as unknown as VectorFonts)

/**
 * A renderer, as far as this module is concerned: something that is told about atlases and takes
 * a moment to build a texture from them.
 */
function fakeRenderer(gate?: Promise<void>) {
  const built: { family: string; urls: string[] }[] = []
  const listener = async (family: string, msdf: readonly MsdfAtlasSource[]) => {
    // A real one uploads here, which takes as long as it takes. `gate` stands in for that when a
    // test needs to hold the upload open and look at the registration while it is still running.
    if (gate) await gate
    built.push({ family, urls: msdf.map((source) => source.url) })
  }
  return { built, stop: onFontFamilyRegistered(listener) }
}

/** A promise the test decides when to settle - what holds a fake upload open. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

it('a renderer created after a font is registered catches up on it', () => {
  // The ordinary startup order, and the one the old `createSceneRenderer({ fonts })` made
  // impossible: the fonts are loaded first and the device arrives afterwards.
  unregisterFontFamily('early')
  registerFontFamily('early', { msdf: [atlas('early.png')] })

  const seen = registeredMsdfFamilies().find((entry) => entry.family === 'early')
  assert(seen !== undefined, 'the family is there to be caught up on')
  assert(seen!.msdf.length === 1 && seen!.msdf[0].url === 'early.png', 'with the sources it was registered with')

  unregisterFontFamily('early')
  assert(!registeredMsdfFamilies().some((e) => e.family === 'early'), 'and gone once it is unregistered')
})

it('a font registered after a renderer exists reaches it', async () => {
  const renderer = fakeRenderer()
  try {
    await registerFontFamily('late', { msdf: [atlas('late-a.png'), atlas('late-b.png')] })
    assert(renderer.built.length === 1, 'the renderer was told once')
    assert(renderer.built[0].family === 'late', 'about the family that was registered')
    assert(renderer.built[0].urls.join() === 'late-a.png,late-b.png', 'with every source in it')
  } finally {
    renderer.stop()
    unregisterFontFamily('late')
  }
})

it('awaiting a registration means every renderer has finished with it', async () => {
  // What lets an application load fonts and then build a scene that measures text: the promise
  // does not settle until the textures are up. Two renderers, because two canvases each build
  // their own from the one registration.
  //
  // Both uploads are held open, so a registration that did not wait for its listeners would
  // settle here with nothing built - which a listener merely awaiting a microtask would not
  // catch, since the await in this test would let it finish anyway.
  const upload = deferred()
  const one = fakeRenderer(upload.promise)
  const two = fakeRenderer(upload.promise)
  try {
    let settled = false
    const pending = registerFontFamily('both', { msdf: [atlas('both.png')] }).then(() => {
      settled = true
    })

    // Several turns of the microtask queue, which is every chance a registration that ignored
    // its listeners would have had to settle.
    for (let i = 0; i < 5; i++) await Promise.resolve()
    assert(!settled, 'the registration is still open while the uploads are')
    assert(one.built.length === 0 && two.built.length === 0, 'and neither renderer has finished')

    upload.release()
    await pending
    assert(settled, 'it settles once they do')
    assert(one.built.length === 1 && two.built.length === 1, 'with both renderers built from it')
  } finally {
    upload.release()
    one.stop()
    two.stop()
    unregisterFontFamily('both')
  }
})

it('a renderer that has gone away is not told about anything else', async () => {
  const renderer = fakeRenderer()
  await registerFontFamily('before', { msdf: [atlas('before.png')] })
  renderer.stop()
  await registerFontFamily('after', { msdf: [atlas('after.png')] })

  assert(renderer.built.length === 1, 'the registration after it stopped listening never reached it')
  assert(renderer.built[0].family === 'before', 'only the one before did')
  unregisterFontFamily('before')
  unregisterFontFamily('after')
})

it('the two halves of a family are independent', async () => {
  // A family gains its atlases long after its outlines, or the other way round, and neither
  // registration disturbs the other. Registering outlines alone tells no renderer anything -
  // there is no texture in it to build.
  const renderer = fakeRenderer()
  try {
    unregisterFontFamily('halves')
    registerFontFamily('halves', { vector: outlines('book') })
    assert(vectorFontsFor('halves') !== undefined, 'the outlines are there')
    assert(msdfSourcesFor('halves') === undefined, 'and no atlases yet')
    assert(renderer.built.length === 0, 'so no renderer was asked to build a texture')

    await registerFontFamily('halves', { msdf: [atlas('halves.png')] })
    assert(vectorFontsFor('halves') !== undefined, 'the outlines survived the second registration')
    assert(msdfSourcesFor('halves')?.length === 1, 'which added the atlases beside them')
    assert(renderer.built.length === 1, 'and that one did reach the renderer')

    // Replacing one half leaves the other where it was.
    await registerFontFamily('halves', { msdf: [atlas('replaced.png')] })
    assert(msdfSourcesFor('halves')?.[0].url === 'replaced.png', 'atlases replace rather than merge')
    assert(vectorFontsFor('halves') !== undefined, 'and the outlines are still there')
  } finally {
    renderer.stop()
    unregisterFontFamily('halves')
  }
})
