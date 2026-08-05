---
"@mvpaint/engine": patch
"@mvpaint/ttf": patch
---

Prune down to what an application imports. Two changes together: `sideEffects: false` in both manifests, which tells a bundler a file can be dropped whole when nothing is imported from it, and `preserveModules` in both builds, which emits one file per source module rather than concatenating them into shared chunks. `dist/` now mirrors `src/` in each package, so a bundler prunes at module granularity instead of at chunk granularity.

Measured with esbuild against the real tarball, ESM and minified:

| Consumer import | before | after |
| --- | --- | --- |
| `import { Vector2 } from '@mvpaint/engine'` | 23 kB | 1 kB |
| `import { Vector2 } from '@mvpaint/engine/core'` | 14 kB | 1 kB |
| `import { Rect }` | 58 kB | 38 kB |
| `import * as E` | 273 kB | 283 kB |

Importing the whole surface grows by 10 kB, because per-module boundaries leave less for a bundler to hoist across. Everything narrower shrinks. What remains behind `Rect` is its own dependency cone — `Node`, `Shape`, the stroke builder and the math types.

`@mvpaint/ttf` measures the same either way at its current size; it emits three modules so that the property holds as the package grows rather than being noticed later.

No API change, and no change to what is exported from any entry point. The WebGL2 fallback is still reached through a dynamic import and still lands in its own chunk in a consumer's build.
