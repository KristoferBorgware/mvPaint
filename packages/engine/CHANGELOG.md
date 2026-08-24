# @mvpaint/engine

## 3.0.0

### Major Changes

- cb79d34: **Breaking.** The SVG loader reads what a document says — its stylesheet, its coordinate system,
  its references — and reports what it could not read. Two attribute-surface defects are fixed with
  it.

  ### `loadSvgDocument` returns the document, not just its nodes

  ```ts
  const doc = loadSvgDocument(text, { fit: { width: 120, height: 120 } });
  scene.root.addChild(doc.root);

  doc.viewBox; // {x, y, width, height}, or the width/height box, or null
  doc.width; // as declared, in user units, or null
  doc.preserveAspectRatio; // as declared; 'xMidYMid meet' when absent
  doc.notes; // what the loader passed over
  ```

  The nodes are `doc.root`; everything else on the result is what a caller previously had to parse
  the markup a second time to find out. **Migration is `doc` → `doc.root` at the call site.**

  ### It resolves the CSS

  Rules in the document's `<style>` blocks are applied to the elements that match them, in the
  cascade's own order: a presentation attribute (`fill="red"`) is the **weakest** of the three
  levels, a rule from `<style>` beats it, and the element's inline `style="…"` beats both. Simple
  class, type, id and universal selectors, compounded and joined by descendant or child
  combinators, grouped with commas.

  A document that paints through classes — which is how an editor writes a shared palette — drew
  entirely in SVG's initial fill before this, and SVG's initial fill is **black**, so it was a
  solid silhouette rather than a gap.

  ### It reports what it did not understand

  ```ts
  doc.notes; // [{kind: 'unsupported-element', detail: 'text', count: 2}, …]
  ```

  `unsupported-element`, `unsupported-property`, `unsupported-selector` and
  `unresolved-reference`, each counted. A group that is missing things is otherwise
  indistinguishable from a group that was always going to look like that, so an unread construct
  surfaced weeks later as "that icon is the wrong colour". An application can log it; a test can
  assert it is empty for an asset library it ships.

  ### A fit, on the group rather than in the points

  `fit` maps the document's `viewBox` onto a box of the given size, honouring
  `preserveAspectRatio` — including `none`, which stretches. It lands on the returned group's own
  `x`/`y`/`scaleX`/`scaleY`, so resizing a loaded document is a scale write rather than a re-parse
  that re-flattens every curve. `rootMatrix` stays as the escape hatch for a caller placing the
  document itself, and is still baked into the points.

  ### `<use>`, `<symbol>`, nested `<svg>`, and one branch of a `<switch>`

  `<use>` draws what it points at, wherever the definition sits, placed by `x`/`y`; a `<symbol>`
  or `<svg>` target maps its own `viewBox` onto the size the `use` asks for. A reference to a
  missing id, or one that leads back to its own ancestor, is reported rather than followed.

  A `<switch>` renders the **first** branch whose conditions pass, where every branch used to
  render. `systemLanguage` is matched against the `systemLanguage` option (default `'en'`) on the
  primary subtag.

  A gradient may also name another with `href`/`xlink:href`, taking its stops and every attribute
  it does not declare itself. An editor writes a palette that way — one gradient holds the colours
  and a dozen name it while placing themselves — and each of the dozen resolved to no paint at all
  before, so the shapes using them drew nothing. The engine's own Tux example is 26 of them.

  ### `fill-rule`, and a `Path` that fills by winding

  `fill-rule` is carried through to the shape, and **`Path.fillRule` defaults to `'nonzero'`, as
  SVG does** — where the fill grouping was even-odd containment however the document was written.

  The two rules agree on a shape whose holes are wound against their outers, which is what an
  editor emits. They differ on rings wound the same way — nested is solid under nonzero and a hole
  under even-odd — and on a ring that crosses itself, which even-odd nesting handed to a
  triangulator that requires a simple polygon. `new Path({d, fillRule: 'evenodd'})` asks for the
  old reading; a document that means it says so.

  ### **BUG:** an unclosed subpath is filled

  `z` says the OUTLINE joins up. SVG closes an open subpath implicitly when it FILLS one (1.1
  §11.4), and `ShapeContext.fill()` already read it that way, so the two ways into a `Path`
  disagreed and the SVG side dropped the region entirely. Twemoji draws a face as one unclosed
  arc: a fifth of that set drew its eyes and blush over nothing.

  An open contour of three or more points now fills as if it were closed. The stroke is unchanged —
  it is drawn as it was written, and only the fill auto-closes.

  ### `stroke-dasharray`, `stroke-dashoffset` and `display: none`

  The dash reaches `Path.dash`, scaled with the geometry. An element with `display: none` is not
  drawn, along with everything under it.

  ### A loaded document does not listen

  `loadSvgDocument` returns non-listening nodes. A drag walks up to the nearest enclosing `Group`
  and stops at the first one that is not draggable, so artwork dropped into a draggable object
  stood between the pointer and the object that owns it — the drag died while selection went on
  working, which reads as "drag is broken" and says nothing about the artwork. Pass
  `listening: true` where the paths themselves should be pickable.

  ### **BUG:** `setAttr` writes the property, and `getAttr` reads it

  `setAttr` preferred a `set<Key>()` method over the property of that name. A `set<Key>(value)`
  method is not always an attribute setter — `setText(text, style)` replaces a text node's RUNS —
  so on a uniform text node `setAttr('text', 'hello')` wrote one field while `getAttr('text')` read
  another: the value never landed, and no `textChange` fired, because the pair compared equal.

  The property wins wherever one can be written, which makes the two inverses by construction. A
  `set<Key>()` method is the fallback for a key with no writable property — `Text.runs` is a
  read-only property paired with `setRuns()` — and still behaves exactly as it did.

  ### A uniform text node declares its own attributes

  `text`, `fontSize`, `fontStyle`, `textDecoration` and `letterSpacing` are attributes: `attrs`
  enumerates them, `resetAttr` restores them, each announces its own `<key>Change`, and each is
  written to a document.

  `runs` is no longer among a uniform node's attributes, because on one it is derived — rebuilt
  from `text` and the style on every write. Writing it named the content twice, and a uniform text
  node refuses `runs` in its constructor, so such a document could not be read back at all.

  ### A `Transformer`'s colours are live

  `borderColor`, `anchorFill` and `anchorStroke` are attributes with setters, and take any form a
  colour can be written in:

  ```ts
  transformer.borderColor = "#3b82f6";
  transformer.anchorFill = theme.accent;
  ```

  Each reaches the parts that draw with it on the next frame, so an application that switches
  theme mid-session restyles its selection frame instead of rebuilding it. The frame also has an
  `attrDefaults()` table now, so every attribute it declares can be reset.

## 2.2.0

### Minor Changes

- 1a9976f: The canvas's clear colour is configurable, and changeable live.

  ```ts
  const handle = await createSceneRenderer("#board", {
    clearColor: "transparent",
  });

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

## 2.1.0

### Minor Changes

- 733de6c: Attributes can be animated. `node.to()` starts one immediately, and `Tween` is the same thing kept — playable, pausable, reversible, seekable.

  ```ts
  box.to({
    x: 400,
    rotation: 90,
    fill: "tomato",
    duration: 0.6,
    easing: Easings.BackEaseOut,
  });

  const pulse = new Tween({
    node: dot,
    duration: 0.8,
    yoyo: true,
    scaleX: 1.4,
    scaleY: 1.4,
  });
  pulse.play();
  ```

  Every key that is not a setting — `duration` (seconds, default 0.3), `easing`, `yoyo`, `ticker`, and the handlers `onPlay`/`onPause`/`onReverse`/`onSeek`/`onUpdate`/`onFinish`/`onReset` — is one of the node's own attributes. So whatever `getAttr`/`setAttr` reaches can be animated, and a shape that gains an attribute gains the ability to have it animated with nothing added: `x`, `rotation`, `opacity`, `strokeWidth`, `radius`, `dash`, `points`, the gradient geometry and its stops. A key the node does not declare throws when the tween is built rather than quietly animating nothing.

  ### What is new

  |                                                   |                                                                                                |
  | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
  | `Node.to(settings)`                               | fire and forget: plays at once, destroys itself at the finish                                  |
  | `Tween`                                           | `play` `pause` `reverse` `seek` `reset` `finish` `destroy`, plus `state`, `time`, `attributes` |
  | `Easings`                                         | `Linear`, and the In/Out/InOut forms of `Ease`, `Strong`, `Back`, `Elastic` and `Bounce`       |
  | `TweenTimeline`                                   | the clock and state machine on its own, for animating something that is not a node             |
  | `TweenTicker`, `tweenTicker`, `driveTweens`       | where the frame comes from                                                                     |
  | `TweenTarget`                                     | the seam a tween animates through — a name, `attributeNames()`, `getAttr`, `setAttr`           |
  | `Camera2D.to(settings)`                           | the camera's own `x`/`y`/`zoom`/`rotation`, animated like any attribute                        |
  | `cameraTween`, `viewForBounds`, `zoomCameraAbout` | animating the view rather than the fields                                                      |

  ### The camera

  `Camera2D` implements `TweenTarget`, so `camera.to({ x, y, zoom, duration })` works — its four fields, linear, like any other attribute. It also gains `attributeNames()`/`getAttr()`/`setAttr()` as prototype members, so a camera's own properties are still only its six view parameters.

  For a pan-and-zoom, say it as a view:

  ```ts
  const viewport = { width: canvas.clientWidth, height: canvas.clientHeight };
  cameraTween(camera, viewport, {
    center: { x: 400, y: 300 },
    zoom: 4,
    duration: 0.8,
  }).play();
  ```

  Three reasons, none about tweening. `x`/`y` are the view's top-left **corner**, so holding them still while the zoom changes slides the content sideways; `center` is what a caller means by where the camera is looking. `zoom` is a scale factor, so a straight line from 1 to 8 passes 4 after seven eighths of the animation — the view tween travels through its logarithm, so every moment magnifies by the same ratio, and the zoom cannot pass through zero under an overshooting curve.

  And the pan and the zoom are not independent. Screen-crossing speed is world-space speed times the zoom, so a centre travelling in a straight line through world space crosses the view at a rate that varies by the flight's whole zoom ratio — flying in eightfold, the pan is eight times faster at the end than at the start, which reads as the zoom happening first and the pan being tacked on after. `pan: 'screen'` (the default) places the centre from the zoom instead, so the two finish together as one movement; `pan: 'world'` is the straight line. No easing substitutes for either — one curve applied to both leaves their ratio exactly as it was.

  `viewForBounds(bounds, viewport, padding)` turns a world box — either `getClientRect()`'s rectangle or an `AABB` — into that centre and zoom, so "zoom to fit" composes with the tween instead of being a flag on it. `zoomCameraAbout(camera, viewport, x, y, zoom)` holds the world point under a viewport pixel for the whole flight, not only at the ends.

  Every view tween on one camera shares a target, so interrupting a flight halfway starts the new one from where the camera actually got to.

  ### The frame

  A played tween starts an animation frame loop that stops as soon as the last one does, so an application that only writes `node.to({ x: 100 })` never has to know the ticker exists. One that already has a frame can take it over, which puts the write and the draw that shows it in the same frame:

  ```ts
  const stop = driveTweens(handle);
  ```

  Milliseconds are supplied to a timeline rather than sampled from a clock inside it, so every tween in a scene shares one notion of _now_, and a test steps the ticker by hand and gets exactly the frame a browser would have drawn.

  ### What half way means

  `interpolate.ts` decides from the shape of the value. A colour mixes channel by channel in the engine's `[r, g, b, a]` tuple, and a fill animated to or from `null` — no fill at all — travels through its own colour at zero alpha rather than through black. A gradient carries its stops' offsets and colours, in either form they are written in. A `points` list of a different length is resampled by projecting the longer list onto the shorter one's outline, so the new points slide out of the shape they are joining.

  An attribute has one tween writing it: starting a second on the same attribute takes it from the first, which carries on with the rest of its own. Fading a shape out while a half-finished move is running leaves the move running.

## 2.0.0

### Major Changes

- 1720e61: **Breaking, in two directions at once. Every attribute now raises `'<key>Change'` from the
  property itself, and the event no longer bubbles.**

  It used to fire only from `setAttr()`, so `rect.x = 5` — which is how ported code and most
  examples write it — announced nothing at all, and a property inspector or an undo stack watching
  a scene simply missed most of what happened to it. And it used to bubble, so a watcher that
  registered its handler on several nodes of one chain recorded a single edit once per level.

  Both are fixed by moving the announcement to where the value is stored. `rect.x = 5` and
  `rect.setAttr('x', 5)` are now indistinguishable to a listener, and the event fires on the node
  that changed and nowhere else.

  **Watching a subtree is now a listener per node.** `'add'` still bubbles, so a watcher can attach
  one as each node joins. Delegation is no substitute and never was for a non-bubbling event: the
  wrapped handler runs when the event reaches the ancestor it was registered on, which for these is
  never.

  Every attribute that was a plain field is an accessor now — `id`, `name`, `visible`, `listening`,
  `preventDefault`, `draggable`, `dragDistance`, `dragBoundFunc`, `overlay`, the seven shadow
  fields, and `Image`'s ten. Each guards on the value actually differing first, so writing a node's
  own value back costs nothing.

  `fill`, `stroke`, `shadowColor`, `tint` and the gradient stop lists are compared on the form they
  were WRITTEN in rather than the tuple they parse to: one colour name written twice is one change,
  while a freshly built tuple is a new value even when its four numbers match. That is the identity
  rule the gradient points already followed.

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

- 1720e61: **Breaking. A node has one parent, and `addChild` enforces it.** Handing a container a node that
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

  |                          |                                                                                      |
  | ------------------------ | ------------------------------------------------------------------------------------ |
  | `add(...children): this` | variadic and chainable — `group.add(background, title)`                              |
  | `getChildren(filter?)`   | a COPY, safe to sort or keep, optionally narrowed                                    |
  | `hasChildren()`          | whether it holds anything                                                            |
  | `destroyChildren()`      | empties it and finishes with each child, where `removeChildren()` leaves them usable |

  `children` stays a read-only live view. A node's parent pointer and its place in a list are one
  fact stored twice, and splicing the array directly would leave the two disagreeing with nothing
  to notice; `getChildren()` is the copy to work on.

  **`Transformer.add(node)` is now `Transformer.addNode(node)`**, because `Container.add()` means
  something else and a Transformer is a Container. A frame's attached nodes are not its children —
  they are what it wraps, and they stay where they are in the scene. `attach`, `detach`, `toggle`,
  `has` and `clear` are unchanged.

- 2fc909a: **Breaking.** A point list is a shape, a document is an assembly, and a picture is its own size.

  ### `Polyline` takes the list in either form, and closes into a polygon

  ```ts
  new Polyline({ points: [0, 0, 10, 4] }); // flat, as well as [{x, y}, ...]
  new Polyline({ points: ring, closed: true, fill: "teal" }); // fills, and is clickable inside
  new Polyline({ points: through, tension: 1 }); // a spline through the points
  new Polyline({ points: controls, bezier: true }); // a start point and control triples
  ```

  |                    | was                          | is                                                |
  | ------------------ | ---------------------------- | ------------------------------------------------- |
  | `points`           | `Vector2Like[]`, required    | `Vector2Like[]` or flat `number[]`, optional      |
  | `closed`           | a contour flag; never filled | a polygon: fill triangles, and an interior to hit |
  | `tension`          | —                            | Catmull-Rom through the points, flattened         |
  | `bezier`           | —                            | the points read as cubic control points           |
  | `width` / `height` | `0` forever                  | the extent of the drawn outline                   |

  `points` reads back as objects whichever form it was written in, and holds the array it was given rather than a copy — so editing one in place still needs `markGeometryDirty()`.

  **A closed polyline now has an interior.** It tessellates fill triangles like every other closed shape here, so a click in the middle of one hits it where it previously fell through to whatever was behind. `fill` on a closed polyline paints for the first time; on an open one it still paints nothing, because there is nothing to fill.

  `outline()` is the drawn point list — the list itself for a straight polyline, the flattened curve when `tension` or `bezier` says otherwise. Everything measured from the shape measures that.

  ### `Path` carries its data

  `d` is an accessor. Assigning one re-flattens at the current `tolerance`, which is also an accessor; assigning `contours` drops the `d` they no longer describe.

  A path built from data is WRITTEN as that data. `toObject()` emits `d` and `tolerance` for one, `contours` for one given its points directly, and never both — the same outline twice in every document, read back in whichever order the two happened to be applied, is not a format.

  `width`/`height` measure the contour extent, as a Polyline's measure its points.

  ### Distance along an outline

  ```ts
  line.getLength(); // the drawn outline, closing segment included when closed
  line.getPointAtLength(120); // local-space point, clamped to the ends
  ```

  On `Polyline` and `Path`, over the flattened segments. The free functions behind them — `contourLength`, `contoursLength`, `pointAtLength` — are on `@mvpaint/engine/core`, so measuring a path needs no device.

  ### An `Image` follows its texture

  A size that was never given is the texture's own, and STAYS the texture's own: assigning a different `texture` resizes the quad, re-tessellates the silhouette and invalidates the picking cache. Previously the size was read once in the constructor, so swapping the picture sampled the new image into the old rectangle — stretched, with stale bounds, picking and shadow to match.

  Writing `width` or `height` pins that half; from then on the quad is that size whatever the texture says. A size that merely restates what the shape would measure anyway is not a pin, which is what lets a copy or a reloaded document go on following its texture as the original did. `Polyline` and `Path` size the same way.

  **An `Image` also carries no paint.** `fill`, `fillEnabled`, `fillPriority`, the nine gradient properties, `stroke`, `strokeEnabled`, `strokeWidth`, `hitStrokeWidth`, `dash`, `dashOffset`, `dashEnabled`, `strokeAlign`, `lineJoin`, `lineCap`, `miterLimit` and `strokeScaleEnabled` are gone from `ImageOptions` and from what `attributeNames()`, `attrs` and `toObject()` report. An `Image` goes to the image lane, which never reads a material, so all twenty-three were settable, reported, saved — and dead.

  ```ts
  new Image({ texture, fill: "red" }); // was accepted and did nothing; now a type error
  new Image({ texture, tint: "red" }); // the colour an Image actually has
  ```

  The shadow settings stay: the renderer does hand an `Image` to the shadow lane as a caster. Documents saved earlier still load — an attribute a class no longer lists is applied and ignored, as it always was.

  ### `loadSvgDocument` returns a `Group`

  It returned a `Container`, which is not a `TransformableNode`: a loaded document could not be attached to a `Transformer`, was not what a drag inside it moved, and was not what `outermostGroup()` returned from a click on any path in it. It is now a `Group`, and each `<g>` in the document is a nested `Group` — so `closestGroup()` steps inward from the whole drawing to the part that was clicked.

  **The children are no longer a flat list of `Path` nodes.** Code walking `doc.children` for paths should walk the subtree instead. Nested groups carry no transform: each element's CTM is still baked into its points.

  ### `Rect.cornerRadius`, unchanged and now written down

  Radii too large for the rectangle shrink by one common factor (the CSS rule) rather than clamping per corner. The two agree exactly for equal radii and differ only when the four are not the same — see the header on `Rect` for the worked case.

- f67fc8d: **Breaking.** Creating a renderer is about a canvas and a device. It no longer knows anything about fonts.

  `CreateSceneRendererOptions.fonts` is gone, and so are `handle.setMSDFFonts()` and `handle.getMSDFFonts()`. Atlases now arrive the way outlines always have — by being registered under a name:

  ```ts
  const handle = await createSceneRenderer(canvas); // first the renderer,
  await loadFontFamily("inter", { vector, msdf }); // then the fonts,
  buildScene(handle.scene); // then the scene
  ```

  `registerFontFamily` and `loadFontFamily` take either half or both, and replace only the halves they name — so a family can gain its atlases long after its outlines. Both return a promise: the outlines are in place synchronously, and awaiting it means every device drawing at the time has its texture uploaded.

  ### How an atlas gets to a device without the renderer being told

  The registry holds atlas SOURCES — metrics and a URL, plain data. A renderer subscribes when it is created (`onFontFamilyRegistered`), catches up on `registeredMsdfFamilies()`, and unsubscribes when it is destroyed. So the two orders both work: a family registered before a device existed is uploaded when the renderer is created, and one registered afterwards arrives through the subscription. Two canvases each build their own texture from the one registration.

  ### Migrating

  | was                                      | is                                                                             |
  | ---------------------------------------- | ------------------------------------------------------------------------------ |
  | `createSceneRenderer(canvas, { fonts })` | `createSceneRenderer(canvas)` then `registerFontFamily(name, { msdf: fonts })` |
  | `handle.setMSDFFonts(sources)`           | `registerFontFamily(DEFAULT_FONT_FAMILY, { msdf: sources })`                   |
  | `handle.setMSDFFonts(sources, 'roboto')` | `registerFontFamily('roboto', { msdf: sources })`                              |
  | `handle.getMSDFFonts(family)`            | `msdfSourcesFor(family)`                                                       |

  `handle.msdfFonts` is unchanged — it is what shaping and measuring read, and it still belongs to the renderer, because a book holds a texture.

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

- 1b7affe: **Breaking.** Every attribute a node carries is declared once, on `Node`.

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
  and a group's extent comes from `group.bounds()`, measured on demand from what it holds. A
  container's `width` and `height` therefore stay at `0` unless something assigns them, and the
  value means nothing to the renderer when it does.

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
  one; the dispatcher maps the result back through the parent. `preventDefault` is read off the
  node under the pointer; the canvas's own gestures — a transformer handle, a middle-button pan, a
  pinch, the wheel, the context menu — suppress the browser default whatever it says, since no
  node is their subject.

  ### Not implemented, and why

  Three attributes a 2D scene graph might be expected to carry are deliberately absent rather than
  present as fields nothing consults, each for a reason about this renderer rather than about the
  attribute:

  - **`globalCompositeOperation`** — a canvas 2D blend mode. Here it needs a render pipeline per
    mode and a repack of the draw list by mode.
  - **`transformsEnabled`** — names an optimisation `Node.localMatrix()` already performs
    unconditionally: rotation, skew and scale are each skipped when they are the identity.
  - **`filters`** — a filter runs over a cached raster, and there is no cache-to-texture layer.
    (`Image.filter`, the texture sampling mode, is unrelated.)

  `shapes/nodeAttributes.test.ts` holds the whole attribute set as data and pins all three claims —
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
  - `SceneResources` carries `fonts: MSDFFontFamilies` — the provider an `MSDFText` is measured against, which scene-building code previously had no way to reach. Anything constructing a `SceneResources` by hand supplies it; `handle.fonts` is where it comes from.
  - `Shape.strokeWidth` is an accessor rather than a plain field, so a subclass can hear the assignment. It stores and nothing more; changing it still needs `markGeometryDirty()`.

- 1720e61: **Breaking. `Shape.pickable` is gone; `listening` is the single switch on whether the pointer can
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

  Picking runs against the same triangles the mesh lane draws, so a shape is hit across its whole area whether or not it paints any of it. An outlined rectangle is picked in its middle, not only on its edge.

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

  A positive `rotation` turns a shape CLOCKWISE on screen. The rotation matrix is unchanged; a y-down frame is what reverses how it reads. Combined with degrees (see the angles changeset), `rotation: 45` means the same thing here as in Canvas2D and SVG.

  `Camera2D.rotation` follows the same sense: positive turns the view clockwise, so its content appears to swing the other way.

  ### What is NOT affected

  Triangle winding. Every pipeline sets `cullMode: 'none'`, so nothing decides whether to draw from it. The two places that read winding to decide GEOMETRY — which side a stroke expands onto (`strokeAlign`), and which ring of a contour set is a hole — take the ring's shoelace sign and its edge normals together, and a reflection reverses both, so they cancel. `orientation.test.ts` proves this directly by stroking a shape and its mirror image and comparing.

  `loadSvgDocument` gets simpler: SVG is y-down and so is the scene, so the `rootMatrix` no longer wants a `[1,0,0,-1,0,0]` flip. If you were passing one to correct the old mismatch, remove it.

  ### Verifying a port

  `packages/engine/src/orientation.test.ts` is the convention written out as assertions — where each shape's geometry sits, which way the camera extends, which side the transformer's top is on, and the two mirror invariants. It is the file to read when something lands upside down.

- c7cc0b8: **Breaking.** `Transformer` owns the policy its handle gestures run under, and gains the two callbacks that let an application constrain them.

  `SceneInputDispatcher` still runs the gesture, but reads `keepRatio`, `flipEnabled`, `centeredScaling`, the rotation snaps and both bound functions off the frame rather than holding its own. An application configures one object.

  ### Shift asks for the aspect lock, it no longer inverts it

  `keepRatio` and shift combine as `keepRatio || shiftKey`. Holding shift on a corner forces proportional scaling; with `keepRatio` already `true` — the default — it changes nothing.

  It was an XOR, so on a default-configured frame the one gesture every user knows released the lock instead of applying it. An application relying on shift to unlock a corner should set `keepRatio: false` and let shift ask for the lock.

  ### `enabledAnchors` is live, and honest

  It was `readonly` at the type level but writable through `setAttr`'s fallthrough, while the anchors themselves were built once in the constructor. A name added later was grabbable but invisible; one removed left a drawn handle that could not be grabbed.

  It is a real setter now. Every handle is built up front and switched on by being given a size back, so what is drawn and what `anchorAt()` finds always come from one list.

  ### The frame's own transform no longer reaches its parts

  The frame places its parts in **world** coordinates while being a `Container` itself, so anything written to its transform was applied to them a second time — a `rotation` swung the whole frame away from the nodes about the scene origin, and the drawn handles stopped matching the grabbable ones.

  `Transformer.localMatrix()` is identity. The inherited transform fields are inert, and `rotation` means the angle of the **frame**, in degrees: what a rotate drag turns, and what the per-frame refit measures the nodes along. `Transformer.fitRotation()` is the same angle in radians, and `boxForNodes`' new third argument.

  ### A frame around several nodes can be framed upright

  A frame around ONE node takes that node's angle, always. `useFirstNodeRotation` (default `true`) decides what a frame around SEVERAL does: borrow the first member's angle, as before, or — set `false` — hold an upright angle of its own that rotate drags carry forward and that reordering the set does not disturb.

  ### Rotation snaps live on the frame

  `rotationSnaps` and `rotationSnapTolerance` (degrees, default `7`) are `Transformer` attributes. `SceneInputDispatcher`'s options of the same name are read only when it is built without a transformer; `attachSceneInput` passes its top-level `rotationSnaps` through to the frame.

  ### Events reach the frame as well as the nodes

  `transformstart` / `transform` / `transformend` and `dragstart` / `dragmove` / `dragend` fire on the `Transformer` as well as on each node taking part — where an application watching "the selection" rather than a particular shape puts its handler. Each event carries `nodes`, the whole set, and `evt`, the pointer event that drove it.

  A drag reaches the frame when what is being dragged is what the frame wraps.

  ### New

  |                                                            |                                                                                                                                                                                                                                                                         |
  | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `boundBoxFunc(oldBox, newBox)`                             | Constrains the box a resize or rotation lands on. Boxes are `{x, y, width, height, rotation}` in world space — `x`/`y` the turned top-left corner, `rotation` in radians, `width`/`height` signed so a mirrored box reports a negative one. Consulted on rotations too. |
  | `anchorDragBoundFunc(oldPos, newPos, event)`               | Constrains where a handle drag is read from, in world space — the seam snapping belongs in. `oldPos` is where the drag began, since gestures here resolve against their start and never accumulate.                                                                     |
  | `flipEnabled` (default `true`)                             | `false` holds a resize just clear of zero instead of letting a drag past the fixed point mirror the nodes.                                                                                                                                                              |
  | `centeredScaling` (default `false`)                        | Scales about the box centre, which alt asks for on its own for one gesture.                                                                                                                                                                                             |
  | `resizeEnabled` (default `true`)                           | `false` leaves the border and the rotate handle.                                                                                                                                                                                                                        |
  | `useFirstNodeRotation` (default `true`)                    | `false` frames a set of nodes upright rather than along the first member's angle.                                                                                                                                                                                       |
  | `getActiveAnchor()`, `isTransforming()`, `stopTransform()` | Which handle a gesture holds, whether one is running, and ending it where it stands.                                                                                                                                                                                    |
  | `nodes` as a setter                                        | `transformer.nodes = [a, b]` replaces the set, the same as `attach()`.                                                                                                                                                                                                  |
  | `detach()` with no argument                                | Empties the set. `detach(node)` still drops one. Called bare it used to return silently.                                                                                                                                                                                |

  `anchorSize`, `rotateAnchorOffset`, `padding`, `borderWidth`, `anchorBorderWidth`, `enabledAnchors`, `rotateEnabled` and `keepRatio` are writable.

  Handles show their cursor on **hover**, not only once pressed, and it turns with the box — a corner of a box at 90° offers `nesw-resize`. The rotate handle offers an open hand before the drag and a closed one during it.

  ### Under it

  Every handle gesture reduces to two boxes — the one the press started on and the one the pointer asks for — and `deltaBetweenBoxes` turns the pair into the single world delta each node receives. That is the seam `boundBoxFunc` sits in: whatever box it hands back, however little it resembles what the pointer asked for, is expressible as a delta.

  New in `transformerMath`: `BoundBox`, `BoundBoxFunc`, `AnchorDragBoundFunc`, `boxToBoundBox`, `boundBoxToBox`, `resizedBox`, `deltaBetweenBoxes`, `anchorCursor`. `OrientedBox` half-extents are signed, so a mirrored box reports a negative one.

### Minor Changes

- d90130e: **A text node measures the block it was laid out in, so `padding` is an extent.**

  `padding` is blank space inside the block: the glyphs move in from the node's origin and the reported width and height each grow by twice it. What a node MEASURED was the union of its glyph quads, and blank space has no quad in it - so a padded label reported the same box as an unpadded one, moved. A plate sized from `getTextWidth()` had the padding; the node's own bounds, the frame a transformer fitted around it, and the extent it contributed to its group did not.

  ```ts
  const label = new VectorText({
    padding: 24,
    runs: [{ text: "Hi", style: { fontSize: 40 } }],
  });
  label.shaped(); // 87.4 x 96.4  - the block, and always did
  label.getClientRect(); // was 33.5 x 30.1 at (27.5, 32.7); now 87.4 x 96.4 at (0, 0)
  ```

  `ShapedText` gains `blockX`/`blockY`, the block's top-left corner, which `width` and `height` measure from - zero on both axes for horizontal text, `-width` on x for vertical text, and wherever the curve put it for text bent onto a path. `blockRect()` reads them. `textLocalBounds()` unions that rectangle with the quads, and `VectorText.localBounds()` unions it with the glyph geometry.

  Both, because neither contains the other: the block reaches past the glyphs wherever the line box is taller than the letters in it, and the quads reach past the block wherever something overhangs - a glow, an italic's overshoot, a run bent onto a curve.

  Two things deliberately unchanged. Empty text still has no bounds at all rather than a zero-sized box at its origin, so it adds nothing to the group holding it. And a `VectorText` is still hit per glyph rather than per box - that is what its outline geometry is for - so a click in its padding falls through it, where the same click on an `MSDFText`, which is hit against its box, now lands.

  `ARCHITECTURE.md` and `TextLayoutOptions.padding` both already described this behaviour. The code now does it.

- 92e4e2e: **The uniform text nodes have usable type declarations.**

  `withSingleRun()` returned an inferred class-expression type. A declaration file cannot write down a type that has no name, so the build emitted 720 errors — 702 `TS4094`, 12 `TS4020`, 6 `TS4058` — and produced `.d.ts` files for `withSingleRun`, `UniformMSDFText` and `UniformVectorText` that described none of the three. The plugin never treated them as fatal, so the build exited 0 with the damage in the output.

  The mixin now declares what it adds:

  ```ts
  export interface SingleRunText {
    text: string;
    fontSize: number;
    fontStyle: string;
    textDecoration: string;
    letterSpacing: number;
    measureWith(text: string, fonts: FontProvider): TextSize;
  }

  export function withSingleRun<T extends TextClass>(
    Base: T
  ): T & (abstract new (...args: any[]) => SingleRunText);
  ```

  The build is clean, and a consumer reading the published types now sees `text`, `fontSize`, `fontStyle`, `textDecoration`, `letterSpacing` and `measureSize` on both uniform nodes alongside everything they inherit.

  Two things moved to make that possible. `measureWith` is public rather than protected, since an interface has no protected members — `measureSize` on each node is still the one to call. `runStyle` stays protected and is now genuinely private to the mixin: it is absent from the declared type, so a subclass written outside this package cannot reach it. Nothing inside the engine did.

- 1720e61: **A scene can be saved, loaded and copied** — `toObject`, `fromObject` and `clone`, in a
  `serialize/` module of their own.

  ```ts
  const document = toObject(scene.root); // plain data, JSON.stringify-able
  const restored = fromObject(document); // a live subtree again
  const copy = clone(node); // a second node in the running scene
  ```

  **Deliberately not on `Node`.** A node's job is to be part of a picture; a document format has
  its own versioning, its own decisions about what a texture becomes on disk, and its own reasons
  to change. Keeping it out here means a scene graph carries no opinion about how it is stored, and
  an application with its own format can ignore all of this and walk `attributeNames()` itself.

  A snapshot is a class name, the attributes that differ from that class's defaults, and the
  children. Defaults are left out because a document is read by people as well as by programs — and
  because a class that gains an attribute then reads old documents unchanged, the missing key being
  the default it would have had.

  `registerNodeType(name, TheClass)` is how an application's own `CustomShape` subclass round-trips
  through the same reader. The engine's classes register themselves. An unregistered name throws
  by name rather than dropping the node: a document that half-loads is worse than one that says
  what is missing.

  **What does not fit in JSON is reported rather than mangled.** A texture is a GPU object and a
  `dragBoundFunc` is a function, so `replace`/`revive` are how an application says what stands in
  for them — a texture as the URL it came from, most obviously — and `onSkipped` names anything
  that went out without a stand-in.

  `clone()` deliberately does not go through JSON. It copies attributes live, so two `Image`s from
  one clone draw the same texture and the texture is loaded once. Listeners are NOT copied: a
  handler is written for the node it was registered on and usually closes over it.

  **Loading winds the stacking counter forward** past every `zIndex` it reads (`reserveZIndex()` in
  `zOrder.ts`). A saved drawing carries absolute values from the session that made it, and without
  this the first shape drawn after a load would take a number from near zero and land underneath
  the drawing it was meant to go on top of.

- 1720e61: **Lines can be dashed.** `dash`, `dashOffset` and `dashEnabled` on every shape that strokes.

  ```ts
  new Rect({
    width: 200,
    height: 120,
    stroke: "black",
    strokeWidth: 2,
    dash: [10, 6],
  });
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

- 1720e61: **`node.attrs` is a live, writable view instead of a snapshot.** `node.attrs.x = 5` moves the
  node.

  It was a fresh plain object rebuilt on every read, so a write into it went into a throwaway and
  was lost without a word — and reading `attrs` twice gave two objects that immediately began
  drifting from the node and from each other.

  Reads and writes now go straight through `getAttr()`/`setAttr()`, so there is no copy to fall out
  of step and no write that lands somewhere the node cannot see. It still enumerates like an
  object: `Object.keys(node.attrs)`, `'x' in node.attrs` and spreading all behave as before.

  **Deleting an attribute restores its default.** `delete node.attrs.x`, or `node.resetAttr('x')`
  by name. Assigning `undefined` assigns undefined — `dragDistance` means something by it — so
  deleting is how to ask for the default instead.

  Each class declares its defaults in `attrDefaults()` alongside its `attrKeys()`, and a test
  checks the two lists against each other, since a key in one and not the other is a hole nothing
  else would report. Two attributes have no default and say so rather than inventing one:
  `Image.texture`, which has no blank picture to stand in for it, and a `Shape`'s `zIndex`, which
  comes from a running counter — resetting it is `shape.zIndex = nextZIndex()`.

  `attributeNames()` and `attributeDefaults()` are the public face of the two manifests, for a
  serializer or a property inspector walking them from outside the class hierarchy.

- 221d126: **Assigning geometry now reaches the screen.** Every property `buildGeometry()` reads calls
  `markGeometryDirty()` for you.

  A transform, a colour and a gradient parameter have always been free and always worked, because
  they live in a per-object record rewritten every frame. Geometry is packed into shared vertex
  buffers instead, and the properties that feed it were plain fields — so `rect.width = 200` stored
  a number and nothing else. The shape kept its old triangles until something unrelated forced a
  rebuild. `width` and `height` are the sharpest case, being the most ordinary-looking properties
  on the object, and the ones a property inspector or a deserializer writes through `setAttr()`.

  |               |                                                                                         |
  | ------------- | --------------------------------------------------------------------------------------- |
  | `Shape`       | `strokeWidth`, `strokeAlign`, `lineJoin`, `lineCap`, `miterLimit`, `strokeScaleEnabled` |
  | `Rect`        | `width`, `height`, `cornerRadius`, `cornerSegments`                                     |
  | `Circle`      | `radius`, `segments`, and `width`/`height`, which are the radius under another name     |
  | `Polyline`    | `points`, `closed`                                                                      |
  | `Path`        | `filled`                                                                                |
  | `Image`       | `width`, `height`                                                                       |
  | `CustomShape` | `tolerance`                                                                             |

  Each guards on the value actually differing, so writing a node's own value back — which a slider
  bound to a property does on every frame it is dragged — costs nothing.

  `stroke` gained the second half of its contract. A colour swapped for another colour stays a
  record rewrite; gaining or losing a colour changes whether the stroker emits a ribbon at all, so
  `null` on either side of the assignment re-tessellates as well.

  **`markGeometryDirty()` is unchanged and still needed twice**: after editing an array in place
  (`points.push(p)` rather than assigning a new list — there is no assignment to intercept), and
  after changing a property of your own `CustomShape` that its `describe()` reads. `Path.contours`
  stays `readonly`; a path's outline is fixed at construction.

  Calling `markGeometryDirty()` where you already do stays correct — it is idempotent within a
  frame, and the epoch it bumps is compared once per frame rather than per node.

- 1720e61: **Assigning what an image shows, or how text is laid out, now reaches the screen.**

  Two more places where a value was stored and nothing drew it.

  **The image lane had no content epoch.** `image.crop`, `fit`, `tileX`/`tileY`, `flipX`/`flipY`,
  `wrapX`/`wrapY`, `filter` and `texture` are read only when the lane packs its buffer, so
  assigning one changed nothing until something unrelated forced a rebuild —
  `handle.markImageGeometryDirty()` by hand was the only way through. They are guarded accessors
  now, over a counter of the lane's own.

  Resizing an `Image` invalidates BOTH lanes, which is the thing worth knowing about the class: its
  quad is tessellated like any mesh shape — that is what gives it a hit test, bounds and a shadow
  silhouette — while the pixels come from a buffer the image lane packs itself.

  `tint` deliberately announces nothing: the batcher re-reads it every frame alongside the
  transform and the depth, so it was already free and stays free to animate.

  `handle.markImageGeometryDirty()` remains as an escape hatch for the one thing none of this can
  see — a texture whose _pixels_ were rewritten in place under the same object.

  **A text node's layout options did not re-shape.** `align`, `maxWidth`, `lineHeight`,
  `direction`, `orientation`, `padding` and `textPath` are accessors now and re-shape on
  assignment. `markDirty()` stays for what an assignment cannot see: a `textPath` object edited
  rather than replaced, or a run's style rewritten through the array.

  **`Path.contours` half-worked and now works.** It was `readonly`, which TypeScript erases, so
  `setAttr('contours', …)` overwrote it at runtime while the contour grouping the fill is
  triangulated from stayed as it was — leaving a fill built from one outline and a stroke drawn
  along another — and nothing re-tessellated at all. It is a real setter now, regrouping and
  invalidating.

- 1720e61: **`node.getClientRect()` measures any node, and `getAllIntersections()` returns the whole column
  under a point.**

  ```ts
  node.getClientRect(); // where it sits in its parent
  node.getClientRect({ relativeTo: scene.root }); // where it sits in the scene
  node.getClientRect({ skipTransform: true }); // how big it is, wherever it is
  ```

  One measurement that works on a shape, a group, a layer or a bare container — the thing to reach
  for when aligning, snapping, fitting a view or exporting with margins. A shape measures its own
  triangles; a container the union of its children carried up through their local matrices; an
  empty container the empty box. `skipTransform`, `skipStroke`, `skipShadow` and `relativeTo` are
  the flags. It replaces nothing: `Shape.localBounds()` and `Group.bounds()`/`worldBounds()` stay
  as they are, and this is one call over all of them.

  **The shadow is IN the box**, unlike every other measurement in the engine. A box that cropped
  the shadow would be wrong for what this is usually for — an export with padding that cuts the
  shadow off is exactly the bug. `skipShadow: true` takes it back out.

  `getAllIntersections(scene, x, y, fonts?)` is `pickNode()` without the early return, and
  `handle.pickAll(screenX, screenY)` is the same through the renderer. A click means one node,
  which is what `pick` answers; cycling through stacked shapes on repeated clicks in one place, or
  alt-clicking for the thing underneath, needs the column.

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
  | `fontSize`                 | default **12**, not the 32 a `Text` starts at                                                         |
  | `fill`                     | the glyphs' colour — opaque black unless the constructor was told otherwise                           |
  | `stroke` / `strokeWidth`   | the per-letter outline; a width with no colour draws nothing                                          |
  | `fontStyle`                | `'normal'` / `'bold'` / `'italic'` / the last two together, in either order and with either separator |
  | `textDecoration`           | `'underline'`, `'line-through'`, or both                                                              |
  | `letterSpacing`, `padding` | as written                                                                                            |

  Writing any of them rebuilds the run and re-shapes, so this is a live surface and not a constructor convenience. An unrecognised `fontStyle` or `textDecoration` throws at the assignment rather than silently drawing the plain face.

  **These two classes paint by default**, which nothing else in the engine does. Text that renders invisibly is a worse default than text that renders in black, and it is the one place the deviation earns itself. `fill: null` still means paint nothing.

  `lineHeight` keeps the engine's meaning — a multiplier over the font's ascent plus descent, not over `fontSize`.

  ### Measuring

  ```ts
  label.getTextWidth(handle.msdfFonts.resolveFamily(label.fontFamily));
  label.measureSize("a string it is not currently drawing", fonts);
  ```

  An MSDF node cannot measure itself: its glyphs live in atlases the renderer owns. `SceneResources.msdfFonts` is where the provider comes from, and a scene builder now has it. `UniformVectorText` needs nothing passed in — its outlines are on the node.

  ### `padding`, on every text node

  `TextLayoutOptions` and `Text` gained `padding`: blank space inside the block, in world px. It moves the text and grows the block, so everything measured from the block — bounds, hit-testing, a plate drawn behind it — sees it. Wrapping is unaffected: `maxWidth` is the width the text wraps at, so a padded block that wraps is `maxWidth + 2 × padding` across. Horizontal, vertical and path layouts all honour it.

  ### Not implemented, and what each would take

  `fontVariant` (small-caps needs a second set of glyphs or a synthesis pass), `underlineOffset` and `charRenderFunc` (both reach below the shaper into how a glyph is placed), `wrap: 'char'` (the line breaker splits on words and spaces only), and `ellipsis` and `verticalAlign` (both need the shaper to know a fixed block height and truncate against it). There is no `wrap` attribute — wrapping is `maxWidth`, inherited from `Text`.

  Reach for `MSDFText` or `VectorText` when one string has to carry more than one style. Passing `runs` or `style` to a uniform node throws and says so.

- 1720e61: **`fillEnabled`, `strokeEnabled` and `hitStrokeWidth`.**

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
  new Polyline({ points, stroke: "black", strokeWidth: 1, hitStrokeWidth: 24 });
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

  It substitutes rather than adds, so a hit width _below_ the drawn width makes a shape harder to
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

### Patch Changes

- d90130e: **Vector text draws the letters its font describes.**

  A font builds a letter out of overlapping pieces wound the same way, and resolves them with the nonzero winding rule: the bar of a `t` is a rectangle laid across the stem, the two strokes of a `w` cross at the bottom of each V, the arch of an `n` runs into its stem. The glyph fill went through the even-odd NESTING test instead, which reads a piece laid over another as a hole and hands a self-crossing ring to a triangulator that requires a simple polygon.

  On Inter, 23 of 188 glyphs were drawn wrong over more than 1% of their area, and 60 were wrong somewhere. `t` and `f` lost their bars and drew as `l` and a bare stem; `w`, `M`, `N`, `A`, `V`, `X` and `&` filled across their valleys; `$ + ^ { } ¢ £ ¤ ¥ ± ¶ Ç × Þ ç Ð` lost a piece each.

  `render/nonzero.ts` reads the outline the way it was drawn.

  **`unionBoundary` is the silhouette.** Every edge is cut at each crossing and at each point another edge touches it, and each piece is then asked whether the winding number is zero on exactly one side of it. A piece with material on both sides is a join between two pieces of scaffolding and goes; what survives is chained back into closed rings. A glyph's `contours` are now that silhouette, which is what fixes the per-letter outline: stroking the pieces drew the bar of a `t` as a rectangle running through the stem and put a line out of the side of an `e`'s bowl.

  **`simpleLoops` and `windingGroups` fill it.** The first cuts a ring at its self-crossings so every piece reaching earcut is a simple polygon; the second decides solid from hole by DIRECTION rather than by nesting. The fill is cut from the same silhouette the outline follows, so the two cannot disagree.

  Nothing else changes. MSDF text samples an atlas and was never affected, and the atlas files are unchanged — the outlines in them were always right, and only the reading of them was wrong.

  Two tests measure the fix rather than describing it, both over every glyph in the committed atlas: one samples a grid and compares "inside a fill triangle" against the winding number of the original rings, the other walks every stretch of every silhouette and checks that material lies on exactly one side of it. Both pass everywhere.

  Building all 188 glyphs of a face costs about 30 ms, once, lazily, cached per glyph.

- 1b7affe: Two places in `input/` where a name or a direction still read as though `+y` were upward.

  **Arrow-key panning.** ArrowUp moved the view down and ArrowDown moved it up. `Camera2D.y` is
  the top edge of what is on screen, so moving the view up is a smaller `y`; the four arrows now
  agree with each other and each moves the view the way it points.

  **The marquee's edges.** `MarqueeOverlay` placed its `'top'` bar at the larger `y`, which is the
  bottom of the box. The rectangle is symmetric so no pixel moves, but `edges.get('top')` is the
  top edge now, matching the anchor names in `shapes/transformerMath.ts`.

- 1720e61: **`MSDFText` and `VectorText` now say, once, when a `fill` or `stroke` assigned to them goes
  nowhere.**

  Glyph colour is a property of a RUN, so a node holding several independently styled runs has no
  one fill and `Shape.fill` is not read by either text path — `text.fill = 'red'` assigned a field
  nothing drew from, and the text stayed whatever colour its runs said. Invisible or unchanged text
  with a fill set on it looks like a font that failed to load, which is a long way from the actual
  cause.

  The warning names `UniformMSDFText`/`UniformVectorText`, which carry exactly one run and whose
  `fill`, `stroke` and `strokeWidth` do reach the glyphs. It is a warning rather than a throw
  because the assignment is harmless and the node is otherwise fine, and it is said once per node
  rather than once per assignment.

- ada8a6f: **MSDF text fades out below the size its field can describe, instead of wearing a grey fringe.**

  A glyph's coverage is thresholded over the distance field's width measured in SCREEN pixels, and that width is floored at one pixel so the ramp cannot invert. Once a screen pixel is wider than the whole field the floor takes over and the ramp stops narrowing: the coverage becomes the raw distance, which falls from 1 at the middle of a stroke to 0 at the far edge of the field, and every letter wears a soft fringe the full width of that field. With a per-letter outline the fringe takes the stroke colour as well.

  Both shaders now scale the glyph's alpha by the unclamped range, so text fades over the last stretch rather than smudging. On the atlases in `packages/example-app` — a 4-texel field on a 42-texel em — the fade begins at about ten screen pixels per em and reaches nothing at one.

  Only glyph fragments fade. Underline, strikethrough and highlight sample no field and keep drawing at any size.

  This is minification alone; magnified text is untouched. A mip chain on the atlas would let small text stay legible rather than fade, and is the larger fix this does not attempt.

- e75a8a1: **The MSDF atlas carries a mip chain, so small text stops shimmering.**

  A glyph drawn smaller than the atlas packed it is a minification, and one tap of a full-resolution distance field per screen pixel picks an arbitrary point out of a field that varies across the whole footprint. Move the camera and each glyph lands on different texels frame to frame — a line of small text crawls. Both paths sampled the atlas at level 0 and nothing else.

  The atlas is now allocated with a full chain (`atlasMipLevels`, shared by both paths so a glyph minified on the fallback path is sampled exactly as on the other) and read through a sampler that blends between levels as well as within them.

  Filling it differs by necessity. WebGL2 has `generateMipmap`. WebGPU deliberately has nothing of the kind — a chain is filled by rendering into it — so `webgpu/atlasMipmaps.ts` draws one full-screen triangle per level per layer, sampling the level above. Both run after every layer's level 0 has landed, never before.

  Averaging a distance field is not the field of the averaged shape, so the deep levels are mush. They are never reached: the shader fades a glyph out as it approaches one screen pixel per field width, which is the first two or three levels of the chain.

  Checked against real devices rather than inferred: the same atlas mipped both ways reads back identical at every level (mean 91.0, 91.0, 90.8, 90.5 down the first four), with no WebGPU validation error and no GL error.

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
