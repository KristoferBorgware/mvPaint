---
"@mvpaint/engine": major
---

**Breaking.** `Transformer` is aligned with Konva's, so an application ported from one finds the same attributes meaning the same things.

### Shift asks for the aspect lock, it no longer inverts it

`keepRatio` and shift combine as `keepRatio || shiftKey`. Holding shift on a corner forces proportional scaling; with `keepRatio` already `true` — the default — it changes nothing, which is Konva's behaviour.

It was an XOR, so on a default-configured frame the one gesture every user knows released the lock instead of applying it. An application relying on shift to unlock a corner should set `keepRatio: false` and let shift ask for the lock.

### A frame around several nodes is upright, and carries its own angle

`useSingleNodeRotation` (default `true`) frames a lone node at that node's angle and a set of them upright. The frame's angle is its own from then on: a rotate drag turns it and it stays turned.

A multi-node box took the FIRST member's world rotation, so a tilted first member tilted the whole frame and reordering the set changed the box.

`Transformer.rotation` is that angle, in degrees, and `Transformer.fitRotation()` is it in radians — the frame the per-frame refit measures along, and `boxForNodes`' new third argument. `boxForNodes(nodes, boundsOf)` without it still measures along the first node's rotation.

Writing `rotation` turns the frame and nothing else. `Transformer.localMatrix()` is identity, so the frame's own transform fields no longer reach its parts.

### Rotation snaps live on the frame

`rotationSnaps` and `rotationSnapTolerance` (degrees, default `7`) are `Transformer` attributes. `SceneInputDispatcher`'s options of the same name are read only when it is built without a transformer; `attachSceneInput` passes its top-level `rotationSnaps` through to the frame.

### Events reach the frame as well as the nodes

`transformstart` / `transform` / `transformend` and `dragstart` / `dragmove` / `dragend` fire on the `Transformer` as well as on each node taking part, which is where an application watching "the selection" rather than a particular shape puts its handler. Each event carries `nodes` — the whole set — and `evt`, the pointer event that drove it.

A drag reaches the frame when what is being dragged is what the frame wraps.

### New

| | |
| --- | --- |
| `boundBoxFunc(oldBox, newBox)` | Constrains the box a resize or rotation lands on. Boxes are `{x, y, width, height, rotation}` in world space — `x`/`y` the turned top-left corner, `rotation` in radians, `width`/`height` signed so a mirrored box reports a negative one. Consulted on rotations too. |
| `anchorDragBoundFunc(oldPos, newPos, event)` | Constrains where a handle drag is read from, in world space — the seam snapping belongs in. `oldPos` is where the drag began, since gestures here resolve against their start and never accumulate. |
| `flipEnabled` (default `true`) | `false` holds a resize just clear of zero instead of letting a drag past the fixed point mirror the nodes. |
| `centeredScaling` (default `false`) | Scales about the box centre, which alt asks for on its own for one gesture. |
| `resizeEnabled` (default `true`) | `false` leaves the border and the rotate handle. |
| `getActiveAnchor()`, `isTransforming()`, `stopTransform()` | Which handle a gesture holds, whether one is running, and ending it where it stands. |
| `nodes` as a setter | `transformer.nodes = [a, b]` replaces the set, the same as `attach()`. |
| `detach()` with no argument | Empties the set. `detach(node)` still drops one. |

`anchorSize`, `rotateAnchorOffset`, `padding`, `borderWidth`, `anchorBorderWidth`, `enabledAnchors`, `rotateEnabled` and `keepRatio` are writable, and `enabledAnchors` is live: what is drawn and what can be grabbed change together.

### Kept different from Konva on purpose

`anchorSize` and `rotateAnchorOffset` are in **screen pixels**, held constant across zoom, so a handle stays the same size to grab however far the view is zoomed. Konva measures them in local units, where the number means the same thing only at zoom 1.

`padding` defaults to `4` rather than `0`, and the drag and transform events carry the whole `nodes` set rather than a single target.
