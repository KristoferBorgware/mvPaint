---
"@mvpaint/engine": minor
---

`UniformMSDFText` and `UniformVectorText`: text whose whole string is one style, said in node attributes.

The engine models text as runs — segments of one string, each styled independently — which is what lets a paragraph mix weights and colours in one node. An application with no way to select part of a string does not need that and pays for it anyway: `fontSize` belongs to every run rather than to the node, and `Shape.fill` is not read by either text path, so `text.fill = 'red'` assigns a field nothing draws from.

These two are the other shape of the same node.

```ts
const label = new UniformMSDFText({ text: 'Hello', fontSize: 18 })
label.fill = 'crimson'                    // reaches the glyphs
label.textDecoration = 'underline'
label.fontStyle = 'italic bold'
```

Nothing is lost: they are ordinary `Text` nodes, so alignment, wrapping, curves, hit-testing, shadows and the transformer behave as on any other. `UniformVectorText` takes `fonts` and tessellates real outlines through the mesh lane, exactly as `VectorText` does.

| attribute | goes to |
| --- | --- |
| `text` | the single run |
| `fontSize` | default **12**, Konva's, not the engine's 32 |
| `fill` | the glyphs' colour — opaque black unless the constructor was told otherwise |
| `stroke` / `strokeWidth` | the per-letter outline; a width with no colour draws nothing |
| `fontStyle` | `'normal'` / `'bold'` / `'italic'` / the last two together, in either order and with either separator |
| `textDecoration` | `'underline'`, `'line-through'`, or both |
| `letterSpacing`, `padding` | as written |

Writing any of them rebuilds the run and re-shapes, so this is a live surface and not a constructor convenience. An unrecognised `fontStyle` or `textDecoration` throws at the assignment rather than silently drawing the plain face.

**These two classes paint by default**, which nothing else in the engine does. Text that renders invisibly is a worse default than text that renders in black, and it is the one place the deviation earns itself. `fill: null` still means paint nothing.

`lineHeight` keeps the engine's meaning — a multiplier over the font's ascent plus descent, where Konva multiplies `fontSize`.

### Measuring

```ts
label.getTextWidth(handle.fonts.resolveFamily(label.fontFamily))
label.measureSize('a string it is not currently drawing', fonts)
```

An MSDF node cannot measure itself: its glyphs live in atlases the renderer owns. `SceneResources.fonts` is where the provider comes from, and a scene builder now has it. `UniformVectorText` needs nothing passed in — its outlines are on the node.

### `padding`, on every text node

`TextLayoutOptions` and `Text` gained `padding`: blank space inside the block, in world px. It moves the text and grows the block, so everything measured from the block — bounds, hit-testing, a plate drawn behind it — sees it. Wrapping is unaffected: `maxWidth` is the width the text wraps at, so a padded block that wraps is `maxWidth + 2 × padding` across. Horizontal, vertical and path layouts all honour it.

### Not implemented, and what each would take

`fontVariant` (small-caps needs a second set of glyphs or a synthesis pass), `underlineOffset` and `charRenderFunc` (both reach below the shaper into how a glyph is placed), `wrap: 'char'` (the line breaker splits on words and spaces only), and `ellipsis` and `verticalAlign` (both need the shaper to know a fixed block height and truncate against it). There is no `wrap` attribute — wrapping is `maxWidth`, inherited from `Text`.

Reach for `MSDFText` or `VectorText` when one string has to carry more than one style. Passing `runs` or `style` to a uniform node throws and says so.
