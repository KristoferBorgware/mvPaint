import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import Stats from 'stats.js'
import {
  createSceneRenderer,
  Camera2D,
  Transformer,
  type TransformableNode,
  type Node,
  type RendererAdapter,
  type Scene,
  type SceneRendererHandle,
  type SceneResources,
} from '@mvpaint/engine'
import { CullBoundsOverlay } from '../webgpu/cullBoundsOverlay'
import type { ExampleScene, SceneContent } from '../scenes'

// How often a live camera-zoom change (wheel/pinch/keyboard) is reported back to React
// state - see the onFrame callback below. A few times a second is imperceptible for a
// numeric readout but cuts the setState rate during a gesture by an order of magnitude.
const ZOOM_REPORT_INTERVAL_MS = 100

/** The zoom every scene is laid out to be seen at: one world unit per CSS pixel. */
const DEFAULT_ZOOM = 1

/**
 * Puts the view back where every example scene expects to be looked at from: the world origin
 * in the middle of the viewport, upright, and - when a zoom is given - at that zoom.
 *
 * This is the application's framing choice, not the engine's. Left alone, a camera puts world
 * (0, 0) at the viewport's TOP-LEFT corner at one world unit per CSS pixel - which is what a
 * document-shaped application would want and what these scenes, laid out in all four
 * quadrants, would not.
 *
 * Zoom is applied FIRST, because centring measures the world rectangle the viewport covers and
 * that rectangle depends on the zoom - re-centring at the old scale and then changing it would
 * leave the origin off by however much the two differed.
 */
function resetView(handle: SceneRendererHandle, canvas: HTMLCanvasElement, zoom?: number): void {
  if (zoom !== undefined) handle.setZoom(zoom)
  handle.camera.rotation = 0
  handle.camera.centerOn(0, 0, canvas.clientWidth, canvas.clientHeight)
}

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
  /**
   * Which render path to use. Changing it tears the renderer down and builds a new one, which
   * is the only way to switch - a canvas keeps whichever context it was first given.
   *
   * 'webgl2' forces the fallback on a machine that has WebGPU. That is the entire reason it is
   * exposed: a fallback nobody can reach on purpose is a fallback nobody tests.
   */
  backend?: 'auto' | 'webgpu' | 'webgl2'
  /** Called with a human-readable message on renderer init or device errors. */
  onError?: (message: string) => void
  /**
   * Called once the renderer exists, with the path it actually took and the GPU it got.
   *
   * Both are outcomes rather than settings - `backend` and `powerPreference` are requests the
   * browser may not honour - which is why they are reported back rather than assumed.
   */
  onPathChange?: (path: 'webgpu' | 'webgl2', adapter: RendererAdapter) => void
  /** Called with every selected node (empty when the selection is cleared). */
  onSelectionChange?: (nodes: readonly TransformableNode[]) => void
}

export interface WebGPUCanvasHandle {
  /** Clears the current selection (and its transformer) the same way Escape does. */
  clearSelection: () => void
  /**
   * Captures the current view offscreen and hands back the encoded PNG.
   *
   * It does NOT save the file - delivering the bytes is the app's business. See App.tsx, which
   * downloads them.
   *
   * The selection frame is taken off first and put back afterwards, because editor furniture is
   * not part of the picture - a screenshot with resize handles baked into it is a screenshot of
   * the editor rather than of the drawing.
   *
   * Throws with a readable message rather than reporting through onError, so the caller can put
   * the failure wherever it is showing the rest of the operation's state.
   */
  captureSnapshot: (pixelRatio?: number) => Promise<Blob>
}

export const WebGPUCanvas = forwardRef<WebGPUCanvasHandle, WebGPUCanvasProps>(function WebGPUCanvas(
  {
    scene,
    reloadToken,
    speed,
    zoom,
    onZoomChange,
    cullMargin,
    uniformCornerScale,
    backend,
    onError,
    onPathChange,
    onSelectionChange,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<SceneRendererHandle | null>(null)
  // The engine's selection frame, built by the 'editor' input preset. The app holds it only
  // to read the selection back out and to keep it out of screenshots.
  const transformerRef = useRef<Transformer | null>(null)
  const cullBoundsOverlayRef = useRef<CullBoundsOverlay | null>(null)
  // The live scene graph + what the current scene handed back, so a switch can swap content
  // without touching anything the renderer owns.
  const sceneGraphRef = useRef<Scene | null>(null)
  // The renderer's own image factory, so a scene builds the same textures on whichever path
  // is drawing. Captured once the handle exists - see applyScene.
  const resourcesRef = useRef<SceneResources | null>(null)
  const contentRef = useRef<SceneContent>({})
  const sceneDefRef = useRef(scene)
  // The scene the last apply was for. Comparing it with the incoming one is how the effect
  // below tells a switch (reset the view AND the zoom) from a reload of the same scene (reset
  // the view, keep the zoom - see the reload button's own promise in App.tsx).
  const appliedSceneRef = useRef(scene)
  // The application owns the camera - the engine renders through whatever it is given, and
  // through a default one (world origin at the top-left, zoom 1) if given none. The example
  // scenes are all laid out AROUND the origin, so this application puts the origin in the
  // middle instead; a document editor would more likely keep the default and lay its page
  // out from (0, 0) downward.
  const cameraRef = useRef(new Camera2D())
  const speedRef = useRef(speed)
  const uniformCornerScaleRef = useRef(uniformCornerScale)
  const onZoomChangeRef = useRef(onZoomChange)
  const onSelectionChangeRef = useRef(onSelectionChange)
  const onErrorRef = useRef(onError)
  const onPathChangeRef = useRef(onPathChange)

  useEffect(() => {
    onZoomChangeRef.current = onZoomChange
  }, [onZoomChange])
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange
  }, [onSelectionChange])
  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])
  useEffect(() => {
    onPathChangeRef.current = onPathChange
  }, [onPathChange])

  /**
   * Build `def` into the live scene graph, optionally clearing whatever is there first.
   *
   * A scene that declares `prepare` is loaded asynchronously, and the previous one stays on
   * screen until its assets are in - a blank canvas would read as a failure rather than as
   * waiting. The definition is re-checked afterwards so a fast switch away doesn't have a
   * slow scene land on top of the one the user actually chose.
   */
  const applyScene = useCallback((def: ExampleScene, replace: boolean, resetZoom = false) => {
    const commit = () => {
      const sceneGraph = sceneGraphRef.current
      const handle = handleRef.current
      if (!sceneGraph || !resourcesRef.current) return

      if (replace && handle) {
        // Drop the selection first: the frame holds references to nodes that are about to
        // leave the graph, and a stale selection would keep re-fitting itself around them.
        handle.input?.clearSelection()
        // What survives a scene switch is editor FURNITURE, not content: the engine's own
        // selection frame and marquee rectangle (handle.input.nodes), plus this app's debug
        // overlay. Everything else in the root is the outgoing scene.
        const furniture: (Node | null)[] = [...(handle.input?.nodes ?? []), cullBoundsOverlayRef.current]
        const keep = new Set<Node>(furniture.filter((n): n is Node => n !== null))
        for (const child of [...sceneGraph.root.children]) {
          if (!keep.has(child)) sceneGraph.root.removeChild(child)
        }
        // Now that its nodes are out of the graph, let the outgoing scene release what
        // dropping them does not: its GPU textures. Everything else it built is ordinary
        // garbage from here (see SceneContent.dispose).
        contentRef.current.dispose?.()
        contentRef.current = {}
      }

      // The resources are only needed by scenes that build their own textures (images); the
      // renderer must exist for there to be any, which the guard above ensures.
      contentRef.current = def.build(sceneGraph, resourcesRef.current)

      // Re-frame: each scene lays itself out around the origin, so a pan left over from the
      // previous one would otherwise start the new scene half off-screen.
      //
      // Switching to a DIFFERENT scene resets the zoom too, and says so to React, so the
      // slider and the readout agree with what is on screen. Reloading the current one does
      // not: the button beside it promises that the zoom is the reader's and not the scene's,
      // and someone reloading a scene they have zoomed into is not asking to lose their place.
      if (replace && handle && canvasRef.current) {
        resetView(handle, canvasRef.current, resetZoom ? DEFAULT_ZOOM : undefined)
        if (resetZoom) onZoomChangeRef.current?.(DEFAULT_ZOOM)
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
    const resources = resourcesRef.current
    if (!resources) return
    def
      .prepare(resources)
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
      clearSelection: () => handleRef.current?.input?.clearSelection(),
      // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the body reports its
      // own failures through onError; nothing is left for a caller to catch.
      captureSnapshot: async (pixelRatio = 2) => {
        const handle = handleRef.current
        if (!handle) throw new Error('The renderer is not ready yet.')

        // The selection frame is scene content like anything else and would be captured with
        // the rest of it. Detached for the shot and restored straight after, so the user's
        // selection survives taking a picture of it.
        const framed = handle.input?.selection.slice() ?? []
        handle.input?.clearSelection()
        try {
          // An opaque white background: this one is going to be looked at on its own, where a
          // transparent PNG would show whatever is behind it. Omit it for one meant to be
          // composited.
          return await handle.toBlob({ pixelRatio, background: [1, 1, 1, 1] })
        } finally {
          if (framed.length > 0) handle.input?.select(framed)
        }
      },
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
    const cullBoundsOverlay = new CullBoundsOverlay()
    cullBoundsOverlayRef.current = cullBoundsOverlay

    // stats.js - the small FPS/MS/memory overlay three.js examples use. Click it to
    // cycle panels. It renders itself into a fixed-position DOM node it owns, updated
    // once per rendered frame (not React state - a per-frame re-render would defeat
    // the purpose of an FPS counter). Mounted into our OWN wrapper div, not the
    // parent's, so this component never touches DOM nodes React itself manages there.
    const stats = new Stats()
    stats.showPanel(0)
    containerRef.current?.appendChild(stats.dom)

    createSceneRenderer(canvas, {
      backend,
      camera: cameraRef.current,
      // The whole of this application's input setup. 'editor' is pointer, keyboard, selection,
      // dragging, the resize/rotate frame and marquee selection - the bindings every canvas
      // editor writes identically, so the engine writes them once. A viewer would say 'view'
      // (camera only, nothing ever picked); a thumbnail would say nothing at all.
      input: 'editor',
      onDeviceError: (message) => onErrorRef.current?.(message),
    })
      .then((handle) => {
        if (cancelled) {
          handle.destroy()
          return
        }
        handleRef.current = handle
        onPathChangeRef.current?.(handle.path, handle.adapter)

        const transformer = handle.input?.transformer ?? null
        transformerRef.current = transformer
        // Read from the ref rather than the prop: the renderer resolves a frame or two after
        // mount, and a toggle flipped in between would otherwise be lost.
        if (transformer) transformer.keepRatio = uniformCornerScaleRef.current
        // This application keeps its own idea of the selection in React state, for the panel
        // on the right; the frame is what changed it, so the frame is what says so.
        transformer?.on('attachchange', () => onSelectionChangeRef.current?.(transformer.nodes))

        // A renderer arrives with an EMPTY scene and draws it every frame, so content is
        // added here rather than through a construction-time callback. The first frame or two
        // may show an empty canvas; that is the trade for not having to know the scene before
        // the renderer exists.
        sceneGraphRef.current = handle.scene
        resourcesRef.current = handle
        // The debug overlay is added ONCE and deliberately outlives every scene switch - like
        // the engine's own input furniture, it is editor chrome rather than content, so
        // applyScene skips it when clearing (see the `keep` set above).
        handle.scene.root.addChild(cullBoundsOverlay)
        applyScene(sceneDefRef.current, false)

        // Per-frame work, attached now rather than at construction: everything it touches -
        // the handle itself, the overlay - exists by this point, so there is nothing to guard
        // against.
        handle.onFrame = (dt) => {
          // A scene's own animation. It would overwrite anything the transformer's rotate
          // handle did, so at speed 0 the animation lets go entirely and shapes can be turned
          // by hand instead - which is why the speed reaches the scene rather than being
          // applied here.
          contentRef.current.onFrame?.(dt, speedRef.current)
          // Wheel/pinch/keyboard zoom change the camera directly (bypassing React) - poll it
          // back so the zoom slider stays in sync, without a setState on every frame: a live
          // pinch reports a new zoom on nearly every render tick, and each report is a
          // setState on the whole app tree (the slider/label live in the top-level App
          // component) - competing with this same render loop for the main thread exactly
          // while the gesture is busiest. Throttled to a few times a second instead; still
          // imperceptibly laggy for a numeric readout, and the final value always lands (the
          // very next tick past the interval reports it, gesture or not).
          const currentZoom = handle.getZoom()
          if (currentZoom !== lastReportedZoom) {
            const now = performance.now()
            if (now - lastZoomReportTime >= ZOOM_REPORT_INTERVAL_MS) {
              lastReportedZoom = currentZoom
              lastZoomReportTime = now
              onZoomChangeRef.current?.(currentZoom)
            }
          }
          // Draws the (margin-expanded) cull rectangle when the debug slider is non-zero;
          // updated every frame since it tracks the camera as it pans/zooms.
          cullBoundsOverlay.update(handle.getCullMargin() !== 0 ? handle.getCullBounds() : null)
          stats.update()
        }

        resetView(handle, canvas, zoom)
        handle.setCullMargin(cullMargin)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        onError?.(message)
      })

    return () => {
      cancelled = true
      transformerRef.current = null
      cullBoundsOverlayRef.current = null
      // Before the handle goes: the scene's textures are released through the device that is
      // about to be destroyed, so this has to happen while there still is one.
      contentRef.current.dispose?.()
      contentRef.current = {}
      // Takes the input wiring - canvas listeners, window keys, the frame - down with it.
      handleRef.current?.destroy()
      handleRef.current = null
      stats.dom.remove()
    }
    // Rebuilt when the render path changes, and only then: a canvas cannot be handed a second
    // kind of context, so switching means a new renderer over a new canvas element (see the
    // `key` on the canvas below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend])

  // Swap the scene's content in place - on a scene change, or on an explicit reload of the
  // same one. The renderer, its pipelines, the font atlases and the input furniture all
  // survive; only the scene graph's content is replaced.
  useEffect(() => {
    const switched = appliedSceneRef.current !== scene
    sceneDefRef.current = scene
    appliedSceneRef.current = scene
    // The very first scene is built where the renderer is created, so before that there is
    // nothing to swap yet.
    if (!handleRef.current || !sceneGraphRef.current) return
    applyScene(scene, true, switched)
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

  // Push the uniform/free corner-scaling toggle to the live selection frame.
  useEffect(() => {
    uniformCornerScaleRef.current = uniformCornerScale
    if (transformerRef.current) transformerRef.current.keepRatio = uniformCornerScale
  }, [uniformCornerScale])

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
      {/* Keyed on the render path: a canvas element keeps whichever context type it was
          first given, so switching paths has to mount a fresh one rather than reconfigure
          this one. */}
      <canvas
        key={backend ?? 'auto'}
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
    </div>
  )
})
