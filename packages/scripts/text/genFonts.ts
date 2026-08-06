// Both generators over one charset.
//
//   npm run gen:fonts                          the default set (see charset.ts)
//   npm run gen:fonts -- --charset latin       a named set
//   npm run gen:fonts -- --charset @chars.txt  the characters in a file
//
// A script rather than `gen:msdf && gen:polygons`: npm appends a `--` argument to the LAST
// command of a chain, so the second generator would get the charset and the first would run on
// the default. The two atlases covering different characters is the one thing that must not
// happen - a node switching between the MSDF and the vector path would change which glyphs are
// missing - so one process resolves the argument and hands the same set to both.

import { main as generateMsdf } from './msdf/genMsdfAtlas'
import { main as generatePolygons } from './polygon/genPolygonAtlas'

async function main(): Promise<void> {
  await generateMsdf(process.argv)
  await generatePolygons(process.argv)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
