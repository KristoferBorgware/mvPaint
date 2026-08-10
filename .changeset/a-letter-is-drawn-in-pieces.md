---
"@mvpaint/engine": patch
---

**Vector text draws the letters its font describes.**

A font builds a letter out of overlapping pieces wound the same way, and resolves them with the nonzero winding rule: the bar of a `t` is a rectangle laid across the stem, the two strokes of a `w` cross at the bottom of each V, the arch of an `n` runs into its stem. The glyph fill went through the even-odd NESTING test instead, which reads a piece laid over another as a hole and hands a self-crossing ring to a triangulator that requires a simple polygon.

On Inter, 23 of 188 glyphs were drawn wrong over more than 1% of their area, and 60 were wrong somewhere. `t` and `f` lost their bars and drew as `l` and a bare stem; `w`, `M`, `N`, `A`, `V`, `X` and `&` filled across their valleys; `$ + ^ { } ¢ £ ¤ ¥ ± ¶ Ç × Þ ç Ð` lost a piece each.

`render/nonzero.ts` reads the outline the way it was drawn.

**`unionBoundary` is the silhouette.** Every edge is cut at each crossing and at each point another edge touches it, and each piece is then asked whether the winding number is zero on exactly one side of it. A piece with material on both sides is a join between two pieces of scaffolding and goes; what survives is chained back into closed rings. A glyph's `contours` are now that silhouette, which is what fixes the per-letter outline: stroking the pieces drew the bar of a `t` as a rectangle running through the stem and put a line out of the side of an `e`'s bowl.

**`simpleLoops` and `windingGroups` fill it.** The first cuts a ring at its self-crossings so every piece reaching earcut is a simple polygon; the second decides solid from hole by DIRECTION rather than by nesting. The fill is cut from the same silhouette the outline follows, so the two cannot disagree.

Nothing else changes. MSDF text samples an atlas and was never affected, and the atlas files are unchanged — the outlines in them were always right, and only the reading of them was wrong.

Two tests measure the fix rather than describing it, both over every glyph in the committed atlas: one samples a grid and compares "inside a fill triangle" against the winding number of the original rings, the other walks every stretch of every silhouette and checks that material lies on exactly one side of it. Both pass everywhere.

Building all 188 glyphs of a face costs about 30 ms, once, lazily, cached per glyph.
