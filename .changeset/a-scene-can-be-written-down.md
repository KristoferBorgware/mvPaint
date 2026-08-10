---
"@mvpaint/engine": minor
---

**A scene can be saved, loaded and copied** — `toObject`, `fromObject` and `clone`, in a
`serialize/` module of their own.

```ts
const document = toObject(scene.root)      // plain data, JSON.stringify-able
const restored = fromObject(document)      // a live subtree again
const copy = clone(node)                   // a second node in the running scene
```

**Deliberately not on `Node`.** A node's job is to be part of a picture; a document format has
its own versioning, its own decisions about what a texture becomes on disk, and its own reasons
to change. Keeping it out here means a scene graph carries no opinion about how it is stored, and
an application with its own format can ignore all of this and walk `attributeNames()` itself.

A snapshot is a class name, the attributes that differ from that class's defaults, and the
children. Defaults are left out because a document is read by people as well as by programs — and
because a class that gains an attribute then reads old documents unchanged, the missing key being
the default it would have had.

`registerNodeType(name, TheClass)` is how an application's own `CustomShape` subclass round-trips
through the same reader. The engine's classes register themselves. An unregistered name throws
by name rather than dropping the node: a document that half-loads is worse than one that says
what is missing.

**What does not fit in JSON is reported rather than mangled.** A texture is a GPU object and a
`dragBoundFunc` is a function, so `replace`/`revive` are how an application says what stands in
for them — a texture as the URL it came from, most obviously — and `onSkipped` names anything
that went out without a stand-in.

`clone()` deliberately does not go through JSON. It copies attributes live, so two `Image`s from
one clone draw the same texture and the texture is loaded once. Listeners are NOT copied: a
handler is written for the node it was registered on and usually closes over it.

**Loading winds the stacking counter forward** past every `zIndex` it reads (`reserveZIndex()` in
`zOrder.ts`). A saved drawing carries absolute values from the session that made it, and without
this the first shape drawn after a load would take a number from near zero and land underneath
the drawing it was meant to go on top of.
