// Text-lane showcase, added to the scene root: the four Inter styles, mixed sizes within one
// node, a gradient-filled run, per-letter outlined glyphs, underline + strikethrough, a
// highlighted run, and a word-wrapped + a center-aligned block. Kept out of SceneRenderer so
// the composition root stays about wiring, not content. Positions are in world px (y-up); each
// Text lays its first line out at its own origin and flows downward.

import type { Container } from '../scene/Container'
import type { RGBA } from '../render/meshFormat'
import { Text } from '../shapes/Text'

const NAVY: RGBA = [0.09, 0.13, 0.28, 1]
const SLATE: RGBA = [0.27, 0.31, 0.4, 1]
const DARK: RGBA = [0.1, 0.1, 0.12, 1]
const TEAL: RGBA = [0.0, 0.48, 0.5, 1]
const CRIMSON: RGBA = [0.8, 0.12, 0.28, 1]
const YELLOW: RGBA = [1, 0.86, 0.24, 1]
const HIGHLIGHT: RGBA = [1, 0.92, 0.4, 1]

const LEFT = -440

export function addTextExamples(root: Container): void {
  // Gradient-filled title (a single run whose fill is a linear gradient across its width).
  root.addChild(
    new Text({
      name: 'text-title',
      x: LEFT,
      y: 340,
      text: 'mvPaint MSDF text',
      style: {
        fontStyle: 'bold',
        fontSize: 56,
        gradient: {
          type: 'linear',
          start: { x: 0, y: 0 },
          end: { x: 520, y: 0 },
          stops: [
            { offset: 0, color: [0.9, 0.2, 0.32, 1] },
            { offset: 1, color: [0.38, 0.22, 0.86, 1] },
          ],
        },
      },
    }),
  )

  // The four styles in one rich-text node (per-run font style + solid color).
  root.addChild(
    new Text({
      name: 'text-styles',
      x: LEFT,
      y: 250,
      runs: [
        { text: 'Regular ', style: { fontStyle: 'regular', fontSize: 34, color: NAVY } },
        { text: 'Bold ', style: { fontStyle: 'bold', fontSize: 34, color: NAVY } },
        { text: 'Italic ', style: { fontStyle: 'italic', fontSize: 34, color: NAVY } },
        { text: 'Bold+Italic', style: { fontStyle: 'bold-italic', fontSize: 34, color: NAVY } },
      ],
    }),
  )

  // Mixed sizes within one line - one atlas serves every size.
  root.addChild(
    new Text({
      name: 'text-sizes',
      x: LEFT,
      y: 190,
      runs: [
        { text: 'Size ', style: { fontSize: 20, color: SLATE } },
        { text: 'scales ', style: { fontSize: 32, color: SLATE } },
        { text: 'freely', style: { fontSize: 48, color: SLATE } },
      ],
    }),
  )

  // Per-letter stroke (outline): a light fill with a dark outline around each glyph.
  root.addChild(
    new Text({
      name: 'text-outline',
      x: LEFT,
      y: 120,
      text: 'Outlined',
      style: { fontStyle: 'bold', fontSize: 72, color: YELLOW, strokeColor: DARK, strokeWidth: 2.5 },
    }),
  )

  // Underline and strikethrough (font-derived placement/thickness).
  root.addChild(
    new Text({
      name: 'text-decorations',
      x: LEFT,
      y: 30,
      runs: [
        { text: 'underline ', style: { fontSize: 34, color: TEAL, underline: true } },
        { text: 'strikethrough', style: { fontSize: 34, color: CRIMSON, strikethrough: true } },
      ],
    }),
  )

  // Highlighted run (a background color drawn behind the glyphs).
  root.addChild(
    new Text({
      name: 'text-highlight',
      x: LEFT,
      y: -40,
      runs: [
        { text: 'with ', style: { fontSize: 30, color: DARK } },
        { text: 'highlighted', style: { fontSize: 30, color: DARK, highlight: HIGHLIGHT } },
        { text: ' runs', style: { fontSize: 30, color: DARK } },
      ],
    }),
  )

  // Word-wrapped paragraph (greedy wrap to maxWidth, custom line height).
  root.addChild(
    new Text({
      name: 'text-paragraph',
      x: LEFT,
      y: -90,
      maxWidth: 520,
      lineHeight: 1.3,
      text: 'Multi-channel signed distance fields keep every glyph crisp at any size and zoom from a single small atlas, so this paragraph wraps and stays sharp.',
      style: { fontSize: 22, color: SLATE },
    }),
  )

  // Center-aligned block with hard line breaks.
  root.addChild(
    new Text({
      name: 'text-centered',
      x: 150,
      y: 250,
      align: 'center',
      maxWidth: 260,
      lineHeight: 1.25,
      text: 'Centered\nand aligned\ntext block',
      style: { fontStyle: 'italic', fontSize: 30, color: NAVY },
    }),
  )
}
