---
"@mvpaint/engine": minor
---

Attributes can be animated. `node.to()` starts one immediately, and `Tween` is the same thing kept — playable, pausable, reversible, seekable.

```ts
box.to({ x: 400, rotation: 90, fill: 'tomato', duration: 0.6, easing: Easings.BackEaseOut })

const pulse = new Tween({ node: dot, duration: 0.8, yoyo: true, scaleX: 1.4, scaleY: 1.4 })
pulse.play()
```

Every key that is not a setting — `duration` (seconds, default 0.3), `easing`, `yoyo`, `ticker`, and the handlers `onPlay`/`onPause`/`onReverse`/`onSeek`/`onUpdate`/`onFinish`/`onReset` — is one of the node's own attributes. So whatever `getAttr`/`setAttr` reaches can be animated, and a shape that gains an attribute gains the ability to have it animated with nothing added: `x`, `rotation`, `opacity`, `strokeWidth`, `radius`, `dash`, `points`, the gradient geometry and its stops. A key the node does not declare throws when the tween is built rather than quietly animating nothing.

### What is new

| | |
| --- | --- |
| `Node.to(settings)` | fire and forget: plays at once, destroys itself at the finish |
| `Tween` | `play` `pause` `reverse` `seek` `reset` `finish` `destroy`, plus `state`, `time`, `attributes` |
| `Easings` | `Linear`, and the In/Out/InOut forms of `Ease`, `Strong`, `Back`, `Elastic` and `Bounce` |
| `TweenTimeline` | the clock and state machine on its own, for animating something that is not a node |
| `TweenTicker`, `tweenTicker`, `driveTweens` | where the frame comes from |
| `TweenTarget` | the seam a tween animates through — a name, `attributeNames()`, `getAttr`, `setAttr` |
| `Camera2D.to(settings)` | the camera's own `x`/`y`/`zoom`/`rotation`, animated like any attribute |
| `cameraTween`, `viewForBounds`, `zoomCameraAbout` | animating the view rather than the fields |

### The camera

`Camera2D` implements `TweenTarget`, so `camera.to({ x, y, zoom, duration })` works — its four fields, linear, like any other attribute. It also gains `attributeNames()`/`getAttr()`/`setAttr()` as prototype members, so a camera's own properties are still only its six view parameters.

For a pan-and-zoom, say it as a view:

```ts
const viewport = { width: canvas.clientWidth, height: canvas.clientHeight }
cameraTween(camera, viewport, { center: { x: 400, y: 300 }, zoom: 4, duration: 0.8 }).play()
```

Three reasons, none about tweening. `x`/`y` are the view's top-left **corner**, so holding them still while the zoom changes slides the content sideways; `center` is what a caller means by where the camera is looking. `zoom` is a scale factor, so a straight line from 1 to 8 passes 4 after seven eighths of the animation — the view tween travels through its logarithm, so every moment magnifies by the same ratio, and the zoom cannot pass through zero under an overshooting curve.

And the pan and the zoom are not independent. Screen-crossing speed is world-space speed times the zoom, so a centre travelling in a straight line through world space crosses the view at a rate that varies by the flight's whole zoom ratio — flying in eightfold, the pan is eight times faster at the end than at the start, which reads as the zoom happening first and the pan being tacked on after. `pan: 'screen'` (the default) places the centre from the zoom instead, so the two finish together as one movement; `pan: 'world'` is the straight line. No easing substitutes for either — one curve applied to both leaves their ratio exactly as it was.

`viewForBounds(bounds, viewport, padding)` turns a world box — either `getClientRect()`'s rectangle or an `AABB` — into that centre and zoom, so "zoom to fit" composes with the tween instead of being a flag on it. `zoomCameraAbout(camera, viewport, x, y, zoom)` holds the world point under a viewport pixel for the whole flight, not only at the ends.

Every view tween on one camera shares a target, so interrupting a flight halfway starts the new one from where the camera actually got to.

### The frame

A played tween starts an animation frame loop that stops as soon as the last one does, so an application that only writes `node.to({ x: 100 })` never has to know the ticker exists. One that already has a frame can take it over, which puts the write and the draw that shows it in the same frame:

```ts
const stop = driveTweens(handle)
```

Milliseconds are supplied to a timeline rather than sampled from a clock inside it, so every tween in a scene shares one notion of *now*, and a test steps the ticker by hand and gets exactly the frame a browser would have drawn.

### What half way means

`interpolate.ts` decides from the shape of the value. A colour mixes channel by channel in the engine's `[r, g, b, a]` tuple, and a fill animated to or from `null` — no fill at all — travels through its own colour at zero alpha rather than through black. A gradient carries its stops' offsets and colours, in either form they are written in. A `points` list of a different length is resampled by projecting the longer list onto the shorter one's outline, so the new points slide out of the shape they are joining.

An attribute has one tween writing it: starting a second on the same attribute takes it from the first, which carries on with the rest of its own. Fading a shape out while a half-finished move is running leaves the move running.
