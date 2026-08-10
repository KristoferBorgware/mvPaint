---
"@mvpaint/engine": patch
---

**Vector text draws the letters its font describes.**

A font builds a letter out of overlapping pieces wound the same way, and resolves them with the nonzero winding rule: the bar of a `t` is a rectangle laid across the stem, the two strokes of a `w` cross at the bottom of each V, the arch of an `n` runs into its stem. The glyph fill went through the even-odd NESTING test instead, which reads a piece laid over another as a hole and hands a self-crossing ring to a triangulator that requires a simple polygon.

On Inter, 23 of 188 glyphs were drawn wrong over more than 1% of their area, and 60 were wrong somewhere. `t` and `f` lost their bars and drew as `l` and a bare stem; `w`, `M`, `N`, `A`, `V`, `X` and `&` filled across their valleys; `$ + ^ { } ¢ £ ¤ ¥ ± ¶ Ç × Þ ç Ð` lost a piece each.

`render/nonzero.ts` reads the outline the way it was drawn: `simpleLoops` cuts a ring at its self-crossings so every piece reaching earcut is a simple polygon, and `windingGroups` decides solid from hole by DIRECTION rather than by nesting, so a piece laid over another is a second solid. Overlapping solids stay overlapping — two triangulations painting the same pixel in the same colour is the union, which is what the rule asks for.

Nothing else changes. MSDF text samples an atlas and was never affected; the atlas files are unchanged, since the outlines in them were always right and only the reading of them was wrong; and `contours` still comes back untouched, so a per-letter outline traces the letterform as the font drew it, crossings included.

The new test measures the fix rather than describing it: it samples a grid over every glyph in the committed atlas and compares "inside a fill triangle" against the winding number of the original rings. Every glyph now agrees at every sample.
