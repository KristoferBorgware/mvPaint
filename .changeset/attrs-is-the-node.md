---
"@mvpaint/engine": minor
---

**`node.attrs` is a live, writable view instead of a snapshot.** `node.attrs.x = 5` moves the
node.

It was a fresh plain object rebuilt on every read, so a write into it went into a throwaway and
was lost without a word — and reading `attrs` twice gave two objects that immediately began
drifting from the node and from each other.

Reads and writes now go straight through `getAttr()`/`setAttr()`, so there is no copy to fall out
of step and no write that lands somewhere the node cannot see. It still enumerates like an
object: `Object.keys(node.attrs)`, `'x' in node.attrs` and spreading all behave as before.

**Deleting an attribute restores its default.** `delete node.attrs.x`, or `node.resetAttr('x')`
by name. Assigning `undefined` assigns undefined — `dragDistance` means something by it — so
deleting is how to ask for the default instead.

Each class declares its defaults in `attrDefaults()` alongside its `attrKeys()`, and a test
checks the two lists against each other, since a key in one and not the other is a hole nothing
else would report. Two attributes have no default and say so rather than inventing one:
`Image.texture`, which has no blank picture to stand in for it, and a `Shape`'s `zIndex`, which
comes from a running counter — resetting it is `shape.zIndex = nextZIndex()`.

`attributeNames()` and `attributeDefaults()` are the public face of the two manifests, for a
serializer or a property inspector walking them from outside the class hierarchy.
