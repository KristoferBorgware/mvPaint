// Minimal CSS color parser for SVG paint. Returns straight RGBA in 0..1, or null for
// 'none' (no paint). Supports hex (#rgb/#rgba/#rrggbb/#rrggbbaa), rgb()/rgba() with
// 0-255 or percentage channels, a common named-color subset, and 'transparent'.

import type { RGBA } from '../render/meshFormat'

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', lime: '#00ff00',
  blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff',
  fuchsia: '#ff00ff', gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000',
  olive: '#808000', navy: '#000080', teal: '#008080', purple: '#800080', orange: '#ffa500',
  pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082', violet: '#ee82ee',
}

function parseHex(hex: string): RGBA | null {
  let h = hex.slice(1)
  if (h.length === 3 || h.length === 4) {
    h = h.split('').map((c) => c + c).join('')
  }
  if (h.length !== 6 && h.length !== 8) return null
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
  if ([r, g, b].some(Number.isNaN)) return null
  return [r / 255, g / 255, b / 255, a]
}

function parseRgb(str: string): RGBA | null {
  const inner = str.slice(str.indexOf('(') + 1, str.lastIndexOf(')'))
  const parts = inner.split(/[\s,/]+/).filter((s) => s.length > 0)
  if (parts.length < 3) return null
  const channel = (s: string) => (s.endsWith('%') ? (parseFloat(s) / 100) * 255 : parseFloat(s))
  const r = channel(parts[0])
  const g = channel(parts[1])
  const b = channel(parts[2])
  const a = parts[3] !== undefined ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1
  if ([r, g, b, a].some(Number.isNaN)) return null
  return [r / 255, g / 255, b / 255, a]
}

/** Parse a CSS/SVG color. Returns null for 'none'; 'transparent' yields alpha 0. */
export function parseColor(input: string | null | undefined): RGBA | null {
  if (!input) return null
  const s = input.trim().toLowerCase()
  if (s === 'none') return null
  if (s === 'transparent') return [0, 0, 0, 0]
  if (s.startsWith('#')) return parseHex(s)
  if (s.startsWith('rgb')) return parseRgb(s)
  const named = NAMED[s]
  return named ? parseHex(named) : null
}
