---
"@mvpaint/engine": major
---

**Breaking.** The SVG loader reads what a document says — its stylesheet, its coordinate system,
its references — and reports what it could not read. Two attribute-surface defects are fixed with
it.

### `loadSvgDocument` returns the document, not just its nodes

```ts
const doc = loadSvgDocument(text, { fit: { width: 120, height: 120 } });
scene.root.addChild(doc.root);

doc.viewBox; // {x, y, width, height}, or the width/height box, or null
doc.width; // as declared, in user units, or null
doc.preserveAspectRatio; // as declared; 'xMidYMid meet' when absent
doc.notes; // what the loader passed over
```

The nodes are `doc.root`; everything else on the result is what a caller previously had to parse
the markup a second time to find out. **Migration is `doc` → `doc.root` at the call site.**

### It resolves the CSS

Rules in the document's `<style>` blocks are applied to the elements that match them, in the
cascade's own order: a presentation attribute (`fill="red"`) is the **weakest** of the three
levels, a rule from `<style>` beats it, and the element's inline `style="…"` beats both. Simple
class, type, id and universal selectors, compounded and joined by descendant or child
combinators, grouped with commas.

A document that paints through classes — which is how an editor writes a shared palette — drew
entirely in SVG's initial fill before this, and SVG's initial fill is **black**, so it was a
solid silhouette rather than a gap.

### It reports what it did not understand

```ts
doc.notes; // [{kind: 'unsupported-element', detail: 'text', count: 2}, …]
```

`unsupported-element`, `unsupported-property`, `unsupported-selector` and
`unresolved-reference`, each counted. A group that is missing things is otherwise
indistinguishable from a group that was always going to look like that, so an unread construct
surfaced weeks later as "that icon is the wrong colour". An application can log it; a test can
assert it is empty for an asset library it ships.

### A fit, on the group rather than in the points

`fit` maps the document's `viewBox` onto a box of the given size, honouring
`preserveAspectRatio` — including `none`, which stretches. It lands on the returned group's own
`x`/`y`/`scaleX`/`scaleY`, so resizing a loaded document is a scale write rather than a re-parse
that re-flattens every curve. `rootMatrix` stays as the escape hatch for a caller placing the
document itself, and is still baked into the points.

### `<use>`, `<symbol>`, nested `<svg>`, and one branch of a `<switch>`

`<use>` draws what it points at, wherever the definition sits, placed by `x`/`y`; a `<symbol>`
or `<svg>` target maps its own `viewBox` onto the size the `use` asks for. A reference to a
missing id, or one that leads back to its own ancestor, is reported rather than followed.

A `<switch>` renders the **first** branch whose conditions pass, where every branch used to
render. `systemLanguage` is matched against the `systemLanguage` option (default `'en'`) on the
primary subtag.

A gradient may also name another with `href`/`xlink:href`, taking its stops and every attribute
it does not declare itself. An editor writes a palette that way — one gradient holds the colours
and a dozen name it while placing themselves — and each of the dozen resolved to no paint at all
before, so the shapes using them drew nothing. The engine's own Tux example is 26 of them.

### `fill-rule`, and a `Path` that fills by winding

`fill-rule` is carried through to the shape, and **`Path.fillRule` defaults to `'nonzero'`, as
SVG does** — where the fill grouping was even-odd containment however the document was written.

The two rules agree on a shape whose holes are wound against their outers, which is what an
editor emits. They differ on rings wound the same way — nested is solid under nonzero and a hole
under even-odd — and on a ring that crosses itself, which even-odd nesting handed to a
triangulator that requires a simple polygon. `new Path({d, fillRule: 'evenodd'})` asks for the
old reading; a document that means it says so.

### **BUG:** an unclosed subpath is filled

`z` says the OUTLINE joins up. SVG closes an open subpath implicitly when it FILLS one (1.1
§11.4), and `ShapeContext.fill()` already read it that way, so the two ways into a `Path`
disagreed and the SVG side dropped the region entirely. Twemoji draws a face as one unclosed
arc: a fifth of that set drew its eyes and blush over nothing.

An open contour of three or more points now fills as if it were closed. The stroke is unchanged —
it is drawn as it was written, and only the fill auto-closes.

### `stroke-dasharray`, `stroke-dashoffset` and `display: none`

The dash reaches `Path.dash`, scaled with the geometry. An element with `display: none` is not
drawn, along with everything under it.

### A loaded document does not listen

`loadSvgDocument` returns non-listening nodes. A drag walks up to the nearest enclosing `Group`
and stops at the first one that is not draggable, so artwork dropped into a draggable object
stood between the pointer and the object that owns it — the drag died while selection went on
working, which reads as "drag is broken" and says nothing about the artwork. Pass
`listening: true` where the paths themselves should be pickable.

### **BUG:** `setAttr` writes the property, and `getAttr` reads it

`setAttr` preferred a `set<Key>()` method over the property of that name. A `set<Key>(value)`
method is not always an attribute setter — `setText(text, style)` replaces a text node's RUNS —
so on a uniform text node `setAttr('text', 'hello')` wrote one field while `getAttr('text')` read
another: the value never landed, and no `textChange` fired, because the pair compared equal.

The property wins wherever one can be written, which makes the two inverses by construction. A
`set<Key>()` method is the fallback for a key with no writable property — `Text.runs` is a
read-only property paired with `setRuns()` — and still behaves exactly as it did.

### A uniform text node declares its own attributes

`text`, `fontSize`, `fontStyle`, `textDecoration` and `letterSpacing` are attributes: `attrs`
enumerates them, `resetAttr` restores them, each announces its own `<key>Change`, and each is
written to a document.

`runs` is no longer among a uniform node's attributes, because on one it is derived — rebuilt
from `text` and the style on every write. Writing it named the content twice, and a uniform text
node refuses `runs` in its constructor, so such a document could not be read back at all.

### A `Transformer`'s colours are live

`borderColor`, `anchorFill` and `anchorStroke` are attributes with setters, and take any form a
colour can be written in:

```ts
transformer.borderColor = "#3b82f6";
transformer.anchorFill = theme.accent;
```

Each reaches the parts that draw with it on the next frame, so an application that switches
theme mid-session restyles its selection frame instead of rebuilding it. The frame also has an
`attrDefaults()` table now, so every attribute it declares can be reset.
