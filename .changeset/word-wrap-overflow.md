---
"@mvpaint/engine": minor
---

Word wrap now breaks a word that is wider than `maxWidth` on its own, instead of drawing it past the block's edge - the same fallback CSS calls `overflow-wrap: break-word`. A hyphen is also a break opportunity, so a long hyphenated run splits at the dashes before falling back to a mid-word break. `ShapedText.width` (and `getTextWidth()`) now report the true ink extent when a line still overflows `maxWidth`, such as a single glyph too wide to split.

Text nodes (`Text`, `MSDFText`, `VectorText`, and their `Uniform*` variants) gain a `wrap` option - `'word'` (the default, described above), `'char'` (breaks between every glyph, ignoring word boundaries), or `'none'` (never wraps; `maxWidth` still sizes and aligns the block, for measuring a fixed-width label that must stay on one line).
