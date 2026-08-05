# @mvpaint/ttf

## 1.0.0

### Patch Changes

- 9c941ee: Ship `src/` alongside `dist/`, so Go to Definition lands on the real TypeScript. Both packages emit declaration maps, and every one of them names a path under `src/` — following that path from an editor reaches the file it names. The source is where this codebase's documentation lives, so reading it is the point of jumping to it. `@mvpaint/ttf` emits declaration maps for the first time here.

  `src/**/*.test.ts` stays out through a negated pattern in `files`. Nothing in `src/` reaches an application's bundle: `exports` lists only the package entry points and routes each to `dist/`, so `src/` is never in the module graph and occupies disk in `node_modules` only. The engine's tarball goes from 644 kB to 893 kB packed; ttf's adds four files.

- 68d7ba8: Prune down to what an application imports. Two changes together: `sideEffects: false` in both manifests, which tells a bundler a file can be dropped whole when nothing is imported from it, and `preserveModules` in both builds, which emits one file per source module rather than concatenating them into shared chunks. `dist/` now mirrors `src/` in each package, so a bundler prunes at module granularity instead of at chunk granularity.

  Measured with esbuild against the real tarball, ESM and minified:

  | Consumer import                                  | before | after  |
  | ------------------------------------------------ | ------ | ------ |
  | `import { Vector2 } from '@mvpaint/engine'`      | 23 kB  | 1 kB   |
  | `import { Vector2 } from '@mvpaint/engine/core'` | 14 kB  | 1 kB   |
  | `import { Rect }`                                | 58 kB  | 38 kB  |
  | `import * as E`                                  | 273 kB | 283 kB |

  Importing the whole surface grows by 10 kB, because per-module boundaries leave less for a bundler to hoist across. Everything narrower shrinks. What remains behind `Rect` is its own dependency cone — `Node`, `Shape`, the stroke builder and the math types.

  `@mvpaint/ttf` measures the same either way at its current size; it emits three modules so that the property holds as the package grows rather than being noticed later.

  No API change, and no change to what is exported from any entry point. The WebGL2 fallback is still reached through a dynamic import and still lands in its own chunk in a consumer's build.

- Updated dependencies [61c0880]
- Updated dependencies [9c941ee]
- Updated dependencies [8a441b1]
- Updated dependencies [1eada49]
- Updated dependencies [68d7ba8]
- Updated dependencies [61c0880]
  - @mvpaint/engine@1.0.0

## 0.1.2

### Patch Changes

- ecc6967: Publish registry metadata that matches the tarball. 0.2.1 shipped a correct tarball — the `development` export condition was stripped from the packaged `package.json`, so installs resolve to `dist/` — but the metadata npm recorded for it still advertised the condition, because npm builds that metadata from the manifest it reads before `prepack` runs. The strip now happens before `changeset publish` starts, so `npm view @mvpaint/engine exports` agrees with what actually installs.

  The published manifest also no longer carries the repo's internal `prepublishOnly` guard, which referenced a path outside the package.

## 0.1.1

### Patch Changes

- 7b9ac82: Strip the `development` export condition from the published manifest. The condition points at `src/`, which is not part of the tarball, so any consumer whose bundler matched it — Vite matches `development` in dev mode by default — failed with "Failed to resolve entry for package". The condition still drives src-resolution inside the monorepo; `prepack` now removes it from the manifest that lands in the tarball and `postpack` restores the original file.
