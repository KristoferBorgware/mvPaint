---
"@mvpaint/engine": major
---

**Breaking.** Every angle an application writes is now in DEGREES.

`rotation: 45` is a eighth of a turn. It was 45 radians — a little over seven full turns — so this is a change that looks like nothing and moves everything.

| | was | is |
| --- | --- | --- |
| `Node.rotation` (and every subclass) | radians | degrees |
| `Camera2D.rotation` | radians | degrees |
| `rotationSnaps` | radians, default `[0, π/4, …]` | degrees, default `[0, 45, 90, 135, 180, 225, 270, 315]` |
| `rotationSnapTolerance` | radians, default `0.12` | degrees, default `7` |
| `ShapeContext.arc` / `ellipse` / `circle` angles | radians | degrees |

To migrate, multiply every angle by `180 / Math.PI`, or replace it with the degree value it always meant — `Math.PI / 4` becomes `45`.

### What did not change

Everything that computes with an angle rather than storing one still works in radians, because that is what `Math.cos`, `Math.atan2` and `Quaternion.fromAxisAngle` take: `decompose2D`, `OrientedBox.rotation` and the rest of `transformerMath`, `worldRotationOf`, `TextQuad.rotation`, `Matrix4x4.rotationZ`, and the shaders.

The two units meet at named boundaries — `Node.localMatrix` on the way down, `Node.applyLocalMatrix` on the way back up — so a value crosses in exactly one place per property. Code that mixes the two, such as a transformer gesture pushing a world matrix onto a node, converts at that seam and nowhere else.

A field's unit is part of what its name means here: anything holding radians says so in its doc comment, and anything that does not is degrees.

### `ShapeContext` diverges from Canvas2D here

`arc()` and `ellipse()` mirror the Canvas2D methods, which take radians. They take degrees. One method in a different unit from every other angle in the engine is the kind of difference only ever found by drawing the wrong thing, so consistency won.

### New

`degToRad` and `radToDeg` are exported from `@mvpaint/engine` (`math/angle.ts`), for code that has to cross the boundary itself — reading `worldRotationOf` and writing it to a node, for instance.
