---
"@mvpaint/engine": minor
---

**Lines can be dashed.** `dash`, `dashOffset` and `dashEnabled` on every shape that strokes.

```ts
new Rect({ width: 200, height: 120, stroke: 'black', strokeWidth: 2, dash: [10, 6] })
```

Alternating on/off lengths in local units. An odd-length list is doubled, so `[6]` is six on and
six off. The pattern is measured along the OUTLINE rather than per edge, so a dash keeps its
length around a corner, and a dash that spans one still gets a proper join — which is the whole
reason the cut is made before the ribbon is built rather than after.

Each drawn piece is an open path, so each is capped per `lineCap`. That is what turns
`dash: [0, 12]` with `lineCap: 'round'` into a dotted line.

It is real geometry rather than a shader trick: a dash re-tessellates like any other geometry
input, follows the shape's scale, and is measured after the transform under
`strokeScaleEnabled: false` along with the width. A very fine pattern over a long path is a lot
of triangles. Animating `dashOffset` gives marching ants, at a re-tessellation per frame.

A closed ring is dashed round its closing edge like any other, and when the ring begins and ends
mid-dash the two halves are rejoined into one piece — they are one run of ink that the start
point happens to fall inside, and leaving them apart would show a pair of butt caps where the
pattern never broke.

Alignment survives. `strokeAlign: 'inside'` is answered from a RING's winding and a dash is an
open path with no enclosed side, so the sides are resolved once from the whole contour and
carried into each piece rather than each piece silently centring itself.
