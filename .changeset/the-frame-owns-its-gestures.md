---
"@mvpaint/engine": major
---

**Breaking.** `Transformer` owns the policy its handle gestures run under, and gains the two callbacks that let an application constrain them.

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

| | |
| --- | --- |
| `boundBoxFunc(oldBox, newBox)` | Constrains the box a resize or rotation lands on. Boxes are `{x, y, width, height, rotation}` in world space — `x`/`y` the turned top-left corner, `rotation` in radians, `width`/`height` signed so a mirrored box reports a negative one. Consulted on rotations too. |
| `anchorDragBoundFunc(oldPos, newPos, event)` | Constrains where a handle drag is read from, in world space — the seam snapping belongs in. `oldPos` is where the drag began, since gestures here resolve against their start and never accumulate. |
| `flipEnabled` (default `true`) | `false` holds a resize just clear of zero instead of letting a drag past the fixed point mirror the nodes. |
| `centeredScaling` (default `false`) | Scales about the box centre, which alt asks for on its own for one gesture. |
| `resizeEnabled` (default `true`) | `false` leaves the border and the rotate handle. |
| `useFirstNodeRotation` (default `true`) | `false` frames a set of nodes upright rather than along the first member's angle. |
| `getActiveAnchor()`, `isTransforming()`, `stopTransform()` | Which handle a gesture holds, whether one is running, and ending it where it stands. |
| `nodes` as a setter | `transformer.nodes = [a, b]` replaces the set, the same as `attach()`. |
| `detach()` with no argument | Empties the set. `detach(node)` still drops one. Called bare it used to return silently. |

`anchorSize`, `rotateAnchorOffset`, `padding`, `borderWidth`, `anchorBorderWidth`, `enabledAnchors`, `rotateEnabled` and `keepRatio` are writable.

Handles show their cursor on **hover**, not only once pressed, and it turns with the box — a corner of a box at 90° offers `nesw-resize`. The rotate handle offers an open hand before the drag and a closed one during it.

### Under it

Every handle gesture reduces to two boxes — the one the press started on and the one the pointer asks for — and `deltaBetweenBoxes` turns the pair into the single world delta each node receives. That is the seam `boundBoxFunc` sits in: whatever box it hands back, however little it resembles what the pointer asked for, is expressible as a delta.

New in `transformerMath`: `BoundBox`, `BoundBoxFunc`, `AnchorDragBoundFunc`, `boxToBoundBox`, `boundBoxToBox`, `resizedBox`, `deltaBetweenBoxes`, `anchorCursor`. `OrientedBox` half-extents are signed, so a mirrored box reports a negative one.
