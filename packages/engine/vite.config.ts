// The published build of @mvpaint/engine.
//
// Vite rather than plain `tsc`, for one reason: text/msdfAtlasImages.ts and text/vectorFonts.ts
// import the bundled font assets with `?url`, which tsc has no idea what to do with. Vite emits
// those files into dist/assets and rewrites each import to a `new URL(..., import.meta.url)` -
// plain ESM that resolves relative to the installed package, and that a consumer's own bundler
// picks up and fingerprints like any other asset.
//
// Two entries, matching the two conditions in package.json's exports: 'index' is the whole
// engine, 'core' the device-free, asset-free subset (see src/core.ts). Rollup hoists what they
// share into a chunk both import, so nothing is duplicated between them.
//
// NOT `build.lib`, deliberately, which is the obvious way to write this. Library mode inlines
// every asset as a base64 data URI and ignores assetsInlineLimit while doing it - which would
// turn the eight atlas files into 1.2 MB of string literal welded into the JS, parsed on load
// by every consumer including the ones that never draw a glyph, and un-cacheable besides. The
// `?url` imports exist precisely so those bytes stay separate and get fetched when wanted.
// Driving Rollup directly through rollupOptions keeps that property; everything build.lib would
// have set for us is set explicitly below.

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

const src = (file: string) => fileURLToPath(new URL(`src/${file}`, import.meta.url))

export default defineConfig({
  // How a `?url` import turns into a URL at runtime. The default is an application's answer -
  // "/assets/inter-regular.png", resolved against the site root - which for a package installed
  // into somebody else's application points at their web root and 404s. Resolving against
  // import.meta.url instead makes it relative to this module wherever it ends up: node_modules
  // during development, a hashed bundle after the consumer's own build.
  experimental: {
    renderBuiltUrl(filename) {
      return { runtime: `new URL(${JSON.stringify(`./${filename}`)}, import.meta.url).href` }
    },
  },
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
    // Every asset as a file, none as a data URI.
    assetsInlineLimit: 0,
    // No index.html to inject it into, and the consumer's bundler owns preloading anyway.
    modulePreload: false,
    rollupOptions: {
      input: { index: src('index.ts'), core: src('core.ts') },
      // These entries are a package's public API, not an application's start-up. Without this
      // Rollup treats them as app entries, assumes nothing reads their exports, and tree-shakes
      // the entire engine away - a build that succeeds and emits a 1.7 kB index.js.
      preserveEntrySignatures: 'strict',
      // Runtime dependencies stay dependencies - bundling them in would give an application
      // that already has earcut two copies of it.
      external: ['earcut', 'svgpath'],
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        // Flat, not chunks/. renderBuiltUrl below writes "./assets/x.png" into whichever module
        // referenced it, and that path is relative to the referencing file - so every JS file
        // that can hold one has to sit at the same depth as dist/assets.
        chunkFileNames: '[name]-[hash].js',
        // Unhashed: these names appear only inside this package's own dist, and a consumer's
        // bundler fingerprints them again on the way into an application.
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
