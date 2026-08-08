// Vector text from a font file the engine has never seen - the opt-in half of the vector path.
//
// Every other vector scene draws from this application's polygon atlases: outlines flattened
// once, offline, and read back as data. That is the right default, and it is why the engine
// needs no font parser at all. What it cannot do is draw a font that did not exist when the
// application was built.
//
// This scene is that case. It fetches a TTF at runtime and hands it to @mvpaint/ttf, a package
// outside the engine that parses it and satisfies the same VectorFonts interface - so the
// VectorText nodes below are ordinary vector text, and nothing downstream of the shaper knows
// where the outlines came from. An application that never imports this package never downloads
// the parser.
//
// The font files come in as `?url`, so they are fetched when this scene opens rather than
// bundled - the same treatment the polygon atlases get. They are borrowed from the generators'
// input folder rather than copied into src/fonts/: this demo needs a real TTF at runtime, and a
// TTF is a generator INPUT, not one of the atlases a developer copies out.

import { MSDFText, VectorText, registerFontFamily, type Scene } from '@mvpaint/engine'
import { TtfFontBook } from '@mvpaint/ttf'
import { CRIMSON, DARK, SLATE, TEAL } from './palette'
import type { SceneContent } from './types'

// Two files, not four: a `?url` import emits its file whether or not the binding is used, so
// naming the italics here would put another 800 kB of typeface in the build for nothing.
import interRegularTtf from '@mvpaint/scripts/textgen/fonts/Inter-400-normal.ttf?url'
import interBoldTtf from '@mvpaint/scripts/textgen/fonts/Inter-700-normal.ttf?url'

const LEFT = -430

/**
 * The name these outlines are registered under. A font parsed at runtime goes into the registry
 * like any other - there is no way to hand a book to a node - so this scene's typeface is reached
 * exactly as the application's own is, by name.
 */
const RUNTIME_TTF = 'inter-runtime'

let ready = false

/** Fetch the font files and parse them. Called by the canvas before build(). */
export async function prepareRuntimeTtfScene(): Promise<void> {
  if (ready) return
  const [regular, bold] = await Promise.all(
    [interRegularTtf, interBoldTtf].map(async (url) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`Failed to load a font file (${response.status})`)
      return response.arrayBuffer()
    }),
  )
  // Two styles, not four: a book synthesizes what it was not given, so italic below is a faux
  // slant of the real regular - which is exactly what the atlas-backed book would do.
  registerFontFamily(RUNTIME_TTF, {
    vector: await TtfFontBook.load([
      { style: 'regular', data: regular },
      { style: 'bold', data: bold },
    ]),
  })
  ready = true
}

export function buildRuntimeTtfScene(scene: Scene): SceneContent {
  if (!ready) throw new Error('The font file is not parsed yet')
  const root = scene.root

  const label = (x: number, y: number, text: string) =>
    new MSDFText({ name: `label-${text.slice(0, 12)}`, x, y, text, style: { fontSize: 16, color: SLATE } })

  root.addChild(
    new VectorText({
      fontFamily: RUNTIME_TTF,
      name: 'ttf-title',
      x: LEFT,
      y: -260,
      text: 'Parsed at runtime',
      style: { fontStyle: 'bold', fontSize: 56, color: DARK },
    }),
  )
  root.addChild(label(LEFT, -196, 'This TTF was fetched and parsed in the browser by @mvpaint/ttf -'))
  root.addChild(label(LEFT, -172, 'the engine itself carries no font parser, and never sees the file.'))

  // The full charset is the point: an atlas covers what it was generated for, a parser covers
  // whatever the font has. These characters are outside the printable-ASCII set the bundled
  // atlases were built with, so the atlas-backed scenes space them instead of drawing them.
  root.addChild(
    new VectorText({
      fontFamily: RUNTIME_TTF,
      name: 'ttf-charset',
      x: LEFT,
      y: -110,
      text: 'Æøå Ćžš — «déjà vu» ¶§',
      style: { fontSize: 44, color: TEAL },
    }),
  )
  root.addChild(label(LEFT, -46, "Characters outside the atlases' generated charset, drawn from the file itself."))

  // Everything else a VectorText can do still applies - these are the same nodes, differing
  // only in where their outlines came from.
  root.addChild(
    new VectorText({
      fontFamily: RUNTIME_TTF,
      name: 'ttf-styled',
      x: LEFT,
      y: 30,
      runs: [
        { text: 'Real geometry: ', style: { fontSize: 40, color: DARK } },
        { text: 'shadowed', style: { fontSize: 40, color: CRIMSON, shadow: { color: '#00000073', offsetX: 3, offsetY: 4 } } },
        { text: ', ', style: { fontSize: 40, color: DARK } },
        { text: 'outlined', style: { fontSize: 40, color: '#ffffff', strokeColor: DARK, strokeWidth: 2 } },
        { text: ', faux ', style: { fontSize: 40, color: DARK } },
        { text: 'italic', style: { fontSize: 40, fontStyle: 'italic', color: DARK } },
      ],
    }),
  )
  root.addChild(label(LEFT, 100, 'Only regular and bold were loaded, so the italic above is synthesized - the'))
  root.addChild(label(LEFT, 124, 'same fallback ladder every other font book in the engine walks.'))

  root.addChild(
    new VectorText({
      fontFamily: RUNTIME_TTF,
      name: 'ttf-body',
      x: LEFT,
      y: 190,
      maxWidth: 900,
      text:
        'A parser is worth its weight only when the font is unknown until the moment it is needed: a file the user drops in, a font picker, a document that names its own typeface. Everything else is better served by a polygon atlas, which is this same geometry computed once and shipped as data.',
      style: { fontSize: 22, color: DARK },
      lineHeight: 1.45,
    }),
  )

  return {}
}
