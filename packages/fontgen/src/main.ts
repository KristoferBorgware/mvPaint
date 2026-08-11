// The command line's entry: what `mvpaint-fontgen` runs, and what tsx runs in this repository.
// cli.ts is a module like any other so that a test can drive it; this is the file that starts it.

import { run } from './cli'

await run()
