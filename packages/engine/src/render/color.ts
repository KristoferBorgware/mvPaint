// Colours: the tuple the engine works in, and the strings it will accept instead.
//
// Everything downstream of a scene node - the batchers, the object records, the shaders - works
// in straight-alpha RGBA with each channel in 0..1, because that is what a shader wants and
// converting per frame would be absurd. So a string is an INPUT format, never a stored one:
// parseColor turns it into the tuple once, at the point of assignment, and nothing past that
// knows a string was ever involved.
//
// What is accepted:
//
//   [r, g, b, a]                  the tuple itself, 0..1 per channel, passed through untouched
//   '#f00' '#f00c'                three or four hex digits, each doubled
//   '#ff0000' '#ff0000cc'         six or eight hex digits
//   'rgb(255 0 0)' 'rgb(255,0,0)' space- or comma-separated, numbers or percentages
//   'rgba(255 0 0 / 80%)'         alpha after a slash, or as a fourth component
//   'hsl(0 100% 50%)'             hue in deg/grad/rad/turn or bare, s and l as percentages
//   'red' 'rebeccapurple'         the colour keywords
//   'transparent'                 shorthand for a fully transparent black
//
// Case and surrounding whitespace do not matter. Anything else THROWS rather than falling back
// to a default: a mistyped colour that silently renders black is a bug that looks like a design
// decision, and the message costs nothing at the one place it can be raised usefully.

/** Straight-alpha RGBA, each channel 0..1. What everything below the scene graph works in. */
export type RGBA = readonly [number, number, number, number]

/**
 * Anything a colour can be written as. The tuple is the engine's own form; a string is
 * converted to it on assignment (see parseColor).
 */
export type ColorInput = RGBA | string

/** A gradient stop as it may be written: its colour in either form. */
export interface ColorStopInput {
  offset: number
  color: ColorInput
}

/**
 * #54B435 - the mv green, and the default for every piece of editor furniture the engine
 * draws itself: the transformer's frame and handles, the marquee box.
 *
 * It lives here, in the colours module, rather than in whichever of those happened to want
 * it first, because the point of a house colour is that they all agree on it - two copies
 * of the tuple is exactly how the frame and the marquee come to be different greens. An
 * application building furniture of its own can reach for it for the same reason.
 */
export const MV_GREEN: RGBA = [0x54 / 255, 0xb4 / 255, 0x35 / 255, 1]

/** The colour keywords, as 0xRRGGBB. */
const NAMED: Record<string, number> = {
  aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4,
  azure: 0xf0ffff, beige: 0xf5f5dc, bisque: 0xffe4c4, black: 0x000000,
  blanchedalmond: 0xffebcd, blue: 0x0000ff, blueviolet: 0x8a2be2, brown: 0xa52a2a,
  burlywood: 0xdeb887, cadetblue: 0x5f9ea0, chartreuse: 0x7fff00, chocolate: 0xd2691e,
  coral: 0xff7f50, cornflowerblue: 0x6495ed, cornsilk: 0xfff8dc, crimson: 0xdc143c,
  cyan: 0x00ffff, darkblue: 0x00008b, darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b,
  darkgray: 0xa9a9a9, darkgreen: 0x006400, darkgrey: 0xa9a9a9, darkkhaki: 0xbdb76b,
  darkmagenta: 0x8b008b, darkolivegreen: 0x556b2f, darkorange: 0xff8c00, darkorchid: 0x9932cc,
  darkred: 0x8b0000, darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f, darkslateblue: 0x483d8b,
  darkslategray: 0x2f4f4f, darkslategrey: 0x2f4f4f, darkturquoise: 0x00ced1, darkviolet: 0x9400d3,
  deeppink: 0xff1493, deepskyblue: 0x00bfff, dimgray: 0x696969, dimgrey: 0x696969,
  dodgerblue: 0x1e90ff, firebrick: 0xb22222, floralwhite: 0xfffaf0, forestgreen: 0x228b22,
  fuchsia: 0xff00ff, gainsboro: 0xdcdcdc, ghostwhite: 0xf8f8ff, gold: 0xffd700,
  goldenrod: 0xdaa520, gray: 0x808080, green: 0x008000, greenyellow: 0xadff2f,
  grey: 0x808080, honeydew: 0xf0fff0, hotpink: 0xff69b4, indianred: 0xcd5c5c,
  indigo: 0x4b0082, ivory: 0xfffff0, khaki: 0xf0e68c, lavender: 0xe6e6fa,
  lavenderblush: 0xfff0f5, lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd, lightblue: 0xadd8e6,
  lightcoral: 0xf08080, lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2, lightgray: 0xd3d3d3,
  lightgreen: 0x90ee90, lightgrey: 0xd3d3d3, lightpink: 0xffb6c1, lightsalmon: 0xffa07a,
  lightseagreen: 0x20b2aa, lightskyblue: 0x87cefa, lightslategray: 0x778899, lightslategrey: 0x778899,
  lightsteelblue: 0xb0c4de, lightyellow: 0xffffe0, lime: 0x00ff00, limegreen: 0x32cd32,
  linen: 0xfaf0e6, magenta: 0xff00ff, maroon: 0x800000, mediumaquamarine: 0x66cdaa,
  mediumblue: 0x0000cd, mediumorchid: 0xba55d3, mediumpurple: 0x9370db, mediumseagreen: 0x3cb371,
  mediumslateblue: 0x7b68ee, mediumspringgreen: 0x00fa9a, mediumturquoise: 0x48d1cc,
  mediumvioletred: 0xc71585, midnightblue: 0x191970, mintcream: 0xf5fffa, mistyrose: 0xffe4e1,
  moccasin: 0xffe4b5, navajowhite: 0xffdead, navy: 0x000080, oldlace: 0xfdf5e6,
  olive: 0x808000, olivedrab: 0x6b8e23, orange: 0xffa500, orangered: 0xff4500,
  orchid: 0xda70d6, palegoldenrod: 0xeee8aa, palegreen: 0x98fb98, paleturquoise: 0xafeeee,
  palevioletred: 0xdb7093, papayawhip: 0xffefd5, peachpuff: 0xffdab9, peru: 0xcd853f,
  pink: 0xffc0cb, plum: 0xdda0dd, powderblue: 0xb0e0e6, purple: 0x800080,
  rebeccapurple: 0x663399, red: 0xff0000, rosybrown: 0xbc8f8f, royalblue: 0x4169e1,
  saddlebrown: 0x8b4513, salmon: 0xfa8072, sandybrown: 0xf4a460, seagreen: 0x2e8b57,
  seashell: 0xfff5ee, sienna: 0xa0522d, silver: 0xc0c0c0, skyblue: 0x87ceeb,
  slateblue: 0x6a5acd, slategray: 0x708090, slategrey: 0x708090, snow: 0xfffafa,
  springgreen: 0x00ff7f, steelblue: 0x4682b4, tan: 0xd2b48c, teal: 0x008080,
  thistle: 0xd8bfd8, tomato: 0xff6347, turquoise: 0x40e0d0, violet: 0xee82ee,
  wheat: 0xf5deb3, white: 0xffffff, whitesmoke: 0xf5f5f5, yellow: 0xffff00,
  yellowgreen: 0x9acd32,
}

const TRANSPARENT: RGBA = [0, 0, 0, 0]

/** True for the tuple form, which is passed through rather than parsed. */
export function isRGBA(value: ColorInput): value is RGBA {
  return typeof value !== 'string'
}

/**
 * A colour in whatever form, as the engine's tuple.
 *
 * A tuple comes back unchanged - not copied, since these are treated as immutable throughout
 * and copying every assignment would allocate for nothing.
 *
 * Throws on a string it cannot read. See the file header for why that is better than a default.
 */
export function parseColor(input: ColorInput): RGBA {
  if (isRGBA(input)) return input

  const text = input.trim().toLowerCase()
  if (text === 'transparent') return TRANSPARENT

  const named = NAMED[text]
  if (named !== undefined) return fromHexNumber(named, 1)

  if (text.startsWith('#')) return parseHex(text)

  const open = text.indexOf('(')
  if (open > 0 && text.endsWith(')')) {
    const fn = text.slice(0, open)
    const args = splitArgs(text.slice(open + 1, -1))
    if (fn === 'rgb' || fn === 'rgba') return parseRgb(args, text)
    if (fn === 'hsl' || fn === 'hsla') return parseHsl(args, text)
  }

  throw new Error(`Unrecognised colour: ${JSON.stringify(input)}.`)
}

/**
 * Every stop of a gradient, converted. Separate only because the mapping is the same three
 * lines in each of the places that hold a stop list.
 */
export function parseStops<T extends { offset: number; color: ColorInput }>(
  stops: readonly T[],
): { offset: number; color: RGBA }[] {
  return stops.map((stop) => ({ offset: stop.offset, color: parseColor(stop.color) }))
}

function fromHexNumber(hex: number, alpha: number): RGBA {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255, alpha]
}

function parseHex(text: string): RGBA {
  const digits = text.slice(1)
  if (!/^[0-9a-f]+$/.test(digits)) throw new Error(`Unrecognised colour: ${JSON.stringify(text)}.`)

  // Three and four digit forms double each digit, so #abc is #aabbcc - the shorthand is a
  // shorthand for exactly that, not for #0a0b0c.
  const expand = (i: number): number => parseInt(digits[i] + digits[i], 16) / 255
  const pair = (i: number): number => parseInt(digits.slice(i, i + 2), 16) / 255

  switch (digits.length) {
    case 3:
      return [expand(0), expand(1), expand(2), 1]
    case 4:
      return [expand(0), expand(1), expand(2), expand(3)]
    case 6:
      return [pair(0), pair(2), pair(4), 1]
    case 8:
      return [pair(0), pair(2), pair(4), pair(6)]
    default:
      throw new Error(`A hex colour needs 3, 4, 6 or 8 digits: ${JSON.stringify(text)}.`)
  }
}

/**
 * The arguments of a functional colour, in either syntax.
 *
 * Commas and whitespace are both separators, and a slash introduces the alpha - so
 * `rgb(255,0,0,0.5)`, `rgb(255 0 0 / 50%)` and `rgba(255, 0, 0, 0.5)` all arrive here as four
 * pieces and are handled identically below.
 */
function splitArgs(body: string): string[] {
  return body
    .split(/[\s,/]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** A number, or a percentage of `full`. */
function component(text: string, full: number, label: string, whole: string): number {
  const percent = text.endsWith('%')
  const value = Number.parseFloat(percent ? text.slice(0, -1) : text)
  if (!Number.isFinite(value)) throw new Error(`Bad ${label} in ${JSON.stringify(whole)}.`)
  return percent ? (value / 100) * full : value
}

/**
 * A 0..1 fraction from a percentage. The '%' is optional: saturation and lightness are
 * percentages by definition, so a bare `50` means the same as `50%` and reading it as a raw
 * fraction would make every such colour almost black.
 */
function percentage(text: string, label: string, whole: string): number {
  const value = Number.parseFloat(text.endsWith('%') ? text.slice(0, -1) : text)
  if (!Number.isFinite(value)) throw new Error(`Bad ${label} in ${JSON.stringify(whole)}.`)
  return clamp01(value / 100)
}

/** Alpha is the one component that is already 0..1 when written as a plain number. */
function alphaOf(args: string[], index: number, whole: string): number {
  if (args.length <= index) return 1
  return clamp01(component(args[index], 1, 'alpha', whole))
}

function parseRgb(args: string[], whole: string): RGBA {
  if (args.length < 3) throw new Error(`rgb() needs three components: ${JSON.stringify(whole)}.`)
  return [
    clamp01(component(args[0], 255, 'red', whole) / 255),
    clamp01(component(args[1], 255, 'green', whole) / 255),
    clamp01(component(args[2], 255, 'blue', whole) / 255),
    alphaOf(args, 3, whole),
  ]
}

function parseHsl(args: string[], whole: string): RGBA {
  if (args.length < 3) throw new Error(`hsl() needs three components: ${JSON.stringify(whole)}.`)
  const hue = parseHue(args[0], whole)
  const saturation = percentage(args[1], 'saturation', whole)
  const lightness = percentage(args[2], 'lightness', whole)

  // The standard conversion: a chroma sized by how far the lightness is from the extremes, an
  // intermediate that falls off across each 60-degree sector, and a lift that recentres the
  // result on the lightness.
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const sector = hue / 60
  const middle = chroma * (1 - Math.abs((sector % 2) - 1))
  const lift = lightness - chroma / 2

  const [r, g, b] =
    sector < 1 ? [chroma, middle, 0]
    : sector < 2 ? [middle, chroma, 0]
    : sector < 3 ? [0, chroma, middle]
    : sector < 4 ? [0, middle, chroma]
    : sector < 5 ? [middle, 0, chroma]
    : [chroma, 0, middle]

  return [r + lift, g + lift, b + lift, alphaOf(args, 3, whole)]
}

/** Degrees, from any of the angle units - wrapped into [0, 360). */
function parseHue(text: string, whole: string): number {
  const units: [string, number][] = [
    ['deg', 1],
    ['grad', 360 / 400],
    ['rad', 180 / Math.PI],
    ['turn', 360],
  ]
  let value = Number.NaN
  for (const [suffix, scale] of units) {
    if (text.endsWith(suffix)) {
      value = Number.parseFloat(text.slice(0, -suffix.length)) * scale
      break
    }
  }
  if (Number.isNaN(value)) value = Number.parseFloat(text)
  if (!Number.isFinite(value)) throw new Error(`Bad hue in ${JSON.stringify(whole)}.`)
  return ((value % 360) + 360) % 360
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}
