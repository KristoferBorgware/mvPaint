---
"@mvpaint/engine": major
---

**Breaking.** A colour is now checked to BE a colour, gradient stops take the flat form, and both read back as they were written.

### The tuple is checked

`isRGBA` tested for "not a string", so every non-string value passed through `parseColor` untouched and was handed on as though it were a colour. It now tests for four finite numbers, and `parseColor` raises anything else.

What that admitted, the object record wrote. `f32.set` ignores a scalar entirely and takes only as many channels as a short array holds, leaving the rest of the record holding the previous object's colour — so `shape.fill = 42` drew in some other shape's colour, and `shape.fill = [1, 0]` drew half of one. Both look like a colour-picking mistake and neither can be traced to the assignment.

Now refused: `42`, `null`, `undefined`, `[1, 0]`, `[1, 0, 0]`, `[1, 0, 0, 1, 1]`, `[1, 0, 0, NaN]`, `['1','0','0','1']`, `{r,g,b,a}`. A real tuple is still passed straight through, as the same instance.

### Gradient stops take either form

`fillLinearGradientColorStops` and `fillRadialGradientColorStops` accept one flat array alternating offsets and colours beside the list of stop objects:

```ts
shape.fillLinearGradientColorStops = [0, 'red', 0.5, 'blue', 1, [0, 1, 0, 1]]
shape.fillLinearGradientColorStops = [{ offset: 0, color: 'red' }, { offset: 1, color: 'blue' }]
```

The flat form previously read as a list of stop objects: each number and each string yielded `{offset: undefined, color: undefined}`, which reached the object record as a NaN stop position and then threw `TypeError: undefined is not iterable` inside the batcher, several layers from the assignment.

An offset must be a finite number, and a stop list may hold at most `MAX_GRADIENT_STOPS` (8). Both raise rather than truncate: a gradient quietly missing its last colours still draws, and looks like a colour-picking mistake rather than a limit.

**This reaches `loadSvgDocument`.** SVG gradient stops are assigned through the same setters, so a document whose gradient carries more than 8 stops now fails to load instead of rendering with the first 8. Reduce the stop list in the document, or catch the load.

### Colours read back as written

Every colour property keeps the value it was assigned beside the tuple it renders through, under a parallel `…Input` accessor:

```ts
shape.fill = 'tomato'
shape.fill       // [1, 0.388, 0.278, 1]  — what it renders through
shape.fillInput  // 'tomato'              — what was written
```

Added: `fillInput`, `strokeInput`, `shadowColorInput`, `fillLinearGradientColorStopsInput`, `fillRadialGradientColorStopsInput` on `Shape`, and `tintInput` on `Image`. The stop-list ones give back the flat form when that is what was written.

The tuple stays the value: every comparison the engine makes reads `fill`, not `fillInput`, and the written form never reaches a buffer. `attrs` and `getAttr()` are unchanged and still report the tuple.

### Also

`MAX_GRADIENT_STOPS` moves to `render/color.ts` beside the parser that enforces it, and is re-exported from `render/meshFormat.ts` — the import path every consumer already uses is unchanged.

`ColorStopsInput` is new: the type of a whole stop list in either written form.
