// The one Node API the self-tests reach for.
//
// The self-tests live in src/ and are typechecked with the app's tsconfig, which is
// deliberately DOM-only: pulling @types/node into `types` would put Node's globals in scope
// for every browser module in the engine and let one slip into shipped code unnoticed.
// Declaring just the function that reads a font file off disk keeps that boundary intact
// while still letting src/text/selfTest.ts parse the real Inter TTFs.

declare module 'node:fs' {
  /** Reads a whole file. The returned view is a Node Buffer, used here only for its bytes. */
  export function readFileSync(path: string | URL): {
    buffer: ArrayBuffer
    byteOffset: number
    byteLength: number
  }
}
