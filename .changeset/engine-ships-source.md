---
"@mvpaint/engine": patch
"@mvpaint/ttf": patch
---

Ship `src/` alongside `dist/`, so Go to Definition lands on the real TypeScript. Both packages emit declaration maps, and every one of them names a path under `src/` — following that path from an editor reaches the file it names. The source is where this codebase's documentation lives, so reading it is the point of jumping to it. `@mvpaint/ttf` emits declaration maps for the first time here.

`src/**/*.test.ts` stays out through a negated pattern in `files`. Nothing in `src/` reaches an application's bundle: `exports` lists only the package entry points and routes each to `dist/`, so `src/` is never in the module graph and occupies disk in `node_modules` only. The engine's tarball goes from 644 kB to 893 kB packed; ttf's adds four files.
