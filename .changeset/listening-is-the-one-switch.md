---
"@mvpaint/engine": major
---

**Breaking. `Shape.pickable` is gone; `listening` is the single switch on whether the pointer can
reach a node.** Replace `shape.pickable = false` with `shape.listening = false`.

Two switches for one question was one too many, and they were not even the same shape: `pickable`
was per shape and `listening` cascaded, so a container could silence a subtree's events while
every shape in it stayed clickable. Now `pickNode()` and `nodesInBox()` walk the same
listening-pruned tree the event dispatcher does, and neither can disagree with the other about
what is reachable.

The cascade is the gain. `layer.listening = false` takes a whole overlay out of picking and out of
a marquee in one assignment, at the cost of one check rather than one per shape — the walk turns
back at the container instead of asking each shape about its ancestors. The subtree still draws;
`visible` is what takes it out of the picture.
