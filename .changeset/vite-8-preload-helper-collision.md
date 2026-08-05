---
"@mvpaint/engine": patch
---

Build against Vite 8. The engine's one dynamic import — the WebGL2 fallback in `createSceneRenderer` — made Vite inline its module-preload helper into the published chunk as `const __vitePreload = …`. A consumer bundling that dist sees the same dynamic import and injects the helper again: Vite 6 and 7 notice the existing declaration and skip, Vite 8 does import analysis in Rolldown, which has no such guard, and the build dies with `Identifier '__vitePreload' has already been declared`. Every consumer on Vite 8 hit it and no configuration of theirs avoided it.

The engine now builds in Vite's **library mode**, which is what it should always have been. Vite gates the helper injection on `!build.lib`, so nothing is generated and the dist carries a bare `import()` for the consumer's bundler to analyse and preload properly. Library mode was previously impossible because it base64-inlines every asset regardless of `assetsInlineLimit`, and the engine bundled four MSDF atlas PNGs; with the fonts gone there is nothing left to inline and the objection with it.

Being on the library side of that switch also stops Vite substituting `process.env.NODE_ENV`, which would otherwise bake the publishing machine's build mode into every consumer's bundle.

No API change, and the fallback still loads on demand as its own chunk. `@mvpaint/ttf` was never affected: it has used library mode all along.
