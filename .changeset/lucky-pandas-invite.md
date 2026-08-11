---
"@mvpaint/engine": minor
---

The canvas's clear colour is configurable, and changeable live.

```ts
const handle = await createSceneRenderer("#board", { clearColor: "transparent" });

handle.setClearColor("#1e1e1e");
handle.setClearColor("rgba(0 0 0 / 40%)");
handle.getClearColor(); // [0, 0, 0, 0.4]
```

`clearColor` takes either form a colour can be written in and defaults to opaque white, which is
what the renderer drew on before. `setClearColor` shows on the next frame; there is nothing to
invalidate.

This is the background, and it is a clear rather than a node: nothing is picked, culled, sorted
or drawn for it, and it sits behind every node whatever their `zIndex`. An alpha below 1 leaves
the canvas that much see-through, so an application can put its own backdrop — a CSS grid, a
photograph, a checkerboard — behind the scene instead of covering the canvas with a rectangle.
Both contexts composite premultiplied alpha and the engine scales the value to match, so what is
written is the straight-alpha colour meant.

`FrameRenderer`'s `clearColor` option is the engine's `RGBA` tuple rather than a `GPUColor`, and
the class gained `setClearColor`/`getClearColor`. Its own default is opaque white, matching the
renderer's.
