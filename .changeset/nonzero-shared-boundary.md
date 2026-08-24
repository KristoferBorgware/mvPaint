---
"@mvpaint/engine": patch
---

**Fixes a fill dropping a subpath that shares a boundary with the one beside it, under both fill
rules.**

Two subpaths that meet along an edge and are wound against each other are both filled — each is
wound once, and each point is inside exactly one ring, so `nonzero` and `evenodd` are in no doubt
and must agree. `nonzero` dropped one of them, and where the shared edge was the longest edge of
both, the path tessellated to no triangles at all and had no valid `localBounds()`.

```js
new Path({ d: "M0 0h10v10H0z M10 0v10h10V0z" }); // 200 square units, was 100
new Path({ d: "M0 0h2v20H0z M2 0v20h2V0z" }); // 80, was nothing at all
```

3.0.0 made `nonzero` the default (`Path.fillRule`, as SVG has it), so this was unreachable
before that release and reaches whole pieces of artwork after it — a fin meeting a body along a
line, a leaf against a stem.

**`evenodd` gains the neighbouring fix.** It grouped by containment, which has nowhere to put the
lens where two rings overlap without either containing the other: the pair came back empty.

```js
new Path({ d: "M0 0h10v10H0z M5 0v10h10V0z", fillRule: "evenodd" }); // 100, was nothing
```

### How

Reading a whole ring from one sampled edge is what was wrong: material on both sides of that edge
means the edge is interior, but it does not mean the RING is. Part of a ring's outline can be
silhouette while another part is a seam, so only the pieces can be classified — which is what
`unionBoundary` already did for glyph outlines. Both rules now go through it, differing only in
the question asked at each side of a piece: is the winding non-zero, or is the crossing count
odd. `nonzeroGroups` and the new `evenOddGroups` are that one walk under the two rules, so they
cannot disagree about a shape neither rule is in doubt about.

Rings that never meet — apart, or properly nested, which is most of a drawing — skip the walk and
are read from what contains what, as before. Which reading runs is decided by the geometry.

Two further differences come with the walk, both measured against the rules by grid sampling:

- **Subpaths that overlap while wound against each other** fill where they do not cancel, under
  either rule.
- **Overlapping subpaths wound the same way fill once** under `nonzero`. Two triangulations
  painting one region is invisible at full alpha and twice the ink at any other.

`ShapeContext.fill()` is unchanged: a described shape still groups by nesting, which is what its
`fill()` documents and what makes two overlapping rectangles a plus sign rather than a plus sign
with a hole in it.

### Cost

Grouping is geometry-dependent now. An icon-shaped path — an outer ring and two counters, ~100
points — takes about 12µs against 3µs for the containment reading it used to get, and the
Ghostscript tiger's 240 dense curve paths take 31ms at load against 16ms. It runs once per
outline, at the write that sets one, not per frame.
