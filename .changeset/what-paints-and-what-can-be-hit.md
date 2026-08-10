---
"@mvpaint/engine": minor
---

**`fillEnabled`, `strokeEnabled` and `hitStrokeWidth`.**

`fillEnabled` and `strokeEnabled` suppress a fill or an outline while keeping the colour, so a
toggle in a panel does not have to remember what to put back.

They look alike and behave differently, and the asymmetry is worth knowing because it is the
engine's central split showing through. A fill's triangles exist whatever the fill says and the
paint is chosen per frame, so `fillEnabled` is a record rewrite and free to animate. A stroke's
ribbon is geometry the stroker either emitted or did not, so `strokeEnabled` re-tessellates — and
it changes what the shape MEASURES, exactly as `strokeAlign` does: a shape with its stroke
switched off measures its fill alone.

**`hitStrokeWidth` makes a hairline clickable without thickening it.**

```ts
new Polyline({ points, stroke: 'black', strokeWidth: 1, hitStrokeWidth: 24 })
```

A 1-unit line is a correct picture and an almost unhittable target. This hit-tests the same line
against a wider ribbon, which nothing draws and nothing measures. `'auto'`, the default, uses the
drawn width.

```
hit region  =  the shape stroked at this width instead
```

**In the shape's own units**, like `strokeWidth` and every other length on a `Shape`, so the hit
ribbon is ordinary geometry: it scales with the node and with its groups exactly as the line it
belongs to does. The two are set together and read as one thing — a 1-unit line with a 24-unit
target — and a ribbon that stayed put while the line grew would break that pairing at the first
scale.

It substitutes rather than adds, so a hit width *below* the drawn width makes a shape harder to
hit than it looks. That is the caller's to avoid, and the pairing above is why: whatever moves
`strokeWidth` moves this.

It costs a second tessellation, kept apart from the drawn one, because an outline stroked at
another width is different triangles. That pass is invalidated by the same things the drawn one
is, and by nothing else.

Nothing else is affected: `localBounds()` is the DRAWN extent, so a wide hit ribbon never reaches
a group's extent, a transformer's frame, a marquee test or the shadow silhouette. It is also the
one geometry-shaped property that does not bump the mesh epoch — only the pick cache is rebuilt,
so no lane repacks and no shadow re-bakes.

**`Shape.hitBounds()`** is the other half, and the two boxes are why it has to exist. Anything
rejecting a point cheaply before running the exact test must measure against the box the shape
can be HIT within, not the one it draws — a hairline's drawn box is a hairline wide, so a
rejection taken there clears every point the ribbon was widened to catch and the property has no
effect at all. `hitTestShape()` uses it; everything that measures the picture keeps
`localBounds()`.
