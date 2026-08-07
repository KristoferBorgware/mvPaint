---
"@mvpaint/engine": patch
---

Two places in `input/` where a name or a direction still read as though `+y` were upward.

**Arrow-key panning.** ArrowUp moved the view down and ArrowDown moved it up. `Camera2D.y` is
the top edge of what is on screen, so moving the view up is a smaller `y`; the four arrows now
agree with each other and each moves the view the way it points.

**The marquee's edges.** `MarqueeOverlay` placed its `'top'` bar at the larger `y`, which is the
bottom of the box. The rectangle is symmetric so no pixel moves, but `edges.get('top')` is the
top edge now, matching the anchor names in `shapes/transformerMath.ts`.
