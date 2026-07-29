import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import Stats from 'stats.js'
import {
  boxForNodes,
  createSceneRenderer,
  SceneInputController,
  Transformer,
  Vector3,
  panToAnchor,
  zoomToward,
  type CameraGestureEvent,
  type MarqueeEvent,
  type Node,
  type Scene,
  type SceneRendererHandle,
  type Shape,
} from '@mvpaint/engine'
import { CullBoundsOverlay } from '../webgpu/cullBoundsOverlay'
import { MarqueeOverlay } from '../webgpu/marqueeOverlay'
import type { ExampleScene, SceneContent } from '../scenes'

// How often a live camera-zoom change (wheel/pinch/keyboard) is reported back to React
// state - see the onFrame callback below. A few times a second is imperceptible for a
// numeric readout but cuts the setState rate during a gesture by an order of magnitude.
const ZOOM_REPORT_INTERVAL_MS = 100

interface WebGPUCanvasProps {
  /**
   * The example scene to show. Changing it unloads the current scene's content and builds
   * this one in its place, reusing the same GPU device, pipelines and atlases - tearing the
   * renderer down and back up per switch would cost a visible stall and a fresh font upload.
   */
  scene: ExampleScene
  /**
   * Bump to rebuild the CURRENT scene from scratch. Scene switching keys on `scene`'s
   * identity, so re-selecting the one already showing is deliberately a no-op; this is the
   * separate "start it over" signal, and it takes the same path a switch does.
   */
  reloadToken: number
  /** Spin speed in radians/second. Updated live without recreating the renderer. */
  speed: number
  /** Camera zoom factor (>1 zooms in). Updated live without recreating the renderer;
   * also updated live in the other direction by wheel/pinch/keyboard zoom. */
  zoom: number
  onZoomChange?: (zoom: number) => void
  /** Debug/testing: grows (or shrinks, if negative) the viewport-culling rectangle, in
   * world units, so popping at the view edge - or the cull itself - can be seen live. */
  cullMargin: number
  /** When false, dragging a corner anchor scales each axis freely instead of uniformly. */
  uniformCornerScale: boolean
  /** Called with a human-readable message on WebGPU init or device errors. */
  onError?: (message: string) => void
  /** Called with every selected node (empty when the selection is cleared). */
  onSelectionChange?: (nodes: readonly Shape[]) => void
}

export interface WebGPUCanvasHandle {
  /** Clears the current selection (and its transformer) the same way Escape does. */
  clearSelection: () => void
  /**
   * Force a text-lane rebuild on the next frame - call after mutating a Text node's runs
   * (e.g. its shadow/glow style) in place, since the renderer only rebuilds when the
   * visible SET of Text nodes changes, not when one's own content does.
   */
  markTextDirty: () => void
}

export const WebGPUCanvas = forwardRef<WebGPUCanvasHandle, WebGPUCanvasProps>(function WebGPUCanvas(
  { scene, reloadToken, speed, zoom, onZoomChange, cullMargin, uniformCornerScale, onError, onSelectionChange },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<SceneRendererHandle | null>(null)
  const controllerRef = useRef<SceneInputController | null>(null)
  const transformerRef = useRef<Transformer | null>(null)
  const cullBoundsOverlayRef = useRef<CullBoundsOverlay | null>(null)
  const marqueeOverlayRef = useRef<MarqueeOverlay | null>(null)
  // The live scene graph + what the current scene handed back, so a switch can swap content
  // without touching anything the renderer owns.
  const sceneGraphRef = useRef<Scene | null>(null)
  const contentRef = useRef<SceneContent>({})
  const sceneDefRef = useRef(scene)
  // The camera's framing as the renderer set it up, captured so a scene switch can put the
  // view back where it started instead of stranding the new scene off-screen.
  const homeCameraRef = useRef<{ eye: Vector3; target: Vector3 } | null>(null)
  const speedRef = useRef(speed)
  const onZoomChangeRef = useRef(onZoomChange)
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onErrorRef = useRef(onError)

  useEffect(() => {
    onZoomChangeRef.current = onZoomChange
  }, [onZoomChange])
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange
  }, [onSelectionChange])
  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  /**
   * Build `def` into the live scene graph, optionally clearing whatever is there first.
   *
   * A scene that declares `prepare` is loaded asynchronously, and the previous one stays on
   * screen until its assets are in - a blank canvas would read as a failure rather than as
   * waiting. The definition is re-checked afterwards so a fast switch away doesn't have a
   * slow scene land on top of the one the user actually chose.
   */
  const applyScene = useCallback((def: ExampleScene, replace: boolean) => {
    const commit = () => {
      const sceneGraph = sceneGraphRef.current
      const handle = handleRef.current
      const transformer = transformerRef.current
      if (!sceneGraph) return

      if (replace && handle && transformer) {
        // Drop the selection first: the transformer holds references to nodes that are about
        // to leave the graph, and a stale selection would keep re-fitting a frame around them.
        controllerRef.current?.setSelection([])
        const furniture: (Node | null)[] = [transformer, cullBoundsOverlayRef.current, marqueeOverlayRef.current, handle.camera]
        const keep = new Set<Node>(furniture.filter((n): n is Node => n !== null))
        for (const child of [...sceneGraph.root.children]) {
          if (!keep.has(child)) sceneGraph.root.removeChild(child)
        }
      }

      contentRef.current = def.build(sceneGraph)

      // Re-frame: each scene lays itself out around the origin, so a pan left over from the
      // previous one would otherwise start the new scene half off-screen.
      if (replace && handle && homeCameraRef.current) {
        handle.camera.eye = homeCameraRef.current.eye.clone()
        handle.camera.target = homeCameraRef.current.target.clone()
      }

      // Every scene switch sets this from the new scene's own preference (default false, i.e.
      // culling on) - not just when disabling it - so leaving a scene that turned it off always
      // restores normal culling for whatever comes next, with no special-cased "on the way out".
      handle?.setCullingEnabled(!def.disableCulling)
      handle?.setZSortEnabled(!def.disableZSort)
      handle?.setShadowsEnabled(!def.disableShadows)

      // Both lanes rebuild from the visible set, which has just changed wholesale.
      handle?.markGeometryDirty()
      handle?.markTextGeometryDirty()
    }

    if (!def.prepare) {
      // Synchronous by default, so the very first scene is on screen for the first frame.
      commit()
      return
    }
    def
      .prepare()
      .then(() => {
        if (sceneDefRef.current === def) commit()
      })
      .catch((err: unknown) => {
        onErrorRef.current?.(err instanceof Error ? err.message : String(err))
      })
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      clearSelection: () => controllerRef.current?.setSelection([]),
      markTextDirty: () => handleRef.current?.markTextGeometryDirty(),
    }),
    [],
  )

  // Initialize the renderer once, on mount.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    let lastReportedZoom = zoom
    let lastZoomReportTime = 0
    let inputController: SceneInputController | null = null
    let detachKeyboard: (() => void) | null = null
    const cullBoundsOverlay = new CullBoundsOverlay()
    cullBoundsOverlayRef.current = cullBoundsOverlay
    const marqueeOverlay = new MarqueeOverlay()
    marqueeOverlayRef.current = marqueeOverlay

    // The selection frame: eight resize anchors plus a rotate handle. It lives in the
    // scene like any other content, and is re-fitted to the selection every frame below.
    const transformer = new Transformer({ keepRatio: uniformCornerScale })
    transformerRef.current = transformer

    // stats.js - the small FPS/MS/memory overlay three.js examples use. Click it to
    // cycle panels. It renders itself into a fixed-position DOM node it owns, updated
    // once per rendered frame (not React state - a per-frame re-render would defeat
    // the purpose of an FPS counter). Mounted into our OWN wrapper div, not the
    // parent's, so this component never touches DOM nodes React itself manages there.
    const stats = new Stats()
    stats.showPanel(0)
    containerRef.current?.appendChild(stats.dom)

    createSceneRenderer(canvas, {
      onDeviceError: (message) => onError?.(message),
      populate: (sceneGraph) => {
        sceneGraphRef.current = sceneGraph
        // The transformer and both debug/gesture overlays are added ONCE and deliberately
        // outlive every scene switch: they are editor furniture, not content, so loadScene
        // below skips them when clearing (see the `keep` set above).
        sceneGraph.root.addChild(transformer)
        sceneGraph.root.addChild(cullBoundsOverlay)
        sceneGraph.root.addChild(marqueeOverlay)
        applyScene(sceneDefRef.current, false)
      },
      onFrame: (dt) => {
        // A scene's own animation. It would overwrite anything the transformer's rotate
        // handle did, so at speed 0 the animation lets go entirely and shapes can be turned
        // by hand instead - which is why the speed reaches the scene rather than being
        // applied here.
        contentRef.current.onFrame?.(dt, speedRef.current)
        // Wheel/pinch/keyboard zoom change the camera directly (bypassing React) - poll
        // it back so the zoom slider stays in sync, without a setState on every frame:
        // a live pinch reports a new zoom on nearly every render tick, and each report is
        // a setState on the whole app tree (the slider/label live in the top-level App
        // component) - competing with this same render loop for the main thread exactly
        // while the gesture is busiest. Throttled to a few times a second instead; still
        // imperceptibly laggy for a numeric readout, and the final value always lands
        // (the very next tick past the interval reports it, gesture or not).
        const handle = handleRef.current
        const currentZoom = handle?.getZoom()
        if (currentZoom !== undefined && currentZoom !== lastReportedZoom) {
          const now = performance.now()
          if (now - lastZoomReportTime >= ZOOM_REPORT_INTERVAL_MS) {
            lastReportedZoom = currentZoom
            lastZoomReportTime = now
            onZoomChangeRef.current?.(currentZoom)
          }
        }
        // Draws the (margin-expanded) cull rectangle when the debug slider is non-zero;
        // updated every frame since it tracks the camera as it pans/zooms.
        if (handle) {
          cullBoundsOverlay.update(handle.getCullMargin() !== 0 ? handle.getCullBounds() : null)
          // Re-fit the frame to whatever is selected: the selection may be moving under
          // a drag, spinning with the animation above, or unchanged - all one code path.
          const selection = transformer.nodes
          const box = selection.length > 0 ? boxForNodes(selection, (node) => handle.localBoundsOf(node)) : null
          transformer.update(box, handle.getZoom())
        }
        stats.update()
      },
    })
      .then((handle) => {
        if (cancelled) {
          handle.destroy()
          return
        }
        handleRef.current = handle
        homeCameraRef.current = { eye: handle.camera.eye.clone(), target: handle.camera.target.clone() }
        handle.setZoom(zoom)
        handle.setCullMargin(cullMargin)
        inputController = new SceneInputController(canvas, handle, {
          transformer,
          // Settle onto the 45-degree marks while rotating, which is what makes it
          // possible to get something exactly upright again by hand.
          rotationSnaps: [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, Math.PI, (5 * Math.PI) / 4, (3 * Math.PI) / 2, (7 * Math.PI) / 4],
          // No markGeometryDirty() here: every transformer part is a permanent, unit-quad
          // slot in the mesh batcher (see Transformer's class comment) - selecting or
          // deselecting never changes the batcher's shape set, so it never needs a rebuild.
          // Forcing one here would re-tessellate and re-upload EVERY shape sharing the
          // batch on every selection change, not just the handful of quads that moved.
          onSelectionChange: (nodes) => onSelectionChangeRef.current?.(nodes),
        })
        controllerRef.current = inputController

        // --- what a press on empty space means, which is this application's to decide ---
        //
        // The engine reports where the pointer went and provides the rectangle; everything
        // below - that a bare drag pulls one out, that a held finger does too, that what it
        // covers becomes the selection, that shift adds to it rather than replacing it - is
        // policy, and lives here so a different host can choose differently.
        const root = handle.scene.root
        const controller = inputController
        let marqueeAdds = false
        let holdTimer: ReturnType<typeof setTimeout> | null = null
        const cancelHold = () => {
          if (holdTimer !== null) clearTimeout(holdTimer)
          holdTimer = null
        }

        root.on('pointerdown', (e) => {
          // Only a press that reached the root itself landed on empty space; anything over
          // a shape has that shape as its target.
          if (e.target !== root || !e.world) return
          marqueeAdds = (e.evt as PointerEvent | undefined)?.shiftKey ?? false
          if ((e.evt as PointerEvent | undefined)?.pointerType === 'touch') {
            // A finger has no spare button, so a bare drag keeps panning and a held finger
            // is what asks for a rectangle instead.
            const world = e.world
            cancelHold()
            holdTimer = setTimeout(() => {
              holdTimer = null
              navigator.vibrate?.(12)
              controller.beginMarquee(world)
            }, 450)
          } else {
            controller.beginMarquee(e.world)
          }
        })
        root.on('pointermove', () => {
          // Moving before the hold fires means a pan was meant, not a rectangle.
          if (holdTimer !== null && !controller.marquee.active) cancelHold()
        })
        root.on('pointerup pointercancel', cancelHold)

        // The overlay follows the rectangle. No markGeometryDirty(): every marquee part is a
        // permanent, unit-quad slot in the mesh batcher (see MarqueeOverlay's class comment),
        // so pulling one out never changes the batcher's shape set.
        root.on('marqueestart marqueemove', (e) => {
          const { from, to } = e as MarqueeEvent
          marqueeOverlay.update({ from, to }, handle.getZoom())
        })
        root.on('marqueeend', (e) => {
          marqueeOverlay.update(null, handle.getZoom())
          const covered = ((e as MarqueeEvent).nodes ?? []) as Shape[]
          if (covered.length === 0 && !marqueeAdds) return
          const merged = marqueeAdds ? [...controller.getSelection()] : []
          for (const node of covered) if (!merged.includes(node)) merged.push(node)
          controller.setSelection(merged)
        })

        // A click that hit nothing clears the selection - again a choice, not a given.
        root.on('click tap', (e) => {
          if (e.target !== root) return
          if (!(e.evt as PointerEvent | undefined)?.shiftKey) controller.setSelection([])
        })

        // --- driving the camera, which the engine reports on but never moves ---
        //
        // The engine recognises a pan, a pinch and a wheel notch and says where they are;
        // how far a notch is worth, how far the view may zoom, and which keys move it are
        // all decisions, so they are made here.
        const MIN_ZOOM = 0.05
        const MAX_ZOOM = 10
        const WHEEL_SENSITIVITY = 0.002 // ~18% per 100px of wheel delta
        const KEY_ZOOM_STEP = 1.2
        const KEY_PAN_STEP_PX = 40
        const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
        const viewportOf = () => ({ width: canvas.clientWidth, height: canvas.clientHeight })
        const applyZoom = (screenX: number, screenY: number, next: number) => {
          zoomToward(handle.camera, viewportOf(), screenX, screenY, canvas.clientHeight / next)
          handle.setZoom(next)
        }

        root.on('panmove', (e) => {
          const g = e as CameraGestureEvent
          panToAnchor(handle.camera, viewportOf(), g.point.x, g.point.y, g.anchor)
        })

        let pinchStartZoom = 1
        root.on('pinchstart', () => {
          pinchStartZoom = handle.getZoom()
        })
        root.on('pinchmove', (e) => {
          const g = e as CameraGestureEvent
          const next = clampZoom(pinchStartZoom * g.scale)
          handle.camera.viewHeight = Math.max(1e-3, canvas.clientHeight / next)
          handle.setZoom(next)
          panToAnchor(handle.camera, viewportOf(), g.point.x, g.point.y, g.anchor)
        })

        root.on('wheel', (e) => {
          const raw = e.evt as WheelEvent | undefined
          if (!raw || !e.screen) return
          applyZoom(e.screen.x, e.screen.y, clampZoom(handle.getZoom() * Math.exp(-raw.deltaY * WHEEL_SENSITIVITY)))
        })

        // Keyboard: arrow-pan, +/- zoom about the viewport centre, space to grab the view,
        // Escape to clear the selection.
        const editable = (el: Element | null) =>
          !!el && ((el as HTMLElement).isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
        const previousCursor = canvas.style.cursor
        const onKeyDown = (ev: KeyboardEvent) => {
          if (editable(document.activeElement)) return
          if (ev.key === ' ') {
            if (controller.grabContent) {
              controller.grabContent = false
              canvas.style.cursor = 'grab'
            }
            ev.preventDefault()
            return
          }
          const viewport = viewportOf()
          const step = (handle.camera.viewHeight / Math.max(1, viewport.height)) * KEY_PAN_STEP_PX
          const centre = { x: viewport.width / 2, y: viewport.height / 2 }
          switch (ev.key) {
            case 'ArrowLeft': handle.camera.eye.x -= step; handle.camera.target.x -= step; break
            case 'ArrowRight': handle.camera.eye.x += step; handle.camera.target.x += step; break
            case 'ArrowUp': handle.camera.eye.y += step; handle.camera.target.y += step; break
            case 'ArrowDown': handle.camera.eye.y -= step; handle.camera.target.y -= step; break
            case '+':
            case '=': applyZoom(centre.x, centre.y, clampZoom(handle.getZoom() * KEY_ZOOM_STEP)); break
            case '-':
            case '_': applyZoom(centre.x, centre.y, clampZoom(handle.getZoom() / KEY_ZOOM_STEP)); break
            case 'Escape': controller.setSelection([]); return
            default: return
          }
          ev.preventDefault()
        }
        const onKeyUp = (ev: KeyboardEvent) => {
          if (ev.key !== ' ') return
          controller.grabContent = true
          canvas.style.cursor = previousCursor
        }
        window.addEventListener('keydown', onKeyDown)
        window.addEventListener('keyup', onKeyUp)
        detachKeyboard = () => {
          window.removeEventListener('keydown', onKeyDown)
          window.removeEventListener('keyup', onKeyUp)
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        onError?.(message)
      })

    return () => {
      cancelled = true
      detachKeyboard?.()
      inputController?.destroy()
      controllerRef.current = null
      transformerRef.current = null
      cullBoundsOverlayRef.current = null
      marqueeOverlayRef.current = null
      handleRef.current?.destroy()
      handleRef.current = null
      stats.dom.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Swap the scene's content in place - on a scene change, or on an explicit reload of the
  // same one. The renderer, its pipelines, the font atlases and the transformer all
  // survive; only the scene graph's content is replaced.
  useEffect(() => {
    sceneDefRef.current = scene
    // Before the first frame the initial scene is built by `populate` instead, so there is
    // nothing to swap yet.
    if (!handleRef.current || !sceneGraphRef.current || !transformerRef.current) return
    applyScene(scene, true)
  }, [scene, reloadToken, applyScene])

  // Push speed changes to the running renderer.
  useEffect(() => {
    speedRef.current = speed
  }, [speed])

  // Push zoom-slider changes to the running renderer.
  useEffect(() => {
    handleRef.current?.setZoom(zoom)
  }, [zoom])

  // Push cull-margin-slider changes to the running renderer.
  useEffect(() => {
    handleRef.current?.setCullMargin(cullMargin)
  }, [cullMargin])

  // Push the uniform/free corner-scaling toggle to the live transformer.
  useEffect(() => {
    if (transformerRef.current) transformerRef.current.keepRatio = uniformCornerScale
  }, [uniformCornerScale])

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
    </div>
  )
})
