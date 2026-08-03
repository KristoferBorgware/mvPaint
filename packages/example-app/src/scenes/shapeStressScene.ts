// Shape stress test: 100000 shapes - rects, circles, regular polygons and stars - scattered
// randomly across the field with random size and rotation, each a single opaque solid fill
// colour. No stroke, no alpha, no gradients: every triangle is one flat, fully-opaque colour,
// which isolates the mesh lane's raw vertex/fill-rate cost from the extra per-object material
// branching (gradient lookups, stroke geometry, alpha blending) a more varied scene adds -
// see stressScene.ts for the shadow-focused stress test, and the git history for this file's
// earlier stroke/gradient/alpha variant. Deliberately NO shadows either, same reason.
//
// Unlike the lorem-ipsum stress tests, there's no second scene this one needs to agree with,
// so it rerolls from scratch on every build() (plain Math.random(), not seeded) - which means
// "Reload scene" in the options pane genuinely reshuffles the field instead of reproducing an
// identical layout.
//
// The field grows with the count (same aspect ratio, area scaling with the count) so the
// field reads as the same density of scattered, overlapping shapes at any scale rather than
// thinning out or packing solid - zoom out to see the whole thing.
//
// This scene also sets `disableCulling` in the registry (scenes/index.ts): the point is to
// stress-test drawing every one of the 100000 shapes, and viewport culling would otherwise
// mean only whatever the camera happens to be framing actually reaches the mesh batcher -
// true even at the default zoom, since the field is larger than the default view.

import { Circle, Path, Rect, Text, type Vector2Like, type RGBA, type Scene, type Shape } from '@mvpaint/engine'
import { DARK, SLATE } from './palette'
import type { SceneContent } from './types'

const COUNT = 100000
// Scaled from the 500-shape original by sqrt(count ratio) per axis, so area grows with count
// and the scattered/overlapping density stays the same at every scale (~1300 sq units/shape)
// instead of thinning out or packing solid.
const FIELD_HALF_WIDTH = 6700
const FIELD_HALF_HEIGHT = 4838

type Kind = 'rect' | 'circle' | 'polygon' | 'star'
const KINDS: readonly Kind[] = ['rect', 'circle', 'polygon', 'star']

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function pick<T>(options: readonly T[]): T {
  return options[Math.floor(Math.random() * options.length)]
}

/**
 * HSL -> RGBA, so each shape gets an independently random hue at a controlled saturation and
 * lightness rather than raw random RGB, which reads as muddy far more often than it reads as
 * "colourful". Always fully opaque - no alpha blending in this scene.
 */
function hslColor(h: number, s: number, l: number): RGBA {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (h % 1) * 6
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = l - c / 2
  return [r + m, g + m, b + m, 1]
}

function randomFillColor(): RGBA {
  return hslColor(Math.random(), randomBetween(0.55, 0.85), randomBetween(0.4, 0.62))
}

function regularPolygonPoints(sides: number, radius: number): Vector2Like[] {
  const points: Vector2Like[] = []
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 - Math.PI / 2
    points.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius })
  }
  return points
}

function starPoints(spikes: number, outerRadius: number, innerRadius: number): Vector2Like[] {
  const points: Vector2Like[] = []
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outerRadius : innerRadius
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2
    points.push({ x: Math.cos(a) * r, y: Math.sin(a) * r })
  }
  return points
}

export function buildShapeStressScene(scene: Scene): SceneContent {
  const root = scene.root

  for (let i = 0; i < COUNT; i++) {
    const kind = pick(KINDS)
    const x = randomBetween(-FIELD_HALF_WIDTH, FIELD_HALF_WIDTH)
    const y = randomBetween(-FIELD_HALF_HEIGHT, FIELD_HALF_HEIGHT)
    const rotation = Math.random() * Math.PI * 2

    const shared = {
      name: `shape-stress-${i}`,
      x,
      y,
      rotation,
      fill: randomFillColor(),
      // This scene is deliberately shadow-free - see stressScene.ts for the shadow stress test.
      shadowEnabled: false,
    }

    let node: Shape
    switch (kind) {
      case 'rect': {
        const width = randomBetween(16, 90)
        const height = randomBetween(16, 90)
        // Pivoted at its middle, so a random rotation spins the rect where it stands
        // instead of swinging it off its spot about its top-left corner.
        node = new Rect({ ...shared, width, height, offsetX: width / 2, offsetY: -height / 2, scaleX: randomBetween(0.7, 1.3), scaleY: randomBetween(0.7, 1.3) })
        break
      }
      case 'circle': {
        const radius = randomBetween(10, 46)
        node = new Circle({ ...shared, radius, scaleX: randomBetween(0.6, 1.6), scaleY: randomBetween(0.6, 1.6) })
        break
      }
      case 'polygon': {
        const sides = 3 + Math.floor(Math.random() * 6)
        const radius = randomBetween(14, 48)
        node = new Path({ ...shared, contours: [{ points: regularPolygonPoints(sides, radius), closed: true }], filled: true })
        break
      }
      case 'star': {
        const spikes = 4 + Math.floor(Math.random() * 4)
        const outerRadius = randomBetween(18, 50)
        const points = starPoints(spikes, outerRadius, outerRadius * randomBetween(0.4, 0.55))
        node = new Path({ ...shared, contours: [{ points, closed: true }], filled: true })
        break
      }
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
      text: 'Random size, rotation and colour across rects, circles, polygons and stars - solid fill only, no stroke or alpha.',
      style: { fontSize: 17, color: SLATE },
    }),
  )

  return {}
}
