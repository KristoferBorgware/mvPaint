---
"@mvpaint/engine": minor
---

**A text node measures the block it was laid out in, so `padding` is an extent.**

`padding` is blank space inside the block: the glyphs move in from the node's origin and the reported width and height each grow by twice it. What a node MEASURED was the union of its glyph quads, and blank space has no quad in it - so a padded label reported the same box as an unpadded one, moved. A plate sized from `getTextWidth()` had the padding; the node's own bounds, the frame a transformer fitted around it, and the extent it contributed to its group did not.

```ts
const label = new VectorText({ padding: 24, runs: [{ text: 'Hi', style: { fontSize: 40 } }] })
label.shaped()                 // 87.4 x 96.4  - the block, and always did
label.getClientRect()          // was 33.5 x 30.1 at (27.5, 32.7); now 87.4 x 96.4 at (0, 0)
```

`ShapedText` gains `blockX`/`blockY`, the block's top-left corner, which `width` and `height` measure from - zero on both axes for horizontal text, `-width` on x for vertical text, and wherever the curve put it for text bent onto a path. `blockRect()` reads them. `textLocalBounds()` unions that rectangle with the quads, and `VectorText.localBounds()` unions it with the glyph geometry.

Both, because neither contains the other: the block reaches past the glyphs wherever the line box is taller than the letters in it, and the quads reach past the block wherever something overhangs - a glow, an italic's overshoot, a run bent onto a curve.

Two things deliberately unchanged. Empty text still has no bounds at all rather than a zero-sized box at its origin, so it adds nothing to the group holding it. And a `VectorText` is still hit per glyph rather than per box - that is what its outline geometry is for - so a click in its padding falls through it, where the same click on an `MSDFText`, which is hit against its box, now lands.

`ARCHITECTURE.md` and `TextLayoutOptions.padding` both already described this behaviour. The code now does it.
