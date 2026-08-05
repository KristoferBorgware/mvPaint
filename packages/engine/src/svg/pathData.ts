// The SVG path data grammar, read once into absolute curves.
//
// `d` is a compressed language, and the compression is where readers go wrong. A command letter
// carries over to the numbers that follow it, so `M 0 0 1 1 2 2` is a moveto and two linetos -
// and the carried-over command after a moveto is a LINETO, not another moveto. Separators are
// optional wherever the number grammar is unambiguous, so `M1-2` is two numbers and `.5.5` is
// two more. Arc flags are single characters rather than numbers, so `a1 1 0 011 1` packs
// large-arc, sweep and the first coordinate into `011`. All of that is SVG 1.1 section 8.3.9,
// and all of it appears in files real editors emit.
//
// This reader hands the caller absolute moveto/lineto/curveto/closepath and nothing else. The
// relative forms, the horizontal and vertical shorthands, the smooth shorthands and the arcs
// are all resolved here, so everything downstream sees four cases. Arcs become cubics through
// arcToCubic.ts.
//
// The optional matrix is applied to each coordinate as it is emitted, control points included.
// An affine map takes a Bézier's control points to the transformed Bézier, so a transformed
// path is the transform of its curves - and a caller flattening the result measures its
// tolerance in the space it will actually draw in.
//
// Written from the specification. `svgpath`, which this replaces, solves the same problem.

import type { Mat2x3 } from './matrix'
import { arcToCubics } from './arcToCubic'

/** What a path describes, once the shorthands are resolved. Coordinates are absolute. */
export interface PathVisitor {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  cubicTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void
  quadraticTo(cx: number, cy: number, x: number, y: number): void
  closePath(): void
}

const COMMANDS = 'MmZzLlHhVvCcSsQqTtAa'
const SPACE = 0x20
const TAB = 0x09
const CR = 0x0d
const LF = 0x0a
const FF = 0x0c
const COMMA = 0x2c
const PLUS = 0x2b
const MINUS = 0x2d
const DOT = 0x2e
const ZERO = 0x30
const NINE = 0x39
const ONE = 0x31
const LOWER_E = 0x65
const UPPER_E = 0x45

const isWsp = (c: number) => c === SPACE || c === TAB || c === CR || c === LF || c === FF
const isDigit = (c: number) => c >= ZERO && c <= NINE

/**
 * Read `d`, calling `visitor` for each absolute segment.
 *
 * Throws on malformed data, naming the offset - a `d` string that cannot be read is a mistake
 * in the document, and a path silently truncated at the first bad character is harder to
 * diagnose than one that says where it stopped.
 */
export function readPathData(d: string, visitor: PathVisitor, matrix?: Mat2x3): void {
  const len = d.length
  let i = 0

  const fail = (what: string): never => {
    const shown = d.length > 60 ? `${d.slice(0, 57)}...` : d
    throw new Error(`Invalid SVG path data at offset ${i}: ${what}. In "${shown}"`)
  }

  const skipSeparators = (): void => {
    while (i < len) {
      const c = d.charCodeAt(i)
      if (isWsp(c) || c === COMMA) i++
      else break
    }
  }

  const readNumber = (): number => {
    skipSeparators()
    const start = i
    const sign = i < len ? d.charCodeAt(i) : -1
    if (sign === PLUS || sign === MINUS) i++
    let sawDigit = false
    while (i < len && isDigit(d.charCodeAt(i))) {
      i++
      sawDigit = true
    }
    if (i < len && d.charCodeAt(i) === DOT) {
      i++
      while (i < len && isDigit(d.charCodeAt(i))) {
        i++
        sawDigit = true
      }
    }
    if (!sawDigit) return fail('expected a number')
    const exponent = i < len ? d.charCodeAt(i) : -1
    if (exponent === LOWER_E || exponent === UPPER_E) {
      const mark = i
      i++
      const expSign = i < len ? d.charCodeAt(i) : -1
      if (expSign === PLUS || expSign === MINUS) i++
      if (i < len && isDigit(d.charCodeAt(i))) {
        while (i < len && isDigit(d.charCodeAt(i))) i++
      } else {
        // An `e` with no exponent behind it is not part of this number.
        i = mark
      }
    }
    return Number(d.slice(start, i))
  }

  // A flag is one character, `0` or `1`, and takes no separator - which is what lets an arc
  // write its two flags and the coordinate after them as a single run of digits.
  const readFlag = (): boolean => {
    skipSeparators()
    const c = i < len ? d.charCodeAt(i) : -1
    if (c === ZERO) {
      i++
      return false
    }
    if (c === ONE) {
      i++
      return true
    }
    return fail('expected an arc flag, 0 or 1')
  }

  const mapX = matrix ? (x: number, y: number) => matrix[0] * x + matrix[2] * y + matrix[4] : (x: number) => x
  const mapY = matrix ? (x: number, y: number) => matrix[1] * x + matrix[3] * y + matrix[5] : (_x: number, y: number) => y

  const emitMove = (x: number, y: number) => visitor.moveTo(mapX(x, y), mapY(x, y))
  const emitLine = (x: number, y: number) => visitor.lineTo(mapX(x, y), mapY(x, y))
  const emitCubic = (ax: number, ay: number, bx: number, by: number, x: number, y: number) =>
    visitor.cubicTo(mapX(ax, ay), mapY(ax, ay), mapX(bx, by), mapY(bx, by), mapX(x, y), mapY(x, y))
  const emitQuadratic = (ax: number, ay: number, x: number, y: number) =>
    visitor.quadraticTo(mapX(ax, ay), mapY(ax, ay), mapX(x, y), mapY(x, y))

  // The cursor, the subpath's first point (where closepath returns to), and the control points
  // the smooth shorthands reflect. `previous` is the command that produced the cursor, which is
  // what decides whether a reflection has anything to reflect.
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let lastCubicX = 0
  let lastCubicY = 0
  let lastQuadX = 0
  let lastQuadY = 0
  let previous = ''
  let command = ''

  while (true) {
    skipSeparators()
    if (i >= len) break

    const char = d[i]
    if (COMMANDS.includes(char)) {
      command = char
      i++
    } else {
      if (!command) return fail('expected a command letter')
      // A number where a command could be repeats the previous command - except after a
      // moveto, which repeats as a lineto of the same relativity.
      if (command === 'M') command = 'L'
      else if (command === 'm') command = 'l'
      else if (command === 'Z' || command === 'z') return fail('unexpected number after closepath')
    }

    const upper = command.toUpperCase()
    const relative = command !== upper
    const dx = relative ? x : 0
    const dy = relative ? y : 0

    switch (upper) {
      case 'M': {
        x = readNumber() + dx
        y = readNumber() + dy
        startX = x
        startY = y
        emitMove(x, y)
        break
      }
      case 'L': {
        x = readNumber() + dx
        y = readNumber() + dy
        emitLine(x, y)
        break
      }
      case 'H': {
        x = readNumber() + dx
        emitLine(x, y)
        break
      }
      case 'V': {
        y = readNumber() + dy
        emitLine(x, y)
        break
      }
      case 'C': {
        const c1x = readNumber() + dx
        const c1y = readNumber() + dy
        const c2x = readNumber() + dx
        const c2y = readNumber() + dy
        const ex = readNumber() + dx
        const ey = readNumber() + dy
        emitCubic(c1x, c1y, c2x, c2y, ex, ey)
        lastCubicX = c2x
        lastCubicY = c2y
        x = ex
        y = ey
        break
      }
      case 'S': {
        // The first control point mirrors the previous curve's second one about the cursor.
        // With no previous curve there is nothing to mirror and the cursor itself serves.
        const smooth = previous === 'C' || previous === 'S'
        const c1x = smooth ? 2 * x - lastCubicX : x
        const c1y = smooth ? 2 * y - lastCubicY : y
        const c2x = readNumber() + dx
        const c2y = readNumber() + dy
        const ex = readNumber() + dx
        const ey = readNumber() + dy
        emitCubic(c1x, c1y, c2x, c2y, ex, ey)
        lastCubicX = c2x
        lastCubicY = c2y
        x = ex
        y = ey
        break
      }
      case 'Q': {
        const cx = readNumber() + dx
        const cy = readNumber() + dy
        const ex = readNumber() + dx
        const ey = readNumber() + dy
        emitQuadratic(cx, cy, ex, ey)
        lastQuadX = cx
        lastQuadY = cy
        x = ex
        y = ey
        break
      }
      case 'T': {
        const smooth = previous === 'Q' || previous === 'T'
        const cx = smooth ? 2 * x - lastQuadX : x
        const cy = smooth ? 2 * y - lastQuadY : y
        const ex = readNumber() + dx
        const ey = readNumber() + dy
        emitQuadratic(cx, cy, ex, ey)
        lastQuadX = cx
        lastQuadY = cy
        x = ex
        y = ey
        break
      }
      case 'A': {
        const rx = readNumber()
        const ry = readNumber()
        const rotation = readNumber()
        const largeArc = readFlag()
        const sweep = readFlag()
        const ex = readNumber() + dx
        const ey = readNumber() + dy
        for (const [c1x, c1y, c2x, c2y, px, py] of arcToCubics(x, y, rx, ry, rotation, largeArc, sweep, ex, ey)) {
          emitCubic(c1x, c1y, c2x, c2y, px, py)
        }
        x = ex
        y = ey
        break
      }
      case 'Z': {
        visitor.closePath()
        // A subpath that continues after a closepath starts where the closed one did.
        x = startX
        y = startY
        break
      }
      default:
        return fail(`unknown command '${command}'`)
    }

    previous = upper
  }
}
