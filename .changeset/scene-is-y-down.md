---
"@mvpaint/engine": major
---

**Breaking.** The scene is y-down. `+y` is toward the bottom of the viewport.

This is the convention Canvas2D, SVG, the DOM and pointer events all already use, and the one every 2D drawing API an application is likely to be talking to is written in. Reading a pointer position, placing a shape and authoring an SVG path are now the same coordinate system rather than three that disagree about a sign.

Every shape still hangs DOWNWARD from its origin, exactly as before. What changed is the number that means "downward":

| | was | is |
| --- | --- | --- |
| `Rect`, `Image`, `MSDFText`, `VectorText` local span | `y ∈ [-height, 0]` | `y ∈ [0, height]` |
| Centring a shape on its own origin | `offsetY: -height / 2` | `offsetY: height / 2` |
| Camera's visible world rectangle | `y ∈ [y - height, y]` | `y ∈ [y, y + height]` |
| A text block's later lines | smaller y | larger y |
| Transformer `'top'` anchors | `+y` | `-y` |
| `ShapeContext.arc` / `ellipse`, `arcPath`, `circlePath` | increasing angle sweeps anti-clockwise on screen | sweeps CLOCKWISE on screen, as Canvas2D's does |
| `circlePath` default `startAngle` | `Math.PI / 2` | `-Math.PI / 2` (still the top) |

To migrate: negate the `y` of everything you place, and every `offsetY`. Sizes (`width`, `height`, `radius`, `strokeWidth`) are unsigned and unchanged, as are all of `x`.

`camera.x`/`camera.y` still mean "the world point at the viewport's top-left corner" — only the direction the view extends from it changed, so a camera reading (0, 0) still shows the origin in the same corner.

### Rotation now reads the way every other 2D API's does

A positive `rotation` turns a shape CLOCKWISE on screen. The rotation matrix is unchanged; a y-down frame is what reverses how it reads. Combined with degrees (see the angles changeset), `rotation: 45` means the same thing here as in Canvas2D and SVG.

`Camera2D.rotation` follows the same sense: positive turns the view clockwise, so its content appears to swing the other way.

### What is NOT affected

Triangle winding. Every pipeline sets `cullMode: 'none'`, so nothing decides whether to draw from it. The two places that read winding to decide GEOMETRY — which side a stroke expands onto (`strokeAlign`), and which ring of a contour set is a hole — take the ring's shoelace sign and its edge normals together, and a reflection reverses both, so they cancel. `orientation.test.ts` proves this directly by stroking a shape and its mirror image and comparing.

`loadSvgDocument` gets simpler: SVG is y-down and so is the scene, so the `rootMatrix` no longer wants a `[1,0,0,-1,0,0]` flip. If you were passing one to correct the old mismatch, remove it.

### Verifying a port

`packages/engine/src/orientation.test.ts` is the convention written out as assertions — where each shape's geometry sits, which way the camera extends, which side the transformer's top is on, and the two mirror invariants. It is the file to read when something lands upside down.
