# @mvpaint/engine

## 2.0.0

### Major Changes

- 4bc26c4: **Breaking.** A font reaches the engine by being registered under a name, and both kinds of text name it the same way.

  `VectorText` used to be handed a book — `new VectorText({ fonts: myPolygonFontBook })` — while `MSDFText` named a family. Two mechanisms for one question, and the object form meant every scene threaded a book through its own `prepare()` hook and every application wrote its own memo around the fetch.

  ```ts
  await loadFontFamily("inter", { vector: POLYGON_ATLAS_URLS });

  new MSDFText({ text: "Hello", fontFamily: "inter" }); // atlas glyphs
  new VectorText({ text: "Hello", fontFamily: "inter" }); // outline glyphs
  ```

  `fontFamily` now lives on `Text`, so it is one attribute for both. Which kind a node is stays a **choice made when it is written** — one samples a distance field, the other tessellates real contours, and they have different strengths. Two kinds in one scene naming one family is the ordinary case.

  A font parsed at runtime goes to the same place, which is why there is no escape hatch:

  ```ts
  registerFontFamily('dropped-file', { vector: await TtfFontBook.load(…) })
  new VectorText({ text, fontFamily: 'dropped-file' })
  ```

  ### There is no fallback face

  The engine ships **no typeface**. A node naming a family nothing was registered under draws **nothing**, and writes one `console.warn` naming the family — once per name, not once per frame, since the gather runs every frame and a per-frame warning makes a log useless.

  This replaces a fallback that could not work: an unresolved name previously resolved to the "default" family, which is empty unless the application loaded into it. Where an application had loaded one, a typo silently drew in the wrong face; where it had not, the text vanished with no explanation. Now it says so.

  `DEFAULT_FONT_FAMILY` survives as the name a node gets when it chooses none. It is not a fallback.

  ### Migrating

  | was                                    | is                                                                                   |
  | -------------------------------------- | ------------------------------------------------------------------------------------ |
  | `new VectorText({ fonts: book })`      | `registerFontFamily('name', { vector: book })`, then `fontFamily: 'name'`            |
  | `new PolygonFontBook(sources)` per app | `loadFontFamily('name', { vector: urls })` — fetch, parse and register, deduplicated |
  | `vectorText.fonts = otherBook`         | `vectorText.fontFamily = 'other-name'`                                               |

  `VectorText.fonts` remains as a **read-only** getter resolving the current family, or `undefined`. `VectorTextOptions` no longer has a `fonts` member, and `MSDFTextOptions` is now just `TextOptions`.

  ### Also

  Several places claimed the engine bundles an Inter MSDF atlas "so text draws out of the box". It does not, and has not: there is no `?url` PNG import in `packages/engine/src`, and a renderer built without `fonts` holds an empty book. The claim is corrected in `README.md`, `index.ts`, `core.ts`, `text/layout.ts`, `packages/ttf/README.md` — and in `LICENSE`, which declared redistribution of a font at `packages/engine/src/text/fonts`, a path that does not exist.

  New: [RESOURCES.md](../RESOURCES.md) documents how fonts and pictures are shared, and what the cache holds.

- 25d5997: **Breaking.** Every angle an application writes is now in DEGREES.

  `rotation: 45` is a eighth of a turn. It was 45 radians — a little over seven full turns — so this is a change that looks like nothing and moves everything.

  |                                                  | was                            | is                                                      |
  | ------------------------------------------------ | ------------------------------ | ------------------------------------------------------- |
  | `Node.rotation` (and every subclass)             | radians                        | degrees                                                 |
  | `Camera2D.rotation`                              | radians                        | degrees                                                 |
  | `rotationSnaps`                                  | radians, default `[0, π/4, …]` | degrees, default `[0, 45, 90, 135, 180, 225, 270, 315]` |
  | `rotationSnapTolerance`                          | radians, default `0.12`        | degrees, default `7`                                    |
  | `ShapeContext.arc` / `ellipse` / `circle` angles | radians                        | degrees                                                 |

  To migrate, multiply every angle by `180 / Math.PI`, or replace it with the degree value it always meant — `Math.PI / 4` becomes `45`.

  ### What did not change

  Everything that computes with an angle rather than storing one still works in radians, because that is what `Math.cos`, `Math.atan2` and `Quaternion.fromAxisAngle` take: `decompose2D`, `OrientedBox.rotation` and the rest of `transformerMath`, `worldRotationOf`, `TextQuad.rotation`, `Matrix4x4.rotationZ`, and the shaders.

  The two units meet at named boundaries — `Node.localMatrix` on the way down, `Node.applyLocalMatrix` on the way back up — so a value crosses in exactly one place per property. Code that mixes the two, such as a transformer gesture pushing a world matrix onto a node, converts at that seam and nowhere else.

  A field's unit is part of what its name means here: anything holding radians says so in its doc comment, and anything that does not is degrees.

  ### `ShapeContext` diverges from Canvas2D here

  `arc()` and `ellipse()` mirror the Canvas2D methods, which take radians. They take degrees. One method in a different unit from every other angle in the engine is the kind of difference only ever found by drawing the wrong thing, so consistency won.

  ### New

  `degToRad` and `radToDeg` are exported from `@mvpaint/engine` (`math/angle.ts`), for code that has to cross the boundary itself — reading `worldRotationOf` and writing it to a node, for instance.

- 1b7affe: **Breaking.** Every attribute Konva puts on its `Node` is on this `Node`, declared once.

  Six of them were on `Shape`, and two of those were declared a second time on `Group` — two
  independent fields with the same name and the same meaning. `listening` was a real public field
  that `attrKeys()` never listed, so a property inspector or serializer walking `node.attrs` could
  not see it. Three more had no counterpart at all.

  |                    | was                              | is                      |
  | ------------------ | -------------------------------- | ----------------------- |
  | `visible`          | `Shape` and `Group`, separately  | `Node`                  |
  | `draggable`        | `Shape` and `Group`, separately  | `Node`                  |
  | `opacity`          | `Shape`                          | `Node`, and it cascades |
  | `zIndex`           | `Shape`                          | `Node`                  |
  | `width` / `height` | `Shape`                          | `Node`                  |
  | `listening`        | `Node`, absent from `attrKeys()` | `Node`, listed          |
  | `preventDefault`   | —                                | `Node`                  |
  | `dragDistance`     | —                                | `Node`                  |
  | `dragBoundFunc`    | —                                | `Node`                  |

  `node.attrs` on any node — a bare `Container`, a `Group`, a `Layer`, a `Shape` — now reports the
  21 attributes above plus the transform. `Group` and `Layer` no longer override `attrKeys()`;
  neither has anything of its own left to add.

  Also new: the compound accessors `position`, `scale`, `skew`, `offset`, `size` and
  `absolutePosition`, each reading and writing its pair of components. They are accessors, NOT
  attributes — `attrs` reports `x` and `y`, never `position`, so no value is listed twice and
  `setAttr` has one way to write each field.

  ```ts
  node.position = { x: 10, y: 20 };
  node.absolutePosition; // where x/y land in the scene, through every ancestor
  node.absolutePosition = { x: 0, y: 0 }; // move it there, whatever the chain does
  ```

  ### Opacity cascades

  `opacity` multiplies through the ancestor chain. A shape at `1` inside a group at `0.5` paints
  at `0.5`; `absoluteOpacity()` is the product, and it is what the render lanes write into the
  per-object record and what `isOpaqueShape()` classifies on.

  ```ts
  group.opacity = 0.5; // everything in it fades, and nothing is written onto the children
  ```

  The subtree is composited per object rather than as a unit, so two children of a faded group
  blend against one another wherever they overlap. Compositing once would mean drawing the subtree
  to an offscreen target; this is the value-level fade.

  ### `Layer.enabled` is removed

  A layer is switched off with `visible` now, like every other node.

  ```ts
  layer.enabled = false; // was
  layer.visible = false; // is
  ```

  `LayerOptions` and `GroupOptions` are aliases for `NodeOptions`; `new Layer({ enabled: false })`
  becomes `new Layer({ visible: false })`.

  `hiddenByGroup()` is `hiddenByAncestor()`, and it asks about any ancestor rather than only the
  groups: hiding a subtree is not a claim about selection, so a hidden `Layer` or bare `Container`
  hides what is in it exactly as a `Group` does. `closestGroup()`, `outermostGroup()` and
  `draggableGroup()` are unchanged — those ARE about selection, and still walk `Group`s alone.

  ### `zIndex`, `width` and `height` on a container

  Carried, and not read. Only a `Shape` occupies a slot in the render order or draws from a size,
  and a group's extent comes from `group.bounds()`, measured on demand from what it holds. This is
  Konva's position too — a Konva `Group`'s `width` is `0` unless assigned, and `getClientRect()`
  is the real answer there.

  A `Shape` still takes its `zIndex` from the running counter (`nextZIndex()`); a `Node` left at
  `0` unless given one.

  ### The three drag/input attributes

  ```ts
  node.dragDistance = 30; // pointer travel before a drag on this node starts
  node.dragBoundFunc = (p) => ({ x: p.x, y: 0 }); // a slider, constrained in WORLD space
  node.preventDefault = false; // let the browser act on a press over this node
  ```

  `dragDistance` overrides the dispatcher's own threshold (default 6) for the node the press took
  hold of. It governs when a DRAG begins, not what counts as a click — a press that never travels
  far enough for either is still a click. `dragBoundFunc` is handed a world position and returns
  one, matching Konva; the dispatcher maps the result back through the parent. `preventDefault` is
  read off the node under the pointer; the canvas's own gestures — a transformer handle, a
  middle-button pan, a pinch, the wheel, the context menu — suppress the browser default whatever
  it says, since no node is their subject.

  ### Not implemented, and why

  Three of Konva's `Node` attributes are deliberately absent rather than present as fields nothing
  consults:

  - **`globalCompositeOperation`** — a canvas 2D blend mode. Here it needs a render pipeline per
    mode and a repack of the draw list by mode.
  - **`transformsEnabled`** — names an optimisation `Node.localMatrix()` already performs
    unconditionally: rotation, skew and scale are each skipped when they are the identity.
  - **`filters`** — Konva's filters run over a cached canvas, and there is no cache-to-texture
    layer. (`Image.filter`, the texture sampling mode, is unrelated.)

  `shapes/konvaParity.test.ts` holds the whole attribute set as data and pins all three claims —
  the full list present, those three absent, the compounds accessors and not attributes.

  ### Migrating

  - `layer.enabled` → `layer.visible`
  - `hiddenByGroup(node)` → `hiddenByAncestor(node)`
  - A subclass with a field called `size` now shadows `Node.size`; rename it.
  - If an application relied on group opacity doing nothing, set the value on the shapes instead.

- 25d5997: **Breaking.** A colour is now checked to BE a colour, gradient stops take the flat form, and both read back as they were written.

  ### The tuple is checked

  `isRGBA` tested for "not a string", so every non-string value passed through `parseColor` untouched and was handed on as though it were a colour. It now tests for four finite numbers, and `parseColor` raises anything else.

  What that admitted, the object record wrote. `f32.set` ignores a scalar entirely and takes only as many channels as a short array holds, leaving the rest of the record holding the previous object's colour — so `shape.fill = 42` drew in some other shape's colour, and `shape.fill = [1, 0]` drew half of one. Both look like a colour-picking mistake and neither can be traced to the assignment.

  Now refused: `42`, `null`, `undefined`, `[1, 0]`, `[1, 0, 0]`, `[1, 0, 0, 1, 1]`, `[1, 0, 0, NaN]`, `['1','0','0','1']`, `{r,g,b,a}`. A real tuple is still passed straight through, as the same instance.

  ### Gradient stops take either form

  `fillLinearGradientColorStops` and `fillRadialGradientColorStops` accept one flat array alternating offsets and colours beside the list of stop objects:

  ```ts
  shape.fillLinearGradientColorStops = [0, "red", 0.5, "blue", 1, [0, 1, 0, 1]];
  shape.fillLinearGradientColorStops = [
    { offset: 0, color: "red" },
    { offset: 1, color: "blue" },
  ];
  ```

  The flat form previously read as a list of stop objects: each number and each string yielded `{offset: undefined, color: undefined}`, which reached the object record as a NaN stop position and then threw `TypeError: undefined is not iterable` inside the batcher, several layers from the assignment.

  An offset must be a finite number, and a stop list may hold at most `MAX_GRADIENT_STOPS` (8). Both raise rather than truncate: a gradient quietly missing its last colours still draws, and looks like a colour-picking mistake rather than a limit.

  **This reaches `loadSvgDocument`.** SVG gradient stops are assigned through the same setters, so a document whose gradient carries more than 8 stops now fails to load instead of rendering with the first 8. Reduce the stop list in the document, or catch the load.

  ### Colours read back as written

  Every colour property keeps the value it was assigned beside the tuple it renders through, under a parallel `…Input` accessor:

  ```ts
  shape.fill = "tomato";
  shape.fill; // [1, 0.388, 0.278, 1]  — what it renders through
  shape.fillInput; // 'tomato'              — what was written
  ```

  Added: `fillInput`, `strokeInput`, `shadowColorInput`, `fillLinearGradientColorStopsInput`, `fillRadialGradientColorStopsInput` on `Shape`, and `tintInput` on `Image`. The stop-list ones give back the flat form when that is what was written.

  The tuple stays the value: every comparison the engine makes reads `fill`, not `fillInput`, and the written form never reaches a buffer. `attrs` and `getAttr()` are unchanged and still report the tuple.

  ### Also

  `MAX_GRADIENT_STOPS` moves to `render/color.ts` beside the parser that enforces it, and is re-exported from `render/meshFormat.ts` — the import path every consumer already uses is unchanged.

  `ColorStopsInput` is new: the type of a whole stop list in either written form.

- 4bc26c4: Heavy resources are built once and freed when the last holder lets go.

  `images.load(url)` used to fetch, decode and upload on every call, so two nodes wanting the same picture caused two of everything; `images.fromSvg()` re-ran the browser decode and `getImageData` round trip per call. Font data was worse: outlines had no engine-side cache at all, so every application wrote the same memo.

  ```ts
  const a = await images.load("/logo.png"); // fetched, decoded, uploaded
  const b = await images.load("/logo.png"); // the same texture, no work at all
  a.destroy(); // b is still drawing; nothing is freed
  b.destroy(); // now it is
  ```

  `destroy()` means _release one holder_. A texture built directly has exactly one, so nothing changes for code that was already balancing its own calls — what changes is that a texture two scenes share survives the first of them being torn down.

  ### What is shared, and where

  Two layers, because a `GPUTexture` belongs to a device and cannot be handed to a second renderer while a parsed glyph outline belongs to no device at all.

  |                                    | scope        | keyed by                                          |
  | ---------------------------------- | ------------ | ------------------------------------------------- |
  | `images.load`                      | per renderer | the URL                                           |
  | `images.fromSvg`                   | per renderer | the document **and** its resolved pixel size      |
  | `images.fromSource` / `fromPixels` | per renderer | an explicit `key` argument — otherwise not shared |
  | `loadPolygonFonts()`               | global       | the set of source URLs                            |
  | `loadMsdfAtlases()`                | global       | each metrics URL                                  |

  A bitmap and a pixel buffer are objects rather than names, so nothing can tell two of them apart; both gained a trailing optional `key` to opt in. The debug `label` is deliberately not used for this — a debug string that silently decided which callers shared a texture would be a trap.

  Nothing keeps a second CPU copy of what is already on the GPU: the global layer caches the fetch and the parse, and the picture itself is deduplicated at the texture layer.

  ### Two engine-side loaders replace a memo every application writes

  ```ts
  const book = await loadPolygonFonts([{ style: 'regular', url: '/fonts/inter-regular.polygons.json' }, ...])
  const { sources } = await loadMsdfAtlases([{ style: 'regular', metricsUrl: '…json', imageUrl: '…png' }, ...])
  ```

  Both dedupe across remounts, across renderers, and across two scenes wanting the same face. `packages/example-app/src/fonts/index.ts` shows the shape it leaves behind: addresses, and nothing else.

  ### Unloading with a scene

  `Scene` gained `own()` and `dispose()`:

  ```ts
  const checker = scene.own(images.fromPixels(pixels, 256, 256, "checker"));
  // …later
  scene.dispose(); // destroys the tree, then releases everything own()ed, last first
  ```

  The scene builder is the holder, because an `Image` node is not — one texture is often drawn by ten of them, and `Shape`'s position that a texture belongs to the application is unchanged. A resource two scenes `own()` survives the first `dispose()`.

  **Destroying a renderer now disposes its scene**, so a page that tears one down releases what its scene was holding rather than leaving it on the device.

  ### Breaking

  - `ImageTexture` carries a `lifetime`. A custom implementation of the interface has to supply one (`new SharedLifetime()`) and route `destroy()` through it: `if (!this.lifetime.release()) return`.
  - `SceneResources` carries `fonts: FontFamilies` — the provider an `MSDFText` is measured against, which scene-building code previously had no way to reach. Anything constructing a `SceneResources` by hand supplies it; `handle.fonts` is where it comes from.
  - `Shape.strokeWidth` is an accessor rather than a plain field, so a subclass can hear the assignment. It stores and nothing more; changing it still needs `markGeometryDirty()`.

- 25d5997: **Breaking.** Nothing paints, and nothing drags, unless it was asked to.

  `new Rect({ width: 100, height: 60 })` used to be a solid black box. It is now a rectangle that draws no pixels — still measured, still picked, still stacked, but invisible until given a colour. `{ stroke: 'red' }` draws a 2-unit outline where it previously drew nothing.

  |                         | was                    | is                                  |
  | ----------------------- | ---------------------- | ----------------------------------- |
  | `Shape.fill`            | opaque black           | `null` — no fill                    |
  | `Shape.stroke`          | opaque black           | `null` — no outline                 |
  | `Shape.strokeWidth`     | `0`                    | `2`                                 |
  | `Shape.draggable`       | `true`                 | `false`                             |
  | `Group.draggable`       | `true`                 | `false`                             |
  | `Rect` `width`/`height` | `1`                    | `0`                                 |
  | `Circle.radius`         | `1`                    | `0`                                 |
  | `Polyline.strokeWidth`  | `1` (its own override) | `2`, inherited like everything else |

  `fill` and `stroke` read back as `RGBA | null`, and take `null` as well as a colour. Two predicates ask the question directly:

  ```ts
  shape.hasFill(); // a fill colour, or a gradient with stops in it
  shape.hasStroke(); // a stroke colour AND a width to draw it at
  ```

  A width with no colour is not a stroke, which is what stops the new default width from putting an outline on everything.

  ### An unfilled shape is still clickable

  Picking runs against the same triangles the mesh lane draws, so a shape that stopped tessellating its fill would go unclickable in its middle while its outline stayed live — the interior of an outlined rectangle would fall through to whatever is behind it. Konva has no such hole, and neither does this.

  `FillPriority` therefore gains `'none'`: the fill triangles are tessellated and uploaded exactly as before, and the fragment shader returns a transparent fragment for them. It costs one branch in each of the two mesh shaders and nothing on the CPU.

  `fillPriority` READS as `'none'` whenever the chosen mechanism has nothing to paint with — no fill colour, or a gradient with no stops — while still recording the choice you wrote. So `fillPriority = 'linear-gradient'` reads back as `'none'` until stops arrive, and as `'linear-gradient'` after.

  A `ShapeContext` segment material resolves the same way against ITS OWN paint: `style({ fill })` on a shape that has no fill of its own paints the segment's colour, rather than inheriting the shape's resolved `'none'`.

  ### Consequences worth knowing

  `isOpaqueShape` now returns false for a shape with no fill: every fill fragment it paints is transparent, and the opaque pass writes depth, so it may not go there.

  `MeshMaterial.fill` and `.stroke` are `RGBA | null`. A custom material handed to the mesh lane may leave either out; the batchers write transparent into the record's four floats rather than skipping them, since the slot is reused frame to frame.

  ### Migrating

  Add the paint you were relying on: `fill: 'black'` reproduces the old default exactly. For an application that wants the old blanket behaviour rather than per-shape opt-in, one pass over the tree after building is enough — `packages/example-app/src/components/WebGPUCanvas.tsx` does exactly that for `draggable`, and shows how to keep a deliberate opt-out intact while doing it.

- 25d5997: **Breaking.** The scene is y-down. `+y` is toward the bottom of the viewport.

  This is the convention Canvas2D, SVG, the DOM and pointer events all already use, and the one every 2D drawing API an application is likely to be talking to is written in. Reading a pointer position, placing a shape and authoring an SVG path are now the same coordinate system rather than three that disagree about a sign.

  Every shape still hangs DOWNWARD from its origin, exactly as before. What changed is the number that means "downward":

  |                                                         | was                                              | is                                             |
  | ------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
  | `Rect`, `Image`, `MSDFText`, `VectorText` local span    | `y ∈ [-height, 0]`                               | `y ∈ [0, height]`                              |
  | Centring a shape on its own origin                      | `offsetY: -height / 2`                           | `offsetY: height / 2`                          |
  | Camera's visible world rectangle                        | `y ∈ [y - height, y]`                            | `y ∈ [y, y + height]`                          |
  | A text block's later lines                              | smaller y                                        | larger y                                       |
  | Transformer `'top'` anchors                             | `+y`                                             | `-y`                                           |
  | `ShapeContext.arc` / `ellipse`, `arcPath`, `circlePath` | increasing angle sweeps anti-clockwise on screen | sweeps CLOCKWISE on screen, as Canvas2D's does |
  | `circlePath` default `startAngle`                       | `Math.PI / 2`                                    | `-Math.PI / 2` (still the top)                 |

  To migrate: negate the `y` of everything you place, and every `offsetY`. Sizes (`width`, `height`, `radius`, `strokeWidth`) are unsigned and unchanged, as are all of `x`.

  `camera.x`/`camera.y` still mean "the world point at the viewport's top-left corner" — only the direction the view extends from it changed, so a camera reading (0, 0) still shows the origin in the same corner.

  ### Rotation now reads the way every other 2D API's does

  A positive `rotation` turns a shape CLOCKWISE on screen. The rotation matrix is unchanged; a y-down frame is what reverses how it reads. Combined with degrees (see the angles changeset), `rotation: 45` means the same thing here as in Canvas2D, SVG and Konva.

  `Camera2D.rotation` follows the same sense: positive turns the view clockwise, so its content appears to swing the other way.

  ### What is NOT affected

  Triangle winding. Every pipeline sets `cullMode: 'none'`, so nothing decides whether to draw from it. The two places that read winding to decide GEOMETRY — which side a stroke expands onto (`strokeAlign`), and which ring of a contour set is a hole — take the ring's shoelace sign and its edge normals together, and a reflection reverses both, so they cancel. `orientation.test.ts` proves this directly by stroking a shape and its mirror image and comparing.

  `loadSvgDocument` gets simpler: SVG is y-down and so is the scene, so the `rootMatrix` no longer wants a `[1,0,0,-1,0,0]` flip. If you were passing one to correct the old mismatch, remove it.

  ### Verifying a port

  `packages/engine/src/orientation.test.ts` is the convention written out as assertions — where each shape's geometry sits, which way the camera extends, which side the transformer's top is on, and the two mirror invariants. It is the file to read when something lands upside down.

### Minor Changes

- 4bc26c4: `UniformMSDFText` and `UniformVectorText`: text whose whole string is one style, said in node attributes.

  The engine models text as runs — segments of one string, each styled independently — which is what lets a paragraph mix weights and colours in one node. An application with no way to select part of a string does not need that and pays for it anyway: `fontSize` belongs to every run rather than to the node, and `Shape.fill` is not read by either text path, so `text.fill = 'red'` assigns a field nothing draws from.

  These two are the other shape of the same node.

  ```ts
  const label = new UniformMSDFText({ text: "Hello", fontSize: 18 });
  label.fill = "crimson"; // reaches the glyphs
  label.textDecoration = "underline";
  label.fontStyle = "italic bold";
  ```

  Nothing is lost: they are ordinary `Text` nodes, so alignment, wrapping, curves, hit-testing, shadows and the transformer behave as on any other. `UniformVectorText` takes `fonts` and tessellates real outlines through the mesh lane, exactly as `VectorText` does.

  | attribute                  | goes to                                                                                               |
  | -------------------------- | ----------------------------------------------------------------------------------------------------- |
  | `text`                     | the single run                                                                                        |
  | `fontSize`                 | default **12**, Konva's, not the engine's 32                                                          |
  | `fill`                     | the glyphs' colour — opaque black unless the constructor was told otherwise                           |
  | `stroke` / `strokeWidth`   | the per-letter outline; a width with no colour draws nothing                                          |
  | `fontStyle`                | `'normal'` / `'bold'` / `'italic'` / the last two together, in either order and with either separator |
  | `textDecoration`           | `'underline'`, `'line-through'`, or both                                                              |
  | `letterSpacing`, `padding` | as written                                                                                            |

  Writing any of them rebuilds the run and re-shapes, so this is a live surface and not a constructor convenience. An unrecognised `fontStyle` or `textDecoration` throws at the assignment rather than silently drawing the plain face.

  **These two classes paint by default**, which nothing else in the engine does. Text that renders invisibly is a worse default than text that renders in black, and it is the one place the deviation earns itself. `fill: null` still means paint nothing.

  `lineHeight` keeps the engine's meaning — a multiplier over the font's ascent plus descent, where Konva multiplies `fontSize`.

  ### Measuring

  ```ts
  label.getTextWidth(handle.fonts.resolveFamily(label.fontFamily));
  label.measureSize("a string it is not currently drawing", fonts);
  ```

  An MSDF node cannot measure itself: its glyphs live in atlases the renderer owns. `SceneResources.fonts` is where the provider comes from, and a scene builder now has it. `UniformVectorText` needs nothing passed in — its outlines are on the node.

  ### `padding`, on every text node

  `TextLayoutOptions` and `Text` gained `padding`: blank space inside the block, in world px. It moves the text and grows the block, so everything measured from the block — bounds, hit-testing, a plate drawn behind it — sees it. Wrapping is unaffected: `maxWidth` is the width the text wraps at, so a padded block that wraps is `maxWidth + 2 × padding` across. Horizontal, vertical and path layouts all honour it.

  ### Not implemented, and what each would take

  `fontVariant` (small-caps needs a second set of glyphs or a synthesis pass), `underlineOffset` and `charRenderFunc` (both reach below the shaper into how a glyph is placed), `wrap: 'char'` (the line breaker splits on words and spaces only), and `ellipsis` and `verticalAlign` (both need the shaper to know a fixed block height and truncate against it). There is no `wrap` attribute — wrapping is `maxWidth`, inherited from `Text`.

  Reach for `MSDFText` or `VectorText` when one string has to carry more than one style. Passing `runs` or `style` to a uniform node throws and says so.

### Patch Changes

- 1b7affe: Two places in `input/` where a name or a direction still read as though `+y` were upward.

  **Arrow-key panning.** ArrowUp moved the view down and ArrowDown moved it up. `Camera2D.y` is
  the top edge of what is on screen, so moving the view up is a smaller `y`; the four arrows now
  agree with each other and each moves the view the way it points.

  **The marquee's edges.** `MarqueeOverlay` placed its `'top'` bar at the larger `y`, which is the
  bottom of the box. The rectangle is symmetric so no pixel moves, but `edges.get('top')` is the
  top edge now, matching the anchor names in `shapes/transformerMath.ts`.

## 1.0.0

### Major Changes

- 1eada49: **Breaking.** The text classes are renamed so each says where its glyphs come from.

  | was                | is                |
  | ------------------ | ----------------- |
  | `Text`             | `MSDFText`        |
  | `TextOptions`      | `MSDFTextOptions` |
  | `TextBlock`        | `Text`            |
  | `TextBlockOptions` | `TextOptions`     |

  `MSDFText` samples a distance-field atlas and `VectorText` tessellates real outlines, so the pair now reads as the choice it is. `Text` is the abstract base both extend — the runs, the block layout options and the shaping-invalidation protocol — and naming it `Text` puts the plain word on the shared idea rather than on one of the two implementations.

  To migrate: `Text` becomes `MSDFText` at every construction site, and any code naming `TextBlock` as a base or a parameter type becomes `Text`. `TextOptions` changes meaning rather than disappearing — it is the base options interface now, and the MSDF one is `MSDFTextOptions`.

  Selectors move with the class, since `nodeName` is the concrete class name: `find('Text')` matched the MSDF node and now matches nothing, `find('MSDFText')` matches it. `nodeType` is unchanged at `'Shape'` for both.

  No behaviour changes.

### Minor Changes

- 61c0880: The engine no longer ships a font. Four Inter MSDF atlases — the PNGs and their metrics JSON — were bundled as a fallback for applications that had not chosen a typeface; they are gone, along with `MSDF_ATLAS_SOURCES`, `STYLE_JSON` and `ATLAS_LAYER_SIZE`. An atlas is an application's asset, exactly as glyph outlines have always been, and half a megabyte of somebody else's typeface has no business in the tarball of an application that supplies its own.

  **`fonts` omitted now means no atlases**, where it used to mean Inter. The renderer starts with an empty font book: nothing is fetched, no texture is uploaded, and `Text` draws nothing until `setFonts()` supplies a set. A scene of rectangles issues no font request at all. Applications already passing `fonts` are unaffected.

  **`msdfFontProvider()` requires its `styles` argument.** There is no default set left to measure against, and measuring against metrics you are not drawing with wraps text in the wrong place. Pass the same sources you passed to `createSceneRenderer`.

  `atlasLayerSize([])` returns 1x1 rather than `-Infinity`, which is the size of the placeholder texture behind an empty book.

  Two things fall out of this. A consumer's bundle no longer carries four unrequested PNGs. And `optimizeDeps: { exclude: ['@mvpaint/engine'] }` is no longer needed on a Vite dev server: that workaround existed because the atlases resolved through `import.meta.url`, which points into `node_modules/.vite/deps/` once the engine is pre-bundled, and the dist now contains no `import.meta.url` and no assets to resolve.

  `packages/example-app` serves this repository's Inter set from `public/fonts/`, fetched at runtime — a datasource like any other, and the shape an application's own asset folder takes. The SIL Open Font Licence moved there with the files: the tarball no longer carries `LICENSE-Inter.txt`, because it no longer carries anything that licence covers. MIT is now the whole of this package's licensing.

- 8a441b1: Read SVG path data in-house. `svgpath` was the engine's second runtime dependency and its only CommonJS one; `earcut` is now the only one it has.

  Two new modules cover what it did. `svg/pathData.ts` reads the `d` grammar — the carried-over command letters, the optional separators, the packed arc flags — and hands over absolute movetos, linetos, cubics and quadratics, with the relative forms, the axis shorthands and the smooth shorthands all resolved. `svg/arcToCubic.ts` converts elliptical arcs to cubics. Both are written from the SVG 1.1 specification: section 8.3.9 for the grammar, appendix F.6 for the endpoint-to-centre arc conversion, with section numbers cited against each step.

  Behaviour is held to the library it replaces by a differential test, which keeps `svgpath` as a devDependency and compares flattened contours across the grammar, six transform matrices, three flattening tolerances, and all 287 paths in the example app's tiger and Tux artwork. Agreement is to 1e-9, four orders of magnitude under the default flattening tolerance.

  One deliberate difference. An arc whose endpoints coincide is now omitted, which is what the specification asks for (F.6.2); `svgpath` emits a zero-length lineto, reaching the mesh builder as a contour of two identical points. Nothing else changes.

  Dropping the CommonJS dependency also makes the package loadable with no build step: `earcut` is already ESM, so a browser reaches the whole engine through a two-line import map, with no bundler and no CDN conversion in between.

### Patch Changes

- 9c941ee: Ship `src/` alongside `dist/`, so Go to Definition lands on the real TypeScript. Both packages emit declaration maps, and every one of them names a path under `src/` — following that path from an editor reaches the file it names. The source is where this codebase's documentation lives, so reading it is the point of jumping to it. `@mvpaint/ttf` emits declaration maps for the first time here.

  `src/**/*.test.ts` stays out through a negated pattern in `files`. Nothing in `src/` reaches an application's bundle: `exports` lists only the package entry points and routes each to `dist/`, so `src/` is never in the module graph and occupies disk in `node_modules` only. The engine's tarball goes from 644 kB to 893 kB packed; ttf's adds four files.

- 68d7ba8: Prune down to what an application imports. Two changes together: `sideEffects: false` in both manifests, which tells a bundler a file can be dropped whole when nothing is imported from it, and `preserveModules` in both builds, which emits one file per source module rather than concatenating them into shared chunks. `dist/` now mirrors `src/` in each package, so a bundler prunes at module granularity instead of at chunk granularity.

  Measured with esbuild against the real tarball, ESM and minified:

  | Consumer import                                  | before | after  |
  | ------------------------------------------------ | ------ | ------ |
  | `import { Vector2 } from '@mvpaint/engine'`      | 23 kB  | 1 kB   |
  | `import { Vector2 } from '@mvpaint/engine/core'` | 14 kB  | 1 kB   |
  | `import { Rect }`                                | 58 kB  | 38 kB  |
  | `import * as E`                                  | 273 kB | 283 kB |

  Importing the whole surface grows by 10 kB, because per-module boundaries leave less for a bundler to hoist across. Everything narrower shrinks. What remains behind `Rect` is its own dependency cone — `Node`, `Shape`, the stroke builder and the math types.

  `@mvpaint/ttf` measures the same either way at its current size; it emits three modules so that the property holds as the package grows rather than being noticed later.

  No API change, and no change to what is exported from any entry point. The WebGL2 fallback is still reached through a dynamic import and still lands in its own chunk in a consumer's build.

- 61c0880: Build against Vite 8. The engine's one dynamic import — the WebGL2 fallback in `createSceneRenderer` — made Vite inline its module-preload helper into the published chunk as `const __vitePreload = …`. A consumer bundling that dist sees the same dynamic import and injects the helper again: Vite 6 and 7 notice the existing declaration and skip, Vite 8 does import analysis in Rolldown, which has no such guard, and the build dies with `Identifier '__vitePreload' has already been declared`. Every consumer on Vite 8 hit it and no configuration of theirs avoided it.

  The engine now builds in Vite's **library mode**, which is what it should always have been. Vite gates the helper injection on `!build.lib`, so nothing is generated and the dist carries a bare `import()` for the consumer's bundler to analyse and preload properly. Library mode was previously impossible because it base64-inlines every asset regardless of `assetsInlineLimit`, and the engine bundled four MSDF atlas PNGs; with the fonts gone there is nothing left to inline and the objection with it.

  Being on the library side of that switch also stops Vite substituting `process.env.NODE_ENV`, which would otherwise bake the publishing machine's build mode into every consumer's bundle.

  No API change, and the fallback still loads on demand as its own chunk. `@mvpaint/ttf` was never affected: it has used library mode all along.

## 0.2.2

### Patch Changes

- ecc6967: Publish registry metadata that matches the tarball. 0.2.1 shipped a correct tarball — the `development` export condition was stripped from the packaged `package.json`, so installs resolve to `dist/` — but the metadata npm recorded for it still advertised the condition, because npm builds that metadata from the manifest it reads before `prepack` runs. The strip now happens before `changeset publish` starts, so `npm view @mvpaint/engine exports` agrees with what actually installs.

  The published manifest also no longer carries the repo's internal `prepublishOnly` guard, which referenced a path outside the package.

## 0.2.1

### Patch Changes

- 7b9ac82: Strip the `development` export condition from the published manifest. The condition points at `src/`, which is not part of the tarball, so any consumer whose bundler matched it — Vite matches `development` in dev mode by default — failed with "Failed to resolve entry for package". The condition still drives src-resolution inside the monorepo; `prepack` now removes it from the manifest that lands in the tarball and `postpack` restores the original file.

## 0.2.0

### Minor Changes

- d41382d: Fonts are the application's, and the atlas the engine ships is now only a fallback.

  **MSDF text.** `createSceneRenderer` takes a `fonts` option: an `MsdfAtlasSource` per style —
  the generated metrics JSON plus a URL for its PNG — which `FontBook.load` and `GlFontBook.load`
  now accept as an argument rather than reading a hardwired module. Omit it and you get the Inter
  atlas this package ships, exactly as before, so `Text` still draws with no setup. A supplied set
  may be partial: a style's `STYLE_ORDER` index is its texture array layer, unnamed layers stay
  empty, and the style ladder falls through to whatever is loaded.

  Atlases can also be replaced **after** the renderer exists, so fonts hosted on a CDN need not be
  in hand before the canvas is: `handle.setFonts(sources)` swaps them, `handle.getFonts()` reads
  back what is loaded. Every cached text layout is re-shaped against the new metrics and the text
  lane repacks; pipelines are untouched. It replaces rather than merges — spread `getFonts()` to
  add a style — and a failed fetch rejects with the previous atlases left in place.

  **Multiple font families.** `handle.setFonts(sources, 'roboto')` loads a second typeface
  alongside the default, and `new Text({ fontFamily: 'roboto' })` draws with it — so two `Text`
  nodes in one scene can be different faces. Family is a node-level property, not a per-run one;
  mixing families inside a single node is not supported. A name that is not loaded resolves to the
  default family rather than failing, so a node built while its atlas is still being fetched draws
  now and switches over when it lands.

  Each family is one array texture, so the text lane emits one draw per family _change_ along the
  packed order — a scene in a single family is exactly as cheap as before, and a paragraph mixing
  four styles is still one draw. Changing one node's `fontFamily` re-shapes that node alone.

  `VectorText` already took its outlines per node; its `fonts` is now settable for the same reason.

  Two internal signatures changed with it: the gather, picking, culling and marquee helpers take a
  `FontFamilies` (resolve a family name to a `FontProvider`) where they took a bare `FontProvider`,
  and `MarqueeOptions.fontBook` is now `fonts`.

  `resolveStyle` no longer assumes `regular` is present. Given a set without it, it resolves to the
  first style that is loaded and flags the difference as faux bold/italic, instead of handing back
  an undefined its caller dereferences.

  `msdfFontProvider(styles?)` takes the same styles, so text can be measured against the atlases it
  will actually be rendered with. Called with no argument it still measures against the fallback.

  **Vector text.** The four Inter polygon atlases and `loadDefaultVectorFonts()` are gone from the
  package. `VectorText` has always taken its outlines through the `VectorFonts` interface, and that
  is now the only way they arrive: a `PolygonFontBook` over atlases you ship, or `@mvpaint/ttf` for
  a font not known until runtime. `PolygonFont`, `PolygonFontBook` and the rest of the reader stay
  exported from `@mvpaint/engine/core` — only the data has left, dropping about 200 kB of outlines
  from `dist/assets` for every application, including those that never draw vector text.

  **Migrating.** Replace `loadDefaultVectorFonts()` with a loader over your own atlases; generate
  them with `packages/scripts` in the repository, which enumerates a folder of font files and
  writes both kinds. `packages/example-app/src/fonts/index.ts` is a working example of both halves.
