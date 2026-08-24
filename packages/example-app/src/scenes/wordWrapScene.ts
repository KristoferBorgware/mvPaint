// Word wrap overflow: a word wider than maxWidth used to draw straight past the block's right
// edge, because layoutHorizontal only ever wrapped at spaces. Each plate below is drawn at
// exactly maxWidth, so an overflow is a glyph sitting outside its rectangle - nothing to
// measure, just look for ink crossing the line.
//
// Also the wrap option this fix came with: 'word' (default, with the mid-word and hyphen
// fallbacks), 'char' (breaks between every glyph, so it also fills a line's leftover room a
// whole-word decision would have wasted), and 'none' (never breaks a line for width - maxWidth
// still sizes and aligns the block, for a caller that wants a fixed-width measurement and
// accepts an over-long string running past it on purpose).

import { MSDFText, Rect, type Scene } from '@mvpaint/engine'
import { CRIMSON, DARK, NAVY, SLATE, TEAL } from './palette'
import type { SceneContent } from './types'

const MAX_WIDTH = 220
const X = -520

function heading(x: number, y: number, text: string): MSDFText {
  return new MSDFText({ x, y, text, style: { fontStyle: 'bold', fontSize: 18, color: DARK } })
}

function caption(x: number, y: number, text: string, maxWidth?: number): MSDFText {
  return new MSDFText({ x, y, text, maxWidth, lineHeight: 1.3, style: { fontSize: 13, color: SLATE } })
}

/** The maxWidth boundary, drawn behind the text it bounds - an overflow is ink outside this rect. */
function plate(x: number, y: number, width: number, height: number, name: string): Rect {
  return new Rect({ name, x, y, width, height, fill: '#eef1f7', stroke: '#c3ccdb', strokeWidth: 1, cornerRadius: 3, zIndex: -1 })
}

export function buildWordWrapScene(scene: Scene): SceneContent {
  const root = scene.root

  root.addChild(heading(X, -340, 'A word wider than maxWidth'))
  root.addChild(
    caption(X, -314, `every plate below is exactly maxWidth (${MAX_WIDTH}px) wide - an overflow is ink outside it`, 520),
  )

  // --- 'word' (default): the mid-word fallback ------------------------------------------------
  root.addChild(caption(X, -270, "wrap: 'word' (default) - no space in this token, so it breaks mid-word instead of running past the edge"))
  root.addChild(plate(X, -240, MAX_WIDTH, 90, 'wrap-plate-word'))
  root.addChild(
    new MSDFText({
      name: 'wrap-word',
      x: X,
      y: -240,
      maxWidth: MAX_WIDTH,
      text: 'Pneumonoultramicroscopicsilicovolcanoconiosis',
      style: { fontSize: 22, color: NAVY },
    }),
  )

  // --- a hyphen breaks first, before the mid-word fallback is needed --------------------------
  root.addChild(caption(X, -128, 'a hyphen is a break opportunity too, and is tried before a mid-word cut'))
  root.addChild(plate(X, -98, MAX_WIDTH, 90, 'wrap-plate-hyphen'))
  root.addChild(
    new MSDFText({
      name: 'wrap-hyphen',
      x: X,
      y: -98,
      maxWidth: MAX_WIDTH,
      text: 'state-of-the-art-multi-channel-signed-distance-fields',
      style: { fontSize: 22, color: NAVY },
    }),
  )

  // --- 'word' vs 'char': the difference is what a SHORT line does with its leftover room ------
  const compareText = 'See the Pneumonoultramicroscopicsilicovolcanoconiosis result'
  root.addChild(heading(X, 40, "'word' vs 'char'"))
  root.addChild(
    caption(
      X,
      66,
      "'word' moves a word that would not fit whole to a new line, even if only its tail overflowed; 'char' keeps filling",
      520,
    ),
  )

  root.addChild(caption(X, 106, "wrap: 'word'"))
  root.addChild(plate(X, 134, MAX_WIDTH, 110, 'wrap-plate-compare-word'))
  root.addChild(
    new MSDFText({
      name: 'wrap-compare-word',
      x: X,
      y: 134,
      maxWidth: MAX_WIDTH,
      wrap: 'word',
      text: compareText,
      style: { fontSize: 18, color: TEAL },
    }),
  )

  const CHAR_X = X + MAX_WIDTH + 40
  root.addChild(caption(CHAR_X, 106, "wrap: 'char'"))
  root.addChild(plate(CHAR_X, 134, MAX_WIDTH, 110, 'wrap-plate-compare-char'))
  root.addChild(
    new MSDFText({
      name: 'wrap-compare-char',
      x: CHAR_X,
      y: 134,
      maxWidth: MAX_WIDTH,
      wrap: 'char',
      text: compareText,
      style: { fontSize: 18, color: TEAL },
    }),
  )

  // --- 'none': the one mode that is SUPPOSED to run past its plate ---------------------------
  const NONE_Y = 300
  root.addChild(heading(X, NONE_Y, "wrap: 'none'"))
  root.addChild(
    caption(X, NONE_Y + 26, 'never wraps - maxWidth still sizes and aligns the block, so this overflow is the caller asking for it', 520),
  )
  root.addChild(plate(X, NONE_Y + 66, MAX_WIDTH, 34, 'wrap-plate-none'))
  root.addChild(
    new MSDFText({
      name: 'wrap-none',
      x: X,
      y: NONE_Y + 66,
      maxWidth: MAX_WIDTH,
      wrap: 'none',
      text: 'Pneumonoultramicroscopicsilicovolcanoconiosis',
      style: { fontSize: 22, color: CRIMSON },
    }),
  )

  return {}
}
