// Demo scene content for the example app: gradient-filled and stroked shapes, a stroked
// polyline, a whole SVG document, and an MSDF text-lane showcase (the four Inter styles,
// mixed sizes, per-letter stroke, decorations, gradients, and the follow-up features).
// Kept out of @mvpaint/engine so the engine stays about the renderer, not this content.

import {
  Circle,
  Polyline,
  Rect,
  Scene,
  Text,
  loadSvgDocument,
  shadow,
  type RGBA,
} from '@mvpaint/engine'
import { EXAMPLE_SVG } from '../svg/exampleSvg'

const NAVY: RGBA = [0.09, 0.13, 0.28, 1]
const SLATE: RGBA = [0.27, 0.31, 0.4, 1]
const DARK: RGBA = [0.1, 0.1, 0.12, 1]
const TEAL: RGBA = [0.0, 0.48, 0.5, 1]
const CRIMSON: RGBA = [0.8, 0.12, 0.28, 1]
const YELLOW: RGBA = [1, 0.86, 0.24, 1]
const HIGHLIGHT: RGBA = [1, 0.92, 0.4, 1]

const LEFT = -440

/** Builds the demo scene into `scene.root` and returns the rects that should spin each frame. */
export function buildDemoScene(scene: Scene): Map<Rect, number> {
  const spins = new Map<Rect, number>()

  // Two rects side by side, filled + stroked, spinning about their centers. Sized in
  // pixel-equivalent world units.
  const left = scene.root.addChild(
    new Rect({
      name: 'rect-left',
      x: -110,
      y: 0,
      width: 160,
      height: 160,
      fill: [0.9, 0.28, 0.24, 1],
      stroke: [0.5, 0.1, 0.08, 1],
      strokeWidth: 6,
      // A hard shadow (no blur): just an offset, darker, semi-transparent copy.
      shadow: shadow({ offsetX: 10, offsetY: 14, opacity: 0.5 }),
    }),
  )
  // Linear gradient across the rect's own diagonal, in its local (pre-transform)
  // space - it moves and rotates with the rect.
  left.fillPriority = 'linear-gradient'
  left.fillLinearGradientStartPoint = { x: -80, y: -80 }
  left.fillLinearGradientEndPoint = { x: 80, y: 80 }
  left.fillLinearGradientColorStops = [
    { offset: 0, color: [1, 0.9, 0.3, 1] },
    { offset: 1, color: [0.9, 0.1, 0.2, 1] },
  ]
  const right = scene.root.addChild(
    new Rect({
      name: 'rect-right',
      x: 120,
      y: 0,
      width: 200,
      height: 130,
      fill: [0.2, 0.45, 0.9, 1],
      stroke: [0.08, 0.18, 0.5, 1],
      strokeWidth: 6,
      // A soft shadow: spread grows the silhouette outward before blur softens its edge -
      // rendered through ShadowRenderer's offscreen dilate+gaussian passes (see there),
      // since this Rect has no distance field to soften analytically the way Text does.
      shadow: shadow({ offsetX: 8, offsetY: 20, spread: 6, blur: 14, opacity: 0.45 }),
    }),
  )
  spins.set(left, 1)
  spins.set(right, -1.4)

  // A circle centered between the rects, drawn last so it layers on top (painter order).
  const circle = scene.root.addChild(
    new Circle({
      name: 'circle',
      x: 0,
      y: 0,
      radius: 90,
      fill: [0.2, 0.72, 0.36, 1],
      stroke: [0.1, 0.4, 0.2, 1],
      strokeWidth: 6,
      shadow: shadow({ offsetY: 16, blur: 8, opacity: 0.4 }),
    }),
  )
  // Radial gradient from the circle's own center out to its own radius, in local
  // space - a concentric center-to-edge fade.
  circle.fillPriority = 'radial-gradient'
  circle.fillRadialGradientStartPoint = { x: 0, y: 0 }
  circle.fillRadialGradientStartRadius = 0
  circle.fillRadialGradientEndPoint = { x: 0, y: 0 }
  circle.fillRadialGradientEndRadius = 90
  circle.fillRadialGradientColorStops = [
    { offset: 0, color: [0.9, 1, 0.6, 1] },
    { offset: 1, color: [0.1, 0.5, 0.2, 1] },
  ]

  // An open zigzag polyline below the shapes, demonstrating the general contour
  // stroker on a non-rectangular, non-circular path: round join + round caps
  // (Canvas2D-style lineJoin/lineCap, both configurable per-instance).
  scene.root.addChild(
    new Polyline({
      name: 'zigzag',
      points: [
        { x: -180, y: -180 },
        { x: -90, y: -120 },
        { x: 0, y: -180 },
        { x: 90, y: -120 },
        { x: 180, y: -180 },
      ],
      stroke: [0.55, 0.35, 0.85, 1],
      strokeWidth: 14,
      lineJoin: 'round',
      lineCap: 'round',
    }),
  )

  // A whole SVG document loaded through the path pipeline: its shapes (gradient-filled
  // ring with a hole, radial-filled stroked circle, stroked open curve) become Path
  // nodes under one container. The root matrix flips Y (SVG is y-down, the scene is
  // y-up) and lifts the 0..200 artwork into the upper-center of the view.
  const svgDoc = loadSvgDocument(EXAMPLE_SVG, { rootMatrix: [1, 0, 0, -1, -100, 280] })
  scene.root.addChild(svgDoc)

  addTextExamples(scene)
  addZIndexExamples(scene)

  return spins
}

// zIndex demo: a mesh shape and Text now resolve their stacking order through the same
// depth buffer, so a shape can sit in FRONT of text (not just always behind it, which is
// all the two-lane renderer could do before zIndex existed).
function addZIndexExamples(scene: Scene): void {
  const root = scene.root

  // Default zIndex (0) on both: a tie falls back to scene order, so the later-added node
  // (the text) wins - same look as before zIndex existed, but for a different reason.
  root.addChild(
    new Circle({
      name: 'circle-zindex-tie',
      x: 470 + 40,
      y: 60 - 8,
      radius: 34,
      fill: [0.9, 0.3, 0.5, 0.7],
    }),
  )
  root.addChild(
    new Text({
      name: 'text-zindex-tie',
      x: 470,
      y: 60,
      text: 'Text on top (tie)',
      style: { fontStyle: 'bold', fontSize: 26, color: DARK },
    }),
  )

  // A higher zIndex on the circle now correctly brings it in front of the text.
  root.addChild(
    new Text({
      name: 'text-zindex-behind',
      x: 470,
      y: -20,
      text: 'Shape on top (zIndex)',
      style: { fontStyle: 'bold', fontSize: 26, color: DARK },
      zIndex: 0,
    }),
  )
  root.addChild(
    new Circle({
      name: 'circle-zindex-front',
      x: 470 + 40,
      y: -20 - 8,
      radius: 34,
      fill: [0.2, 0.55, 0.9, 0.85],
      zIndex: 1,
    }),
  )
}

// Text-lane showcase: the four Inter styles, mixed sizes within one node, a gradient-filled
// run, per-letter outlined glyphs, underline + strikethrough, a highlighted run, a
// word-wrapped + a center-aligned block, and the follow-up features (baseline shift, faux
// styles, shadow/glow, justify, RTL, vertical). Positions are in world px (y-up); each Text
// lays its first line out at its own origin and flows downward.
function addTextExamples(scene: Scene): void {
  const root = scene.root
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

  // --- second column: the follow-up features ---

  // Baseline shift: a superscript exponent and a subscript.
  root.addChild(
    new Text({
      name: 'text-baseline',
      x: 90,
      y: 340,
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
    new Text({
      name: 'text-faux',
      x: 90,
      y: 285,
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
    new Text({
      name: 'text-shadow',
      x: 90,
      y: 225,
      text: 'Drop shadow',
      style: {
        fontStyle: 'bold',
        fontSize: 44,
        color: [0.15, 0.4, 0.85, 1],
        shadow: shadow({ color: [0, 0, 0, 0.35], offsetX: 3, offsetY: 4, blur: 1 }),
      },
    }),
  )

  // Soft glow: a dilated halo copy behind the glyphs.
  root.addChild(
    new Text({
      name: 'text-glow',
      x: 90,
      y: 155,
      text: 'Soft glow',
      style: { fontStyle: 'bold', fontSize: 44, color: DARK, glow: shadow({ color: [1, 0.8, 0.15, 1], spread: 6, blur: 3 }) },
    }),
  )

  // Justified paragraph (spaces stretch so every non-final line fills the width).
  root.addChild(
    new Text({
      name: 'text-justify',
      x: 90,
      y: 95,
      maxWidth: 360,
      align: 'justify',
      lineHeight: 1.35,
      text: 'Justified text spreads the inter-word spaces so every line except the last reaches the right edge.',
      style: { fontSize: 18, color: SLATE },
    }),
  )

  // Right-to-left flow (mechanical mirror; the first character lands rightmost).
  root.addChild(
    new Text({
      name: 'text-rtl',
      x: 90,
      y: -15,
      maxWidth: 360,
      direction: 'rtl',
      text: 'RTL flow 12345',
      style: { fontSize: 28, color: CRIMSON },
    }),
  )

  // Center-aligned block with hard line breaks.
  root.addChild(
    new Text({
      name: 'text-centered',
      x: 90,
      y: -70,
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
    new Text({
      name: 'text-rotated',
      x: 470,
      y: -140,
      rotation: Math.PI / 4,
      text: 'Rotated 45',
      style: { fontStyle: 'bold', fontSize: 28, color: CRIMSON },
    }),
  )

  // Vertical orientation: glyphs stack top-to-bottom in right-to-left columns.
  root.addChild(
    new Text({
      name: 'text-vertical',
      x: 470,
      y: 340,
      orientation: 'vertical',
      lineHeight: 1.05,
      text: 'Vertical\ntext',
      style: { fontStyle: 'bold', fontSize: 30, color: TEAL },
    }),
  )
}
