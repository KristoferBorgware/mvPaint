// Give a Mermaid SVG an intrinsic size, so it survives being shown through an <img> tag.
//
// A Markdown image is an <img>, and an <img> needs the SVG to declare how big it is. Mermaid
// writes width="100%" with no height and a max-width in the root style, which leaves the browser
// with no intrinsic size and no aspect ratio: the picture collapses to the default replaced-element
// box. `useMaxWidth: false` fixes it for flowcharts and is ignored by the class diagram renderer,
// so the size is written here instead, from the viewBox, for every kind at once.
//
// Usage: node docs/mermaid/normalize.mjs docs/some-diagram.svg

import { readFile, writeFile } from 'node:fs/promises'

const [, , path] = process.argv
if (!path) {
  console.error('usage: node docs/mermaid/normalize.mjs <file.svg>')
  process.exit(1)
}

const svg = await readFile(path, 'utf8')

const open = svg.match(/<svg\b[^>]*>/)
if (!open) throw new Error(`${path}: no <svg> element`)

const box = open[0].match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)
if (!box) throw new Error(`${path}: no viewBox to take a size from`)

const width = Math.round(Number(box[1]))
const height = Math.round(Number(box[2]))

let tag = open[0]
  .replace(/\swidth="[^"]*"/, '')
  .replace(/\sheight="[^"]*"/, '')
  // The max-width would still cap it inside an HTML page that sizes the image itself.
  .replace(/max-width:\s*[^;"]*;?\s*/, '')
  .replace(/<svg\b/, `<svg width="${width}" height="${height}"`)

await writeFile(path, svg.replace(open[0], tag), 'utf8')
console.log(`${path}: ${width}x${height}`)
