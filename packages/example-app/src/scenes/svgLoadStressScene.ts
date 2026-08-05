// The two ways an SVG can enter a scene, put side by side on artwork that is actually hard.
//
// The `svg` scene next door loads a three-element document, which shows that the loader works
// but says nothing about what it costs. These two are real files: Tux is 47 paths carrying 33
// gradients, and the Ghostscript tiger is 240 paths of nothing but bezier curves - about a
// thousand triangles against thirty thousand, from documents that look equally complicated.
// Both go in twice - once through loadSvgDocument(), which flattens every curve and turns the
// document into Path nodes the mesh lane tessellates, and once through images.fromSvg(), which
// hands the whole document to the browser's rasterizer and gets back one texture.
//
// The grid is 2x2: one row per document, polygons on the left and the rasterized image on the
// right, drawn at the same size so the only difference between the halves is how they got
// there. Each cell prints what its route actually cost - path count, triangle count and the
// parse and tessellation times on the left; the texture's pixel size, its memory and the
// rasterize time on the right.
//
// Two things the numbers do not show, and the reason to zoom in on this scene:
//
//   - The polygons stay sharp at any zoom and the textures do not. That is the whole trade,
//     and it is why the raster side is rasterized at 2x rather than at 1x - a fair fight puts
//     the texture at the resolution an application would actually pick, and it still goes soft
//     a couple of zoom steps in.
//   - The loader covers geometry, paint, gradients and transforms. It does not do <use>,
//     <clipPath> or <filter>, all of which Tux uses, so the vector Tux is missing its soft
//     shadows and highlights while the raster one has them. The tiger uses none of those and
//     the two halves of its row should be hard to tell apart.
//
// The vector side is re-parsed and re-tessellated on every build, so "Reload scene" in the
// options pane re-measures it. The textures are rasterized once in prepare() and memoized
// across builds (which is why build() must not destroy them), so their time is a first-open
// figure - stated as such in the caption rather than quietly re-reported as if it were paid
// again.

import {
  Image,
  Path,
  Rect,
  MSDFText,
  loadSvgDocument,
  svgIntrinsicSize,
  svgViewBox,
  type Container,
  type ImageTexture,
  type MeshSink,
  type Scene,
  type SceneResources,
} from '@mvpaint/engine'
import { CRIMSON, DARK, SLATE, TEAL, withAlpha } from './palette'
import type { SceneContent } from './types'

import tigerSvg from '../assets/tiger.svg?raw'
import tuxSvg from '../assets/Tux.svg?raw'

// Vertical layout. Every y here is a TOP edge, because that is where an MSDFText node's origin is
// and where a Rect's is - so a block occupies `y` downwards by however tall it turns out to
// be, and the constants below are spaced by the measured height of what sits above them.
// Nothing here re-flows, so a longer caption or one more stats line means re-checking these.

/** The square each document is fitted into, in world units. Both versions share it. */
const BOX = 230
/** Centres of the two columns - the gap between the boxes is what is left over. */
const COLUMN_X = 265
/**
 * The grid's own middle, and how far each row's centre sits from it.
 *
 * The grid is not centred on the world origin, because the scene is not the grid: there is one
 * heading above it and two notes below, and they are not the same height. This offset is what
 * puts the WHOLE thing about the origin, which is where the app's camera looks.
 */
const GRID_CENTER_Y = 45
const ROW_OFFSET = 205

/** Caption top above a box's centre, and where the stats lines start below it. */
const CAPTION_Y = 150
const STATS_Y = -133
const STATS_LINE = 24

/** The heading above the grid, and the two notes under it. */
const TITLE_Y = 515
const SUBTITLE_Y = 469
const COVERAGE_NOTE_Y = -375
const ZOOM_NOTE_Y = -489
/** Both columns of one row, which is what the full-width paragraphs wrap against. */
const GRID_WIDTH = 2 * COLUMN_X + BOX

/**
 * How many pixels each rasterization gets per world unit. 2 is what an application targeting a
 * retina display would pick; it is high enough that the raster cells look right at the default
 * zoom, which is what makes the blur at 4x actually mean something.
 */
const RASTER_SCALE = 2

interface AssetSpec {
  key: string
  title: string
  svg: string
}

// Ordered by how hard they are on the loader, easiest first, so the row below is the worse
// case in every number.
const ASSETS: readonly AssetSpec[] = [
  { key: 'tux', title: 'Tux', svg: tuxSvg },
  { key: 'tiger', title: 'Tiger', svg: tigerSvg },
]

/** A document's own coordinate rectangle: its viewBox, or its intrinsic size at the origin. */
function documentRect(svgText: string, title: string): { x: number; y: number; width: number; height: number } {
  const box = svgViewBox(svgText)
  if (box) return box
  const size = svgIntrinsicSize(svgText)
  if (!size) throw new Error(`${title}.svg has neither a viewBox nor a size to scale it by`)
  return { x: 0, y: 0, ...size }
}

/** The world-unit size a document takes when scaled uniformly to fit BOX. */
function fitToBox(width: number, height: number): { scale: number; width: number; height: number } {
  const scale = BOX / Math.max(width, height)
  return { scale, width: width * scale, height: height * scale }
}

function cellCenter(column: number, row: number): { x: number; y: number } {
  return {
    x: column === 0 ? -COLUMN_X : COLUMN_X,
    y: GRID_CENTER_Y + (row === 0 ? ROW_OFFSET : -ROW_OFFSET),
  }
}

interface MeshCount {
  vertices: number
  triangles: number
}

/**
 * A MeshSink that keeps nothing and counts everything.
 *
 * `vertex()` owes its caller a shape-local index, and a post-increment hands back exactly the
 * 0-based index the next `triangle()` call will refer to - so this satisfies the contract
 * without storing a single coordinate. Tessellating through it is not wasted work either: the
 * shape caches its triangles on the first call whatever sink asked for them, so the mesh lane
 * replays that cache later rather than building the geometry a second time.
 */
function countingSink(count: MeshCount): MeshSink {
  return {
    vertex: () => count.vertices++,
    triangle: () => {
      count.triangles++
    },
  }
}

interface VectorLoad {
  doc: Container
  paths: number
  triangles: number
  parseMs: number
  tessellateMs: number
}

/**
 * Parse a document into Path nodes centred on a cell, then force the tessellation the mesh
 * lane would otherwise do on the first frame, timing each half separately.
 *
 * They are timed apart because they are different costs with different causes: parsing is the
 * DOM walk plus curve flattening and scales with how many curve segments the file has, while
 * tessellation is earcut plus the stroker and scales with how many points came out of that
 * flattening. Tolerance moves both, in opposite proportions.
 */
function loadVector(asset: AssetSpec, center: { x: number; y: number }): VectorLoad {
  const rect = documentRect(asset.svg, asset.title)
  const { scale } = fitToBox(rect.width, rect.height)

  // SVG is y-down and the scene is y-up, so d is negated; e and f then put the middle of the
  // document's own rectangle at the middle of the cell.
  const parseStart = performance.now()
  const doc = loadSvgDocument(asset.svg, {
    rootMatrix: [
      scale,
      0,
      0,
      -scale,
      center.x - (rect.x + rect.width / 2) * scale,
      center.y + (rect.y + rect.height / 2) * scale,
    ],
  })
  const parseMs = performance.now() - parseStart

  const count: MeshCount = { vertices: 0, triangles: 0 }
  const sink = countingSink(count)
  let paths = 0
  const tessellateStart = performance.now()
  doc.traversePreOrder((node) => {
    if (!(node instanceof Path)) return
    paths++
    node.tessellate(sink)
  })
  const tessellateMs = performance.now() - tessellateStart

  return { doc, paths, triangles: count.triangles, parseMs, tessellateMs }
}

interface RasterLoad {
  texture: ImageTexture
  ms: number
}

// Rasterized once and handed out again on every build - fromSvg is asynchronous, so it cannot
// happen in build() anyway, and re-rasterizing the same two documents on every switch back
// would be work nobody asked for. build() must therefore NOT destroy these.
let rasters: Map<string, RasterLoad> | null = null

export async function prepareSvgLoadStressScene({ images }: SceneResources): Promise<void> {
  if (rasters) return
  const loaded = new Map<string, RasterLoad>()
  // Sequentially rather than through Promise.all: the two timings are the point, and
  // overlapping decodes would report each document as having taken as long as both.
  for (const asset of ASSETS) {
    const rect = documentRect(asset.svg, asset.title)
    const fitted = fitToBox(rect.width, rect.height)
    const start = performance.now()
    const texture = await images.fromSvg(asset.svg, {
      width: Math.round(fitted.width),
      height: Math.round(fitted.height),
      scale: RASTER_SCALE,
      label: `svg-stress-${asset.key}`,
    })
    loaded.set(asset.key, { texture, ms: performance.now() - start })
  }
  rasters = loaded
}

function integer(value: number): string {
  return value.toLocaleString('en-US')
}

function millis(value: number): string {
  return `${value.toFixed(1)} ms`
}

/** Straight RGBA8, which is what every texture here is uploaded as. */
function megabytes(width: number, height: number): string {
  return `${((width * height * 4) / (1024 * 1024)).toFixed(1)} MB`
}

export function buildSvgLoadStressScene(scene: Scene): SceneContent {
  const root = scene.root
  if (!rasters) throw new Error('The SVG documents are not rasterized yet')
  const textures = rasters

  const caption = (x: number, y: number, text: string, color: string) =>
    new MSDFText({ name: `svg-stress-caption-${text}`, x, y, text, style: { fontStyle: 'bold', fontSize: 17, color } })

  const stats = (x: number, y: number, lines: readonly string[], key: string) =>
    lines.map(
      (line, i) =>
        new MSDFText({
          name: `svg-stress-stat-${key}-${i}`,
          x,
          y: y + STATS_Y - i * STATS_LINE,
          text: line,
          style: { fontSize: 15, color: SLATE },
        }),
    )

  // The four cell frames first, so nothing has to be stacked over them: they are there to make
  // the grid and its spacing legible, not to be looked at.
  for (let row = 0; row < ASSETS.length; row++) {
    for (let column = 0; column < 2; column++) {
      const center = cellCenter(column, row)
      root.addChild(
        new Rect({
          name: `svg-stress-frame-${row}-${column}`,
          x: center.x - BOX / 2,
          y: center.y + BOX / 2,
          width: BOX,
          height: BOX,
          fill: 'transparent',
          stroke: withAlpha(SLATE, 0.28),
          strokeWidth: 1,
        }),
      )
    }
  }

  ASSETS.forEach((asset, row) => {
    const rect = documentRect(asset.svg, asset.title)
    const fitted = fitToBox(rect.width, rect.height)
    const left = cellCenter(0, row)
    const right = cellCenter(1, row)
    const leftEdge = left.x - BOX / 2
    const rightEdge = right.x - BOX / 2

    // Left: the document as geometry.
    const vector = loadVector(asset, left)
    vector.doc.name = `svg-stress-vector-${asset.key}`
    root.addChild(vector.doc)
    root.addChild(caption(leftEdge, left.y + CAPTION_Y, `${asset.title} - polygons`, TEAL))
    for (const line of stats(
      leftEdge,
      left.y,
      [
        `${integer(vector.paths)} paths - ${integer(vector.triangles)} triangles`,
        `parse + flatten ${millis(vector.parseMs)}`,
        `tessellate ${millis(vector.tessellateMs)}`,
      ],
      `${asset.key}-vector`,
    )) {
      root.addChild(line)
    }

    // Right: the same document as one textured quad.
    const raster = textures.get(asset.key)
    if (!raster) throw new Error(`No rasterized texture for ${asset.key}`)
    root.addChild(
      new Image({
        name: `svg-stress-image-${asset.key}`,
        texture: raster.texture,
        x: right.x - fitted.width / 2,
        y: right.y + fitted.height / 2,
        width: fitted.width,
        height: fitted.height,
      }),
    )
    root.addChild(caption(rightEdge, right.y + CAPTION_Y, `${asset.title} - image`, CRIMSON))
    for (const line of stats(
      rightEdge,
      right.y,
      [
        '1 quad - 2 triangles',
        `raster ${raster.texture.width} x ${raster.texture.height} px - ${megabytes(raster.texture.width, raster.texture.height)}`,
        `rasterize + upload ${millis(raster.ms)}, once`,
      ],
      `${asset.key}-image`,
    )) {
      root.addChild(line)
    }
  })

  const gridLeft = -COLUMN_X - BOX / 2
  root.addChild(
    new MSDFText({
      name: 'svg-stress-title',
      x: gridLeft,
      y: TITLE_Y,
      text: 'SVG loading: polygons vs image',
      style: { fontStyle: 'bold', fontSize: 30, color: DARK },
    }),
  )
  root.addChild(
    new MSDFText({
      name: 'svg-stress-subtitle',
      x: gridLeft,
      y: SUBTITLE_Y,
      maxWidth: GRID_WIDTH,
      text: `Each document loaded twice and drawn at the same size: loadSvgDocument() into Path nodes on the left, images.fromSvg() at ${RASTER_SCALE}x into one texture on the right.`,
      style: { fontSize: 16, color: SLATE },
      lineHeight: 1.35,
    }),
  )

  // Why the two halves of the Tux row do not match, said where it is being looked at. The
  // lead-in is its own run so it can be bold and coloured without a second node - an MSDFText
  // node's runs are styled independently and shape as one block.
  root.addChild(
    new MSDFText({
      name: 'svg-stress-coverage-note',
      x: gridLeft,
      y: COVERAGE_NOTE_Y,
      maxWidth: GRID_WIDTH,
      runs: [
        {
          text: 'Not all of SVG survives the polygon route. ',
          style: { fontStyle: 'bold', fontSize: 15, color: CRIMSON },
        },
        {
          text:
            'loadSvgDocument() reads geometry, paint, gradients and transforms, but not <filter>, <clipPath> or <use>. Tux uses all three, so its polygon half has none of the blurred shadows and clipped highlights its image half shows. The tiger uses none of them, and its two halves should be hard to tell apart.',
          style: { fontSize: 15, color: withAlpha(DARK, 0.7) },
        },
      ],
      lineHeight: 1.4,
    }),
  )

  root.addChild(
    new MSDFText({
      name: 'svg-stress-zoom-note',
      x: gridLeft,
      y: ZOOM_NOTE_Y,
      maxWidth: GRID_WIDTH,
      text:
        'Zoom in: the polygons stay sharp at any magnification, and the textures go soft past their raster scale.',
      style: { fontSize: 15, color: withAlpha(DARK, 0.7) },
      lineHeight: 1.4,
    }),
  )

  // No dispose: every texture here is memoized in prepare() and handed to the next build.
  return {}
}
