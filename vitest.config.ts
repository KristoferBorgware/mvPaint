// One suite for the whole workspace.
//
// The tests are the engine's own self-tests: one file per subsystem, each a narrative walk
// through what that part guarantees, and every one of them pure - no GPU, no DOM, no browser.
// Anything that needs a device is verified on screen instead (see ARCHITECTURE.md).
//
// They run from source, exactly as the packages are consumed inside this repo: `main` points
// at src/index.ts, so there is no build step between editing a file and testing it.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Node, not jsdom: nothing here touches a document. The few tests that need a canvas or a
    // window build a stub for exactly the handful of methods they drive, which is both faster
    // than a DOM implementation and honest about how little of one the engine needs.
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'packages/scripts/text/**/*.test.ts'],
    // The suites are pure and share nothing, so they parallelise freely.
    isolate: true,
  },
})
