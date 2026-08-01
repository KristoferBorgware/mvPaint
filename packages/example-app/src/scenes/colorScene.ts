// Every way a colour can be written, side by side with the same colour written as the tuple.
//
// The point of each row is that the two halves MATCH. A parser that got a form slightly wrong -
// a hex shorthand padded instead of doubled, a percentage applied twice, a hue in the wrong
// unit - would show up as a visible seam between a pair, which is a far better test than a
// number in a log: these are the actual pixels the shader produced.
//
// The middle column of every pair is the tuple form, so a seam is always between two swatches
// that are touching.

import { Circle, Rect, Text, type ColorInput, type Scene } from '@mvpaint/engine'
import { DARK, SLATE } from './palette'
import type { SceneContent } from './types'

/** One row: a label, the string form, and the same colour as the tuple it should parse to. */
interface Row {
  written: string
  value: ColorInput
  tuple: ColorInput
}

const ROWS: Row[] = [
  // Hex, in all four lengths. The short forms double each digit, so '#c30' is '#cc3300' -
  // padding to '#0c0300' instead is the classic way to get this wrong.
  { written: "'#c30'", value: '#c30', tuple: [0xcc / 255, 0x33 / 255, 0, 1] },
  { written: "'#cc3300'", value: '#cc3300', tuple: [0xcc / 255, 0x33 / 255, 0, 1] },
  { written: "'#3c9'", value: '#3c9', tuple: [0x33 / 255, 0xcc / 255, 0x99 / 255, 1] },
  { written: "'#39c8'", value: '#39c8', tuple: [0x33 / 255, 0x99 / 255, 0xcc / 255, 0x88 / 255] },
  { written: "'#3399cc88'", value: '#3399cc88', tuple: [0x33 / 255, 0x99 / 255, 0xcc / 255, 0x88 / 255] },

  // The functional forms, in both syntaxes, with numbers and with percentages.
  { written: "'rgb(204, 51, 0)'", value: 'rgb(204, 51, 0)', tuple: [0.8, 0.2, 0, 1] },
  { written: "'rgb(204 51 0)'", value: 'rgb(204 51 0)', tuple: [0.8, 0.2, 0, 1] },
  { written: "'rgb(80% 20% 0%)'", value: 'rgb(80% 20% 0%)', tuple: [0.8, 0.2, 0, 1] },
  { written: "'rgba(204, 51, 0, 0.5)'", value: 'rgba(204, 51, 0, 0.5)', tuple: [0.8, 0.2, 0, 0.5] },
  { written: "'rgb(204 51 0 / 50%)'", value: 'rgb(204 51 0 / 50%)', tuple: [0.8, 0.2, 0, 0.5] },

  // hsl, including a hue written in each of the units it accepts. All three of the last group
  // are the same colour said three ways.
  { written: "'hsl(15 100% 40%)'", value: 'hsl(15 100% 40%)', tuple: [0.8, 0.2, 0, 1] },
  { written: "'hsla(15, 100%, 40%, 0.5)'", value: 'hsla(15, 100%, 40%, 0.5)', tuple: [0.8, 0.2, 0, 0.5] },
  { written: "'hsl(0.5turn 60% 45%)'", value: 'hsl(0.5turn 60% 45%)', tuple: [0.288, 0.72, 0.72, 1] },
  { written: "'hsl(180deg 60% 45%)'", value: 'hsl(180deg 60% 45%)', tuple: [0.288, 0.72, 0.72, 1] },
  { written: "'hsl(3.14159rad 60% 45%)'", value: 'hsl(3.14159rad 60% 45%)', tuple: [0.288, 0.72, 0.72, 1] },

  // Keywords, and the one that is an absence rather than a colour.
  { written: "'tomato'", value: 'tomato', tuple: [1, 0x63 / 255, 0x47 / 255, 1] },
  { written: "'REBECCAPURPLE'", value: 'REBECCAPURPLE', tuple: [0x66 / 255, 0x33 / 255, 0x99 / 255, 1] },
  { written: "'  teal  '", value: '  teal  ', tuple: [0, 0x80 / 255, 0x80 / 255, 1] },
  { written: "'transparent'", value: 'transparent', tuple: [0, 0, 0, 0] },
]

const SWATCH_W = 70
const SWATCH_H = 30
const GAP = 6
/** Three columns, spaced so the rightmost label still clears the side panel. */
const COLUMN_X = [-560, -236, 88]

export function buildColorScene(scene: Scene): SceneContent {
  const root = scene.root

  root.addChild(
    new Text({
      x: -560,
      y: 356,
      text: 'Every colour written two ways',
      style: { fontStyle: 'bold', fontSize: 26, color: DARK },
    }),
  )
  root.addChild(
    new Text({
      x: -560,
      y: 322,
      text: 'each pair is one swatch as a string and the same colour as the tuple - a seam between them would be a parser bug',
      style: { fontSize: 14, color: SLATE },
    }),
  )

  // Split across three columns so the whole set fits without scrolling.
  const perColumn = Math.ceil(ROWS.length / COLUMN_X.length)

  ROWS.forEach((row, i) => {
    const column = Math.floor(i / perColumn)
    const x = COLUMN_X[column]
    const y = 250 - (i % perColumn) * (SWATCH_H + 26)

    // A dark plate behind both halves. The alpha forms are the reason it is here: half of a
    // translucent pair over white and half over nothing would not be comparable at all.
    root.addChild(
      new Rect({
        name: `plate-${i}`,
        x: x - 4,
        y: y + 4,
        width: SWATCH_W * 2 + GAP + 8,
        height: SWATCH_H + 8,
        fill: '#b4bcc8',
        cornerRadius: 4,
      }),
    )

    root.addChild(new Rect({ name: `written-${i}`, x, y, width: SWATCH_W, height: SWATCH_H, fill: row.value }))
    root.addChild(
      new Rect({
        name: `tuple-${i}`,
        x: x + SWATCH_W + GAP,
        y,
        width: SWATCH_W,
        height: SWATCH_H,
        fill: row.tuple,
      }),
    )

    root.addChild(
      new Text({
        x: x + SWATCH_W * 2 + GAP + 12,
        y: y - 7,
        text: row.written,
        style: { fontSize: 13, color: DARK },
      }),
    )
  })

  // --- the same thing for the places a colour is not a fill ---------------------------------
  //
  // A string is accepted wherever a colour is, not only on `fill` - so one of each, to prove
  // the property rather than the parser. If any of these had been missed it would draw black.
  const y = -300
  root.addChild(new Text({ x: -560, y: y + 74, text: 'and everywhere else a colour goes', style: { fontStyle: 'bold', fontSize: 17, color: DARK } }))

  root.addChild(
    new Circle({ name: 'c-stroke', x: -470, y: y - 10, radius: 30, fill: 'transparent', stroke: 'seagreen', strokeWidth: 8 }),
  )
  root.addChild(new Text({ x: -520, y: y - 56, text: 'stroke', style: { fontSize: 13, color: SLATE } }))

  const shadowed = new Rect({ name: 'c-shadow', x: -350, y: y + 20, width: 60, height: 60, fill: 'white', cornerRadius: 8 })
  shadowed.shadowColor = 'rgb(0 0 0 / 70%)'
  shadowed.shadowBlur = 14
  shadowed.shadowOffsetY = 8
  root.addChild(shadowed)
  root.addChild(new Text({ x: -360, y: y - 56, text: 'shadowColor', style: { fontSize: 13, color: SLATE } }))

  const gradient = new Rect({ name: 'c-gradient', x: -180, y: y + 20, width: 120, height: 60, cornerRadius: 8 })
  gradient.fillPriority = 'linear-gradient'
  gradient.fillLinearGradientStartPoint = { x: 0, y: 0 }
  gradient.fillLinearGradientEndPoint = { x: 120, y: 0 }
  gradient.fillLinearGradientColorStops = [
    { offset: 0, color: 'gold' },
    { offset: 1, color: '#8a2be2' },
  ]
  root.addChild(gradient)
  root.addChild(new Text({ x: -180, y: y - 56, text: 'gradient stops', style: { fontSize: 13, color: SLATE } }))

  root.addChild(
    new Text({
      name: 'c-text',
      x: 10,
      y: y + 14,
      text: 'text',
      style: {
        fontSize: 46,
        fontStyle: 'bold',
        color: 'darkslateblue',
        highlight: '#ffd70066',
        shadow: { color: 'rgba(0,0,0,0.45)', offsetX: 2, offsetY: 3 },
      },
    }),
  )
  root.addChild(new Text({ x: 10, y: y - 56, text: 'colour, highlight, shadow', style: { fontSize: 13, color: SLATE } }))

  return {}
}
