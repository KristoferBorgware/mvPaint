// text-lane showcase: the four Inter styles, mixed sizes within one node, a gradient-filled
// run, per-letter outlined glyphs, underline + strikethrough, a highlighted run, wrapped and
// aligned blocks, baseline shift, faux styles, the glyph-duplicate drop shadow and glow,
// justification, right-to-left flow and vertical orientation.
//
// Positions are in world px (y-up); each MSDFText lays its first line out at its own origin and
// flows downward.

import { MSDFText, type Scene } from '@mvpaint/engine'
import { CRIMSON, DARK, HIGHLIGHT, NAVY, SLATE, TEAL, YELLOW } from './palette'
import type { SceneContent } from './types'

const LEFT = -440

export function buildTextScene(scene: Scene): SceneContent {
  const root = scene.root
  // Gradient-filled title (a single run whose fill is a linear gradient across its width).
  root.addChild(
    new MSDFText({
      name: 'text-title',
      x: LEFT,
      y: -340,
      text: 'mvPaint MSDF text',
      style: {
        fontStyle: 'bold',
        fontSize: 56,
        gradient: {
          type: 'linear',
          start: { x: 0, y: 0 },
          end: { x: 520, y: 0 },
          stops: [
            { offset: 0, color: '#e63352' },
            { offset: 1, color: '#6138db' },
          ],
        },
      },
    }),
  )

  // The four styles in one rich-text node (per-run font style + solid color).
  root.addChild(
    new MSDFText({
      name: 'text-styles',
      x: LEFT,
      y: -250,
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
    new MSDFText({
      name: 'text-sizes',
      x: LEFT,
      y: -190,
      runs: [
        { text: 'Size ', style: { fontSize: 20, color: SLATE } },
        { text: 'scales ', style: { fontSize: 32, color: SLATE } },
        { text: 'freely', style: { fontSize: 48, color: SLATE } },
      ],
    }),
  )

  // Per-letter stroke (outline): a light fill with a dark outline around each glyph.
  root.addChild(
    new MSDFText({
      name: 'text-outline',
      x: LEFT,
      y: -120,
      text: 'Outlined',
      style: { fontStyle: 'bold', fontSize: 72, color: YELLOW, strokeColor: DARK, strokeWidth: 2.5 },
    }),
  )

  // Underline and strikethrough (font-derived placement/thickness).
  root.addChild(
    new MSDFText({
      name: 'text-decorations',
      x: LEFT,
      y: -30,
      runs: [
        { text: 'underline ', style: { fontSize: 34, color: TEAL, underline: true } },
        { text: 'strikethrough', style: { fontSize: 34, color: CRIMSON, strikethrough: true } },
      ],
    }),
  )

  // Highlighted run (a background color drawn behind the glyphs).
  root.addChild(
    new MSDFText({
      name: 'text-highlight',
      x: LEFT,
      y: 40,
      runs: [
        { text: 'with ', style: { fontSize: 30, color: DARK } },
        { text: 'highlighted', style: { fontSize: 30, color: DARK, highlight: HIGHLIGHT } },
        { text: ' runs', style: { fontSize: 30, color: DARK } },
      ],
    }),
  )

  // Word-wrapped paragraph (greedy wrap to maxWidth, custom line height).
  root.addChild(
    new MSDFText({
      name: 'text-paragraph',
      x: LEFT,
      y: 90,
      maxWidth: 520,
      lineHeight: 1.3,
      text: 'Multi-channel signed distance fields keep every glyph crisp at any size and zoom from a single small atlas, so this paragraph wraps and stays sharp.',
      style: { fontSize: 22, color: SLATE },
    }),
  )

  // --- second column: the follow-up features ---

  // Baseline shift: a superscript exponent and a subscript.
  root.addChild(
    new MSDFText({
      name: 'text-baseline',
      x: 90,
      y: -340,
      runs: [
        { text: 'E = mc', style: { fontSize: 34, color: NAVY } },
        { text: '2', style: { fontSize: 22, color: NAVY, baselineShift: 16 } },
        { text: '   H', style: { fontSize: 34, color: NAVY } },
        { text: '2', style: { fontSize: 22, color: NAVY, baselineShift: -6 } },
        { text: 'O', style: { fontSize: 34, color: NAVY } },
      ],
    }),
  )

  // Faux weight/slant synthesized on top of the regular atlas (dilation + shear).
  root.addChild(
    new MSDFText({
      name: 'text-faux',
      x: 90,
      y: -285,
      runs: [
        { text: 'Faux ', style: { fontSize: 30, color: NAVY } },
        { text: 'bold ', style: { fontSize: 30, color: NAVY, fauxBold: true } },
        { text: 'italic ', style: { fontSize: 30, color: NAVY, fauxItalic: true } },
        { text: 'both', style: { fontSize: 30, color: NAVY, fauxBold: true, fauxItalic: true } },
      ],
    }),
  )

  // Drop shadow: an offset, softened copy behind the glyphs.
  root.addChild(
    new MSDFText({
      name: 'text-shadow',
      x: 90,
      y: -225,
      text: 'Drop shadow',
      style: {
        fontStyle: 'bold',
        fontSize: 44,
        color: '#2666d9',
        shadow: { color: '#00000059', offsetX: 3, offsetY: 4 },
      },
    }),
  )

  // Soft glow: a dilated halo copy behind the glyphs.
  root.addChild(
    new MSDFText({
      name: 'text-glow',
      x: 90,
      y: -155,
      text: 'Soft glow',
      style: { fontStyle: 'bold', fontSize: 44, color: DARK, glow: { color: '#ffcc26', radius: 6 } },
    }),
  )

  // Justified paragraph (spaces stretch so every non-final line fills the width).
  root.addChild(
    new MSDFText({
      name: 'text-justify',
      x: 90,
      y: -95,
      maxWidth: 360,
      align: 'justify',
      lineHeight: 1.35,
      text: 'Justified text spreads the inter-word spaces so every line except the last reaches the right edge.',
      style: { fontSize: 18, color: SLATE },
    }),
  )

  // Right-to-left flow (mechanical mirror; the first character lands rightmost).
  root.addChild(
    new MSDFText({
      name: 'text-rtl',
      x: 90,
      y: 15,
      maxWidth: 360,
      direction: 'rtl',
      text: 'RTL flow 12345',
      style: { fontSize: 28, color: CRIMSON },
    }),
  )

  // Center-aligned block with hard line breaks.
  root.addChild(
    new MSDFText({
      name: 'text-centered',
      x: 90,
      y: 70,
      align: 'center',
      maxWidth: 260,
      lineHeight: 1.25,
      text: 'Centered\nand aligned',
      style: { fontStyle: 'italic', fontSize: 28, color: NAVY },
    }),
  )

  // A rotated text, so a multi-node selection can mix rotations. That is the case worth
  // having on hand: an axis-aligned box around differently-turned members shears them
  // when it is scaled non-uniformly, which is the hardest thing the transformer does.
  root.addChild(
    new MSDFText({
      name: 'text-rotated',
      x: 470,
      y: 140,
      rotation: -45,
      text: 'Rotated 45',
      style: { fontStyle: 'bold', fontSize: 28, color: CRIMSON },
    }),
  )

  // Vertical orientation: glyphs stack top-to-bottom in right-to-left columns.
  root.addChild(
    new MSDFText({
      name: 'text-vertical',
      // Clear of the justified block's 360-wide measure, which reaches x 450: vertical columns
      // run right to left, so this node's glyphs sit to the LEFT of where it is anchored.
      x: 530,
      y: -340,
      orientation: 'vertical',
      lineHeight: 1.05,
      text: 'Vertical\ntext',
      style: { fontStyle: 'bold', fontSize: 30, color: TEAL },
    }),
  )

  return {}
}
