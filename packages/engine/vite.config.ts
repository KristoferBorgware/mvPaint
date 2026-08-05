// The published build of @mvpaint/engine.
//
// Library mode, matching packages/ttf. The engine ships code and no assets, which is what that
// mode assumes: it base64-inlines anything it treats as an asset regardless of
// assetsInlineLimit, and there is nothing here for it to reach. Fonts are the application's -
// packages/example-app serves this repository's out of public/fonts/.
//
// `lib` gates two Vite transforms beyond entry naming, both of them an application's business.
// The module-preload helper is injected only when `!build.lib`, so dynamic imports here stay
// bare `import()` for the consumer's bundler to analyse, and the fixed name `__vitePreload`
// belongs to the consumer alone. `process.env.NODE_ENV` substitution is gated the same way, so
// that value stays the consumer's too.
//
// Two entries, matching the two conditions in package.json's exports: 'index' is the whole
// engine, 'core' the device-free subset (see src/core.ts).
//
// preserveModules emits one file per source module rather than concatenating them into shared
// chunks, so dist/ mirrors src/ and a consumer's bundler prunes at module granularity: an
// application importing Vector2 alone reaches one file and drops the rest. `sideEffects: false`
// in package.json is the other half of that - it tells a bundler each of these files can be
// dropped whole when nothing is imported from it. The WebGL2 fallback stays behind its dynamic
// import, so a browser with WebGPU never fetches it.
//
// Vite rather than plain tsc for two things: bundling, and the declaration-file fixups below.

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

const src = (file: string) => fileURLToPath(new URL(`src/${file}`, import.meta.url))

export default defineConfig({
  plugins: [
    dts({
      // Its own tsconfig: the checking one says noEmit, and this build is the one place that
      // has to emit. Tests are excluded so no .test.d.ts lands in the tarball.
      tsconfigPath: './tsconfig.build.json',
      exclude: ['**/*.test.ts'],
      beforeWriteFile(filePath, content) {
        // The WebGPU lane's signatures are written in terms of GPUDevice, GPUBindGroup and the
        // rest, which are globals no TypeScript installation has by default. Inside this repo
        // the engine's tsconfig lists @webgpu/types and they resolve; a consumer has no such
        // tsconfig, and without this reference every one of those types is an error in their
        // build rather than ours. It goes on the main entry only - /core names no GPU type.
        if (!filePath.replace(/\\/g, '/').endsWith('/dist/index.d.ts')) return
        return { filePath, content: `/// <reference types="@webgpu/types" />\n${content}` }
      },
    }),
  ],
  build: {
    target: 'es2020',
    sourcemap: true,
    // The engine is a dependency, not an application: leave the consumer's bundler to decide
    // what gets minified, and ship readable code behind the source maps.
    minify: false,
    lib: {
      entry: { index: src('index.ts'), core: src('core.ts') },
      // ES only. No UMD or IIFE build, which is also why build.lib.name is not needed here.
      formats: ['es'],
    },
    rollupOptions: {
      // Runtime dependencies stay dependencies, resolved from the application's own
      // node_modules so there is one copy of each in its build.
      external: ['earcut', 'svgpath'],
      output: {
        // One emitted file per source module, rooted at src/ so dist/ mirrors it: src/math/
        // Vector2.ts becomes dist/math/Vector2.js, alongside the .d.ts the same path already
        // carries. The two entries keep the names package.json's exports point at.
        preserveModules: true,
        preserveModulesRoot: 'src',
      },
    },
  },
})
