---
"@mvpaint/engine": major
---

**Breaking, in two directions at once. Every attribute now raises `'<key>Change'` from the
property itself, and the event no longer bubbles.**

It used to fire only from `setAttr()`, so `rect.x = 5` — which is how ported code and most
examples write it — announced nothing at all, and a property inspector or an undo stack watching
a scene simply missed most of what happened to it. And it used to bubble, so a watcher that
registered its handler on several nodes of one chain recorded a single edit once per level.

Both are fixed by moving the announcement to where the value is stored. `rect.x = 5` and
`rect.setAttr('x', 5)` are now indistinguishable to a listener, and the event fires on the node
that changed and nowhere else.

**Watching a subtree is now a listener per node.** `'add'` still bubbles, so a watcher can attach
one as each node joins. Delegation is no substitute and never was for a non-bubbling event: the
wrapped handler runs when the event reaches the ancestor it was registered on, which for these is
never.

Every attribute that was a plain field is an accessor now — `id`, `name`, `visible`, `listening`,
`preventDefault`, `draggable`, `dragDistance`, `dragBoundFunc`, `overlay`, the seven shadow
fields, and `Image`'s ten. Each guards on the value actually differing first, so writing a node's
own value back costs nothing.

`fill`, `stroke`, `shadowColor`, `tint` and the gradient stop lists are compared on the form they
were WRITTEN in rather than the tuple they parse to: one colour name written twice is one change,
while a freshly built tuple is a new value even when its four numbers match. That is the identity
rule the gradient points already followed.
