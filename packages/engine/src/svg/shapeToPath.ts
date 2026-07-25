// Convert the basic SVG geometry elements to path 'd' strings so the whole document can
// be flattened through one path pipeline. Pure: takes a tag name and an attribute
// accessor, returns a 'd' string (or null for non-geometry elements). Rounded rects,
// circles and ellipses use arcs, which svgpath's unarc() later converts to curves.

export type AttrGetter = (name: string) => string | null

function num(get: AttrGetter, name: string, fallback = 0): number {
  const v = get(name)
  if (v == null) return fallback
  const n = parseFloat(v)
  return Number.isNaN(n) ? fallback : n
}

function pointsToPath(pointsAttr: string | null, closed: boolean): string | null {
  if (!pointsAttr) return null
  const nums = pointsAttr.split(/[\s,]+/).map(Number).filter((n) => !Number.isNaN(n))
  if (nums.length < 4) return null
  let d = `M ${nums[0]} ${nums[1]}`
  for (let i = 2; i + 1 < nums.length; i += 2) d += ` L ${nums[i]} ${nums[i + 1]}`
  return closed ? d + ' Z' : d
}

export function elementToPathData(tag: string, get: AttrGetter): string | null {
  switch (tag) {
    case 'path':
      return get('d')

    case 'rect': {
      const x = num(get, 'x')
      const y = num(get, 'y')
      const w = num(get, 'width')
      const h = num(get, 'height')
      if (w <= 0 || h <= 0) return null
      let rx = get('rx') != null ? num(get, 'rx') : num(get, 'ry')
      let ry = get('ry') != null ? num(get, 'ry') : num(get, 'rx')
      rx = Math.min(Math.max(rx, 0), w / 2)
      ry = Math.min(Math.max(ry, 0), h / 2)
      if (rx === 0 || ry === 0) {
        return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`
      }
      return (
        `M ${x + rx} ${y} H ${x + w - rx} A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry} ` +
        `V ${y + h - ry} A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} ` +
        `H ${x + rx} A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry} ` +
        `V ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`
      )
    }

    case 'circle': {
      const cx = num(get, 'cx')
      const cy = num(get, 'cy')
      const r = num(get, 'r')
      if (r <= 0) return null
      return `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`
    }

    case 'ellipse': {
      const cx = num(get, 'cx')
      const cy = num(get, 'cy')
      const rx = num(get, 'rx')
      const ry = num(get, 'ry')
      if (rx <= 0 || ry <= 0) return null
      return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`
    }

    case 'line': {
      const x1 = num(get, 'x1')
      const y1 = num(get, 'y1')
      const x2 = num(get, 'x2')
      const y2 = num(get, 'y2')
      return `M ${x1} ${y1} L ${x2} ${y2}`
    }

    case 'polyline':
      return pointsToPath(get('points'), false)

    case 'polygon':
      return pointsToPath(get('points'), true)

    default:
      return null
  }
}
