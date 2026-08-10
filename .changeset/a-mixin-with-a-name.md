---
"@mvpaint/engine": minor
---

**The uniform text nodes have usable type declarations.**

`withSingleRun()` returned an inferred class-expression type. A declaration file cannot write down a type that has no name, so the build emitted 720 errors — 702 `TS4094`, 12 `TS4020`, 6 `TS4058` — and produced `.d.ts` files for `withSingleRun`, `UniformMSDFText` and `UniformVectorText` that described none of the three. The plugin never treated them as fatal, so the build exited 0 with the damage in the output.

The mixin now declares what it adds:

```ts
export interface SingleRunText {
  text: string
  fontSize: number
  fontStyle: string
  textDecoration: string
  letterSpacing: number
  measureWith(text: string, fonts: FontProvider): TextSize
}

export function withSingleRun<T extends TextClass>(
  Base: T,
): T & (abstract new (...args: any[]) => SingleRunText)
```

The build is clean, and a consumer reading the published types now sees `text`, `fontSize`, `fontStyle`, `textDecoration`, `letterSpacing` and `measureSize` on both uniform nodes alongside everything they inherit.

Two things moved to make that possible. `measureWith` is public rather than protected, since an interface has no protected members — `measureSize` on each node is still the one to call. `runStyle` stays protected and is now genuinely private to the mixin: it is absent from the declared type, so a subclass written outside this package cannot reach it. Nothing inside the engine did.
