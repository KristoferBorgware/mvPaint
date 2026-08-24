// The example-scene registry. The picker lists whatever is in here, in this order, and the
// canvas loads by id - so adding a demo is one new file plus one entry below.

import { buildColorScene } from './colorScene'
import { buildCustomShapeScene } from './customShapeScene'
import { buildDashScene } from './dashScene'
import { buildGroupScene } from './groupScene'
import { buildImageScene, prepareImageScene } from './imageScene'
import { buildLayerScene } from './layerScene'
import { buildMsdfStressScene } from './msdfStressScene'
import { buildOpacityScene } from './opacityScene'
import { buildPolylineScene } from './polylineScene'
import { buildShadowScene } from './shadowScene'
import { buildShapesScene } from './shapesScene'
import { buildStrokeScaleScene } from './strokeScaleScene'
import { buildShapeStressScene } from './shapeStressScene'
import { buildStressScene } from './stressScene'
import { buildSvgFeaturesScene } from './svgFeaturesScene'
import { buildSvgScene } from './svgScene'
import { buildSvgLoadStressScene, prepareSvgLoadStressScene } from './svgLoadStressScene'
import { buildTextScene } from './textScene'
import { buildUniformTextScene, prepareUniformTextScene } from './uniformTextScene'
import { buildTransparencyScene } from './transparencyScene'
import { buildTweenScene } from './tweenScene'
import { buildVectorTextScene, prepareVectorTextScene } from './vectorTextScene'
import { buildTextPathScene, prepareTextPathScene } from './textPathScene'
import { buildWordWrapScene } from './wordWrapScene'
import { buildVectorTextStressScene, prepareVectorTextStressScene } from './vectorTextStressScene'
import { buildRuntimeTtfScene, prepareRuntimeTtfScene } from './runtimeTtfScene'
import { buildZIndexScene } from './zIndexScene'
import type { ExampleScene } from './types'

export type { ExampleScene, SceneContent } from './types'

export const EXAMPLE_SCENES: ExampleScene[] = [
  {
    id: 'shapes',
    title: 'Shapes & gradients',
    description:
      'Mesh-lane basics on Rect, Circle and Polyline: linear and radial gradient fills in local space, stroke joins and caps, corner rounding, and per-frame rotation about a pivot moved with offsetX/offsetY.',
    build: buildShapesScene,
  },
  {
    id: 'custom-shapes',
    title: 'Custom shapes',
    description:
      'CustomShape subclasses defined in the scene file: each describes its contour into a ShapeContext (moveTo/lineTo/curves/arcs) and gets fills, strokes, per-segment stroke styling, holes, gradients, shadows, outline-accurate picking and bounds from the base class. The wave rebuilds its outline per frame and calls markGeometryDirty(); the rest describe once.',
    build: buildCustomShapeScene,
  },
  {
    id: 'stroke-scale',
    title: 'Stroke and scale',
    description:
      'strokeWidth under transforms. By default the width is a local-space measurement and scales with the node; strokeScaleEnabled: false builds the ribbon through the world transform instead, so the outline holds its width under group scale, animated scale and non-uniform scale alike. The right-hand row is the other axis: strokeAlign inside/center/outside, with the node bounds printed underneath, since moving the ribbon changes what the node measures.',
    build: buildStrokeScaleScene,
  },
  {
    id: 'dashes',
    title: 'Dashed strokes',
    description:
      'dash/dashOffset/dashEnabled: the outline is cut into pieces before the ribbon is built, so every piece is an ordinary open path. Covers the pattern vocabulary (including a dotted line, which is a dash short enough that its two round caps meet), a pattern measured around a corner rather than restarting at it, strokeAlign surviving the cut, a dash carried through the gauge under strokeScaleEnabled: false, and dashOffset animated into marching ants. The bottom right is hitStrokeWidth: three hairlines drawn one unit wide, two of which are easy to grab, and the third scaled by six along with its hit ribbon.',
    build: buildDashScene,
  },
  {
    id: 'polylines',
    title: 'Polylines & curves',
    description:
      'Polyline: one list of points read four ways. tension fits a spline through the points and still lands on every one of them (four tensions over a single point set, including an overshooting one); bezier reads the same kind of list as a start point plus groups of three, drawn over its own control net; closed joins the ends and gives the ring an interior, so it fills and can be clicked in the middle rather than only on its outline. The bottom right is what a polyline knows about itself - width and height are the extent of the curve it draws rather than a size it was given, and getLength()/getPointAtLength() are what carry the disc along it. Points are written flat in the first section and as objects everywhere else.',
    build: buildPolylineScene,
  },
  {
    id: 'groups',
    title: 'Groups',
    description:
      'Group: a transform container whose extent is derived from its children. Covers the group transform reaching a subtree, nesting, extent tracking animated contents, visible gating a subtree, and draggable: false opting a group out so its parts are grabbed individually. Otherwise, click any part to select the whole assembly.',
    build: buildGroupScene,
  },
  {
    id: 'layers',
    title: 'Layers',
    description:
      "Layer: a transform container without the picking and bounds aggregation a Group adds. It is not a render target and contributes no ordering - the scene draws in one pass and zIndex sorts scene-wide, so two layers interleave. Its visible gates the whole subtree without touching a node's own. Click the paired group/layer blocks to compare hit testing.",
    build: buildLayerScene,
  },
  {
    id: 'text',
    title: 'MSDF text',
    description:
      'text lane: four vertices per glyph sampling a shared MSDF atlas. Four Inter styles from one atlas array, per-run styling within a single node (size, colour, gradient, outline, highlight, decorations, baseline shift), wrapping, alignment and justification, RTL and vertical flow.',
    build: buildTextScene,
  },
  {
    id: 'word-wrap',
    title: 'Word wrap overflow',
    description:
      "layoutHorizontal's mid-word and hyphen break fallbacks: a word wider than maxWidth breaks instead of running past the block, every plate below is drawn at exactly maxWidth so an overflow is visible as ink outside it. Also the wrap option this shipped with - 'word' (default), 'char' (breaks between every glyph, so it fills a short line's leftover room that a whole-word decision would waste), and 'none' (never wraps; maxWidth still sizes and aligns the block).",
    build: buildWordWrapScene,
  },
  {
    id: 'uniform-text',
    title: 'Uniform text',
    description:
      "UniformMSDFText and UniformVectorText: one style for the whole string, said in node attributes rather than in a run. fill, stroke, strokeWidth, fontSize, fontStyle, textDecoration, letterSpacing and padding are properties of the node, and writing any of them re-shapes it - the animated label writes two per frame. The second column prints one against a plain MSDFText given the same fill, which ignores it, since a text lane paints from the run. Plates are drawn at the size each label measures through getTextWidth()/getTextHeight().",
    prepare: prepareUniformTextScene,
    build: buildUniformTextScene,
  },
  {
    id: 'vector-text',
    title: 'Outline text',
    description:
      'VectorText: glyph outlines tessellated into the mesh lane rather than sampled from an MSDF atlas. Same shaper as the text lane, so runs and block layout match; what only this path gives you is a real blurred shadow cast from the letterforms and glyph-accurate hit testing. Outlines come from polygon atlases generated offline (~200 kB, fetched on first open), which is why the engine ships no font parser.',
    prepare: prepareVectorTextScene,
    build: buildVectorTextScene,
  },
  {
    id: 'runtime-ttf',
    title: 'Runtime TTF',
    description:
      'The same VectorText nodes, outlines parsed from a TTF at runtime by @mvpaint/ttf. The package sits outside the engine and satisfies the VectorFonts interface, so nothing downstream of the shaper knows the source and an app that never imports it never ships a parser. Use this path for glyphs outside the prebuilt atlases\u2019 charset.',
    prepare: prepareRuntimeTtfScene,
    build: buildRuntimeTtfScene,
  },
  {
    id: 'text-path',
    title: 'Text on a path',
    description:
      'Path-driven layout: the curve supplies each glyph a position and a rotation. Circles, arcs and raw SVG path data as the driving curve, decorations and highlights following it, multi-line runs becoming concentric rings. It is a shaping option, so it applies to MSDFText and VectorText alike.',
    prepare: prepareTextPathScene,
    build: buildTextPathScene,
  },
  {
    id: 'images',
    title: 'Images',
    description:
      'Image lane: one textured quad per node. Source-rect cropping, cover fit, repeat and mirrored wrap, flips, tint, nearest-neighbour filtering, a cast shadow, and zIndex interleaving with mesh and text. Textures are built in the scene through images.fromPixels() and images.fromSvg(); the scene owns them and releases them in dispose().',
    prepare: prepareImageScene,
    build: buildImageScene,
  },
  {
    id: 'transparency',
    title: 'Transparency across lanes',
    description:
      'Straight-alpha blending within a lane and across lanes. Top row is the control (mesh, text, image blending against their own kind); the middle row mirrors each cross-lane pair by zIndex, so any difference between halves is lane-dependent and there should be none; the bottom row is shadows. Back object opaque, front translucent in every cell. The failure mode being checked for is a translucent fragment writing depth and rejecting what is behind it.',
    build: buildTransparencyScene,
  },
  {
    id: 'colors',
    title: 'Colour forms',
    description:
      'Colour parsing, each accepted string form drawn next to the [r, g, b, a] tuple it should resolve to: hex in all four lengths, rgb()/rgba() and hsl()/hsla() in legacy and space-separated syntax, numbers or percentages, hue in deg/rad/turn, keywords, transparent. A parse error shows as a seam between two touching swatches rather than a number in a log. Below, the same strings in the other ColorInput positions - stroke, shadow, gradient stop, text fill and highlight.',
    build: buildColorScene,
  },
  {
    id: 'tweens',
    title: 'Tweening',
    description:
      "Attributes carried over time. Every curve plotted from the same function the tween reads, each with a runner tracing it - and each runner is two tweens on one node, since x runs linearly while y runs through the curve. Then eight kinds of attribute animated one per cell (rotation, scale, opacity, fill, strokeWidth, cornerRadius, radius, a dash marching by restarting itself on finish), the values that are not numbers (a gradient's stops and geometry, and a points list resampled from three points to eight so the new ones grow out of the line rather than fly in), and the ends: to() chaining into its next leg from its own onFinish, and a second tween taking x off the first while the first keeps y. The scene steps a ticker of its own from onFrame, so the speed control scales the whole thing and 0 holds it still.",
    build: buildTweenScene,
  },
  {
    id: 'opacity',
    title: 'Object opacity',
    description:
      'node.opacity: a per-object multiplier applied at draw time rather than baked into fill and stroke colours, so a fade never has to read back and restore the colours it touched. The ramp, composition with an already-translucent colour, mesh/text/shadow all honouring the same property, and an animated row. Drawn over bars so the compositing is actually visible.',
    build: buildOpacityScene,
  },
  {
    id: 'shadows',
    title: 'Shadows',
    description:
      'Canvas-style shadow parameters walked one at a time - blur, offset, spread, fill-only - plus stacking. Silhouettes are baked into a shared atlas and drawn as quads, so a shadow resolves against surrounding geometry per-pixel through the depth test instead of flattening into one layer behind everything.',
    build: buildShadowScene,
  },
  {
    id: 'svg',
    title: 'SVG document',
    description:
      'loadSvgDocument() turning a document into Path nodes under one container: a fill-rule="evenodd" hole, linear and radial gradient fills, and a stroked open curve - so the loader and the tessellation/stroke geometry are exercised together. The document is placed by fit, which maps its viewBox onto a square and writes the result to the returned group rather than into the points.',
    build: buildSvgScene,
  },
  {
    id: 'svg-features',
    title: 'SVG loader features',
    description:
      "Six documents, each said twice: paint resolved from a <style> block next to the same document with no rules to resolve (which draws in SVG's initial black rather than not at all), a subpath with no `z` next to the same path with one, two same-wound rings under each fill-rule, one document fitted into three boxes by three preserveAspectRatio values, a <symbol> instanced three times by <use> over a dashed baseline, and a document of things the loader does not draw with its doc.notes printed beside it.",
    build: buildSvgFeaturesScene,
  },
  {
    id: 'zindex',
    title: 'Stacking order',
    description:
      'Default order is creation order: every node takes the next value off a running counter as its zIndex. Six panels - the default, the same rule holding across lanes (MSDFText vs mesh), and the four overrides: assignment relative to another node, nextZIndex() to bring to front, a negative value the counter can never reach, and the midpoint of two neighbours, since zIndex is a float.',
    build: buildZIndexScene,
  },
  {
    id: 'shape-stress',
    title: 'Shape stress test',
    description:
      'Mesh-lane throughput: 100000 rects, circles, polygons and stars, every one a flat opaque fill with no stroke, alpha or gradient, so what is measured is vertex and fill-rate cost without per-object material branching. The registry flags disableCulling, disableZSort and disableShadows are all set - traversal order already is stacking order here, and nothing casts. The layout is unseeded, so Reload scene reshuffles it. Zoom out for the whole field.',
    disableCulling: true,
    disableZSort: true,
    disableShadows: true,
    build: buildShapeStressScene,
  },
  {
    id: 'stress',
    title: 'Shadow stress test',
    description:
      'Roughly 1300 drifting shapes, each with its own blur radius and therefore its own baked silhouette. The whole field draws from the shadow atlas in one call and re-bakes nothing while animating - the drift only moves quads. The silhouettes overflow a 4096-texel atlas, so loading also exercises grow-and-repack. Culling stays on; zoom out for the whole grid.',
    build: buildStressScene,
  },
  {
    id: 'msdf-text-stress',
    title: 'MSDF text stress test',
    description:
      'Twenty A4 pages of randomly styled lorem ipsum, one MSDFText node per paragraph. Regular, bold, italic and bold-italic share one atlas array, so the wall batches into a single draw call however finely the styles alternate. Same words and styling as the outline-text stress test, for a like-for-like cost comparison. disableCulling is set, so every paragraph reaches the batcher - zoom out for all twenty pages.',
    disableCulling: true,
    build: buildMsdfStressScene,
  },
  {
    id: 'vector-text-stress',
    title: 'Outline text stress test',
    description:
      'The identical twenty pages through VectorText: tens of thousands of triangles per page instead of four vertices per glyph. First build is a CPU tessellation stress test as well as a GPU one; nothing re-tessellates while idle. disableCulling is set, same as the MSDF version. Fetches the glyph atlases on first open.',
    disableCulling: true,
    prepare: prepareVectorTextStressScene,
    build: buildVectorTextStressScene,
  },
  {
    id: 'svg-load-stress',
    title: 'SVG loading stress test',
    description:
      'Two real documents - Tux (47 paths, 33 gradients) and the Ghostscript tiger (240 paths of pure bezier curves) - each loaded both ways and drawn at the same size in a 2x2 grid: loadSvgDocument() into Path nodes on the left, images.fromSvg() into one texture on the right. Every cell prints what its route cost, path and triangle counts and parse/tessellate times against pixel size, memory and rasterize time. The loader reads geometry, paint, gradients and transforms but not <filter>, <clipPath> or <use>, which is why the two halves of the Tux row differ and the two halves of the tiger row do not. Zoom in for the rest of what the numbers do not show. The vector side re-loads on every build, so Reload scene re-measures it.',
    disableShadows: true,
    prepare: prepareSvgLoadStressScene,
    build: buildSvgLoadStressScene,
  },
]

export const DEFAULT_SCENE_ID = EXAMPLE_SCENES[0].id
