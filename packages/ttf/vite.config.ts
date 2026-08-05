// The published build of @mvpaint/ttf.
//
// Vite, matching the engine's build, though this package has no assets to emit and would
// survive plain tsc.
//
// The one thing needing care is src/opentype-js.d.ts. opentype.js 2.0.0 ships no types at all,
// so that file's ambient `declare module 'opentype.js/dist/opentype.mjs'` is what gives
// PathCommand and Glyph any meaning - and both appear in this package's public signatures. Ship
// the emitted types without it and every consumer's tsc reports the import as unresolvable.
//
// Rolling the declarations into a single file (dts's rollupTypes) does NOT work here: the
// bundler drops ambient module blocks and leaves the bare import behind. So the declarations
// stay one-per-source-file, the ambient file is emitted alongside them, and index.d.ts gets a
// reference to it prepended below.

import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import dts from 'vite-plugin-dts'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * Copies the hand-written ambient declaration into dist. vite-plugin-dts generates types from
 * .ts files and passes .d.ts inputs over, so without this the reference prepended to index.d.ts
 * would point at a file that was never emitted.
 */
const emitAmbientTypes: Plugin = {
  name: 'mvpaint:emit-ambient-types',
  closeBundle() {
    copyFileSync(here('src/opentype-js.d.ts'), here('dist/opentype-js.d.ts'))
  },
}

export default defineConfig({
  plugins: [
    emitAmbientTypes,
    dts({
      tsconfigPath: './tsconfig.build.json',
      exclude: ['**/*.test.ts'],
      beforeWriteFile(filePath, content) {
        if (!filePath.replace(/\\/g, '/').endsWith('/index.d.ts')) return
        return {
          filePath,
          content: `/// <reference path="./opentype-js.d.ts" />\n${content}`,
        }
      },
    }),
  ],
  build: {
    target: 'es2020',
    sourcemap: true,
    minify: false,
    lib: {
      entry: here('src/index.ts'),
      formats: ['es'],
      // Named per module, not per package. preserveModules below turns every source file into
      // an emitted one, and `name` is its path under src/ - so src/TtfFont.ts becomes
      // dist/TtfFont.js and the entry becomes dist/index.js, which is what exports points at.
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      // opentype.js is this package's whole reason to exist and stays a dependency; the engine
      // is a peer, so there is exactly one of it in the application either way.
      external: [/^opentype\.js(\/|$)/, /^@mvpaint\/engine(\/|$)/],
      output: {
        // One emitted file per source module, rooted at src/ so dist/ mirrors it - the same
        // arrangement as the engine, for the same reason: a consumer's bundler prunes per
        // module. It also names the entry, since src/index.ts maps to dist/index.js, which is
        // what package.json's exports point at.
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
    },
  },
})
