---
"@mvpaint/engine": patch
---

**`MSDFText` and `VectorText` now say, once, when a `fill` or `stroke` assigned to them goes
nowhere.**

Glyph colour is a property of a RUN, so a node holding several independently styled runs has no
one fill and `Shape.fill` is not read by either text path — `text.fill = 'red'` assigned a field
nothing drew from, and the text stayed whatever colour its runs said. Invisible or unchanged text
with a fill set on it looks like a font that failed to load, which is a long way from the actual
cause.

The warning names `UniformMSDFText`/`UniformVectorText`, which carry exactly one run and whose
`fill`, `stroke` and `strokeWidth` do reach the glyphs. It is a warning rather than a throw
because the assignment is harmless and the node is otherwise fine, and it is said once per node
rather than once per assignment.
