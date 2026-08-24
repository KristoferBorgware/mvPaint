---
"@mvpaint/engine": patch
---

**Narrows the silhouette walk to the arrangements it was added for**, which is what a
self-crossing ribbon needs it not to do.

3.1.1 sent a path to the walk whenever any two edges met, a ring's own edges included. A ring that
crosses ITSELF is not what the walk exists for: `simpleLoops` cuts it where it crosses, and the
loops that come off carry the same rule between them as the ring did — a ray crosses the same
edges either way, and each loop winds once. So a self-crossing is read from what contains what,
as it was before 3.1.1, and the walk is kept for two rings meeting EACH OTHER, where part of a
ring's outline has material on both sides and part does not and no per-ring answer exists.

It matters for a stroke drawn as a thin ribbon — the outline every sketchy icon is made of. Its
two sides are a fraction of a unit apart and it crosses itself many times over, so rebuilding it
from boundary pieces asks the walk for hundreds of decisions at that separation, where losing one
piece of the inner side fills the ribbon as its own interior: a solid blob where the drawing was
a line.

The A5 fix is unaffected — subpaths that share a boundary or overlap still go through the walk,
and every case from it is still checked against the rules by grid sampling.

Grouping also got cheaper, since the walk now runs on far fewer paths: the Ghostscript tiger's 240
dense curve paths take 10ms against 31ms, and `simpleLoops` no longer allocates a list per vertex
for a ring that crosses nothing.
