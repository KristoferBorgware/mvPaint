// The published build of @mvpaint/fontgen.
//
// Vite, matching the engine's and @mvpaint/ttf's builds, though this package runs only under
// node and would survive plain tsc. What it would not survive is tsc's extensionless output:
// `from './generate'` is unresolvable to node's ESM loader, and rollup rewrites every relative
// import to the emitted file's real name on the way out.
//
// TWO ENTRIES. src/index.ts is the library and src/main.ts is the command line - neither
// imports the other, and preserveModules only emits what an entry reaches.
//
// Nothing is bundled in: every dependency is external, including the optional packer, whose
// whole point is that it is imported at the moment it is used rather than at load.

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  plugins: [dts({ tsconfigPath: './tsconfig.build.json', exclude: ['**/*.test.ts'] })],
  build: {
    target: 'node18',
    sourcemap: true,
    minify: false,
    lib: {
      entry: [here('src/index.ts'), here('src/main.ts')],
      formats: ['es'],
      // Named per module, not per package: preserveModules below turns every source file into
      // an emitted one, and `name` is its path under src/ - so src/cli.ts becomes dist/cli.js
      // and the entries become dist/index.js and dist/main.js.
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external: [
        /^node:/,
        /^@mvpaint\/(engine|ttf)(\/|$)/,
        /^opentype\.js(\/|$)/,
        'wawoff2',
        // The optional peer. External for the same reason as the rest, and load-bearing here:
        // bundling it would make a package a project may not have installed a hard import.
        'msdf-bmfont-xml',
      ],
      output: {
        // One emitted file per source module, rooted at src/ so dist/ mirrors it - the same
        // arrangement as the engine and @mvpaint/ttf.
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
    },
  },
})
