---
"@mvpaint/engine": major
---

**Breaking. A node has one parent, and `addChild` enforces it.** Handing a container a node that
already lives somewhere else now takes it out of there first.

It did not before, and the result was a node reachable down two branches with a `parent` pointer
naming only one of them. Everything in the engine is derived from that tree — the render walk,
picking, marquee selection, every bounds measurement — so such a node drew twice, was picked
twice, counted twice in its group's extent, and lost its place entirely when the container it no
longer thought it was in removed it. `moveTo()` was the only safe way to move a node between
containers; now both are.

Adding a node to the container it is already in moves it to the end of the list rather than
duplicating it. Adding a container to itself, or to something it already holds, throws — it would
otherwise be a cycle that `worldMatrix()` and every traversal would follow forever.

`Container` gains the rest of the vocabulary that goes with this:

| | |
| --- | --- |
| `add(...children): this` | variadic and chainable — `group.add(background, title)` |
| `getChildren(filter?)` | a COPY, safe to sort or keep, optionally narrowed |
| `hasChildren()` | whether it holds anything |
| `destroyChildren()` | empties it and finishes with each child, where `removeChildren()` leaves them usable |

`children` stays a read-only live view. A node's parent pointer and its place in a list are one
fact stored twice, and splicing the array directly would leave the two disagreeing with nothing
to notice; `getChildren()` is the copy to work on.

**`Transformer.add(node)` is now `Transformer.addNode(node)`**, because `Container.add()` means
something else and a Transformer is a Container. A frame's attached nodes are not its children —
they are what it wraps, and they stay where they are in the scene. `attach`, `detach`, `toggle`,
`has` and `clear` are unchanged.
