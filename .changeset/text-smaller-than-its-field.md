---
"@mvpaint/engine": patch
---

**MSDF text fades out below the size its field can describe, instead of wearing a grey fringe.**

A glyph's coverage is thresholded over the distance field's width measured in SCREEN pixels, and that width is floored at one pixel so the ramp cannot invert. Once a screen pixel is wider than the whole field the floor takes over and the ramp stops narrowing: the coverage becomes the raw distance, which falls from 1 at the middle of a stroke to 0 at the far edge of the field, and every letter wears a soft fringe the full width of that field. With a per-letter outline the fringe takes the stroke colour as well.

Both shaders now scale the glyph's alpha by the unclamped range, so text fades over the last stretch rather than smudging. On the atlases in `packages/example-app` — a 4-texel field on a 42-texel em — the fade begins at about ten screen pixels per em and reaches nothing at one.

Only glyph fragments fade. Underline, strikethrough and highlight sample no field and keep drawing at any size.

This is minification alone; magnified text is untouched. A mip chain on the atlas would let small text stay legible rather than fade, and is the larger fix this does not attempt.
