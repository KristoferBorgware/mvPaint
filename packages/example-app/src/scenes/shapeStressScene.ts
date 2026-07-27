// Shape stress test: 500 shapes - rects, circles, regular polygons, stars and stroked lines -
// scattered randomly across the field with random size, rotation, stroke (or none), stroke
// width, fill colour (solid or gradient), and opacity. Deliberately NO shadows: this is a
// mesh-lane volume-and-variety test, not the shadow atlas's - see stressScene.ts for that one.
//
// Unlike the lorem-ipsum stress tests, there's no second scene this one needs to agree with,
// so it rerolls from scratch on every build() (plain Math.random(), not seeded) - which means
// "Reload scene" in the options pane genuinely reshuffles the field instead of reproducing an
// identical layout.

import { Circle, Path, Polyline, Rect, Text, type Point2, type RGBA, type Scene, type Shape } from '@mvpaint/engine'
import { DARK, SLATE } from './palette'
import type { SceneContent } from './types'

const COUNT = 500
const FIELD_HALF_WIDTH = 480
const FIELD_HALF_HEIGHT = 340

type Kind = 'rect' | 'circle' | 'polygon' | 'star' | 'line'
const KINDS: readonly Kind[] = ['rect', 'circle', 'polygon', 'star', 'line']
const JOINS = ['miter', 'round', 'bevel'] as const
const CAPS = ['butt', 'round', 'square'] as const

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function pick<T>(options: readonly T[]): T {
  return options[Math.floor(Math.random() * options.length)]
}

/**
 * HSL -> RGBA, so each shape gets an independently random hue at a controlled saturation and
 * lightness rather than raw random RGB, which reads as muddy far more often than it reads as
 * "colourful".
 */
function hslColor(h: number, s: number, l: number, a = 1): RGBA {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (h % 1) * 6
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = l - c / 2
  return [r + m, g + m, b + m, a]
}

function randomFillColor(alpha: number): RGBA {
  return hslColor(Math.random(), randomBetween(0.55, 0.85), randomBetween(0.4, 0.62), alpha)
}

/** A darker shade of `color`, so a stroke reads as its own fill's outline, not an unrelated accent. */
function darken(color: RGBA, amount: number): RGBA {
  return [color[0] * (1 - amount), color[1] * (1 - amount), color[2] * (1 - amount), color[3]]
}

function regularPolygonPoints(sides: number, radius: number): Point2[] {
  const points: Point2[] = []
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 - Math.PI / 2
    points.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius })
  }
  return points
}

function starPoints(spikes: number, outerRadius: number, innerRadius: number): Point2[] {
  const points: Point2[] = []
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outerRadius : innerRadius
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2
    points.push({ x: Math.cos(a) * r, y: Math.sin(a) * r })
  }
  return points
}

function zigzagPoints(length: number, segments: number): Point2[] {
  const points: Point2[] = []
  for (let i = 0; i <= segments; i++) {
    points.push({ x: -length / 2 + (i / segments) * length, y: (i % 2 === 0 ? -1 : 1) * length * 0.18 })
  }
  return points
}

/** Paints a gradient (linear or radial) across `shape`'s own local footprint, sized to `extent`. */
function applyGradient(shape: Shape, from: RGBA, extent: number): void {
  const to = randomFillColor(1)
  if (Math.random() < 0.5) {
    shape.fillPriority = 'linear-gradient'
    shape.fillLinearGradientStartPoint = { x: -extent, y: -extent }
    shape.fillLinearGradientEndPoint = { x: extent, y: extent }
    shape.fillLinearGradientColorStops = [
      { offset: 0, color: from },
      { offset: 1, color: to },
    ]
  } else {
    shape.fillPriority = 'radial-gradient'
    shape.fillRadialGradientStartPoint = { x: 0, y: 0 }
    shape.fillRadialGradientStartRadius = 0
    shape.fillRadialGradientEndPoint = { x: 0, y: 0 }
    shape.fillRadialGradientEndRadius = extent
    shape.fillRadialGradientColorStops = [
      { offset: 0, color: from },
      { offset: 1, color: to },
    ]
  }
}

export function buildShapeStressScene(scene: Scene): SceneContent {
  const root = scene.root

  for (let i = 0; i < COUNT; i++) {
    const kind = pick(KINDS)
    const x = randomBetween(-FIELD_HALF_WIDTH, FIELD_HALF_WIDTH)
    const y = randomBetween(-FIELD_HALF_HEIGHT, FIELD_HALF_HEIGHT)
    const rotation = Math.random() * Math.PI * 2

    // A stroke-only 'line' has nothing to see without a stroke; every other kind is filled
    // regardless, so its stroke is optional - about half get one.
    const strokeWidth = kind === 'line' ? randomBetween(2, 9) : Math.random() < 0.55 ? randomBetween(1.5, 7) : 0

    // Occasionally an "outline only" shape: zero fill alpha with a guaranteed visible stroke,
    // rather than every one of the 500 being a solid blob.
    const outlineOnly = kind !== 'line' && Math.random() < 0.15
    const fill = randomFillColor(outlineOnly ? 0 : randomBetween(0.6, 1))
    const stroke = darken(fill[3] === 0 ? randomFillColor(1) : fill, randomBetween(0.35, 0.6))

    const shared = {
      name: `shape-stress-${i}`,
      x,
      y,
      rotation,
      fill,
      stroke,
      strokeWidth: outlineOnly ? Math.max(strokeWidth, randomBetween(2, 6)) : strokeWidth,
      lineJoin: pick(JOINS),
      // This scene is deliberately shadow-free - see stressScene.ts for the shadow stress test.
      shadowEnabled: false,
    }

    let node: Shape
    let extent: number
    switch (kind) {
      case 'rect': {
        const width = randomBetween(16, 90)
        const height = randomBetween(16, 90)
        extent = Math.max(width, height) / 2
        node = new Rect({ ...shared, width, height, scaleX: randomBetween(0.7, 1.3), scaleY: randomBetween(0.7, 1.3) })
        break
      }
      case 'circle': {
        const radius = randomBetween(10, 46)
        extent = radius
        node = new Circle({ ...shared, radius, scaleX: randomBetween(0.6, 1.6), scaleY: randomBetween(0.6, 1.6) })
        break
      }
      case 'polygon': {
        const sides = 3 + Math.floor(Math.random() * 6)
        const radius = randomBetween(14, 48)
        extent = radius
        node = new Path({ ...shared, contours: [{ points: regularPolygonPoints(sides, radius), closed: true }], filled: true })
        break
      }
      case 'star': {
        const spikes = 4 + Math.floor(Math.random() * 4)
        const outerRadius = randomBetween(18, 50)
        extent = outerRadius
        const points = starPoints(spikes, outerRadius, outerRadius * randomBetween(0.4, 0.55))
        node = new Path({ ...shared, contours: [{ points, closed: true }], filled: true })
        break
      }
      case 'line': {
        const length = randomBetween(40, 130)
        extent = length / 2
        node = new Polyline({
          ...shared,
          points: zigzagPoints(length, 2 + Math.floor(Math.random() * 3)),
          closed: false,
          lineCap: pick(CAPS),
        })
        break
      }
    }

    // Polyline is stroke-only (no fill triangles at all - see Polyline.ts), so a gradient
    // would have nothing to paint; every other kind gets one about 30% of the time.
    if (kind !== 'line' && !outlineOnly && Math.random() < 0.3) {
      applyGradient(node, fill, extent)
    }

    root.addChild(node)
  }

  root.addChild(
    new Text({
      name: 'shape-stress-title',
      x: -FIELD_HALF_WIDTH,
      y: FIELD_HALF_HEIGHT + 90,
      text: `${COUNT} shapes, no shadows`,
      style: { fontStyle: 'bold', fontSize: 32, color: DARK },
    }),
  )
  root.addChild(
    new Text({
      name: 'shape-stress-note',
      x: -FIELD_HALF_WIDTH,
      y: FIELD_HALF_HEIGHT + 54,
      text: 'Random size, rotation, stroke and colour across rects, circles, polygons, stars and lines.',
      style: { fontSize: 17, color: SLATE },
    }),
  )

  return {}
}
