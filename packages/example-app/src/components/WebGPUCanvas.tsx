import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import Stats from 'stats.js'
import {
  boxForNodes,
  createSceneRenderer,
  SceneInputController,
  Transformer,
  Vector3,
  type Node,
  type Scene,
  type SceneRendererHandle,
  type Shape,
} from '@mvpaint/engine'
import { CullBoundsOverlay } from '../webgpu/cullBoundsOverlay'
import { MarqueeOverlay } from '../webgpu/marqueeOverlay'
import type { ExampleScene, SceneContent } from '../scenes'

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

  useEffect(() => {
    onZoomChangeRef.current = onZoomChange
  }, [onZoomChange])
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange
  }, [onSelectionChange])

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
    let inputController: SceneInputController | null = null
    const cullBoundsOverlay = new CullBoundsOverlay()
    const marqueeOverlay = new MarqueeOverlay()

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
        // The transformer is added ONCE and deliberately outlives every scene switch: it is
        // editor furniture, not content, so loadScene below skips it when clearing.
        sceneGraph.root.addChild(transformer)
        contentRef.current = sceneDefRef.current.build(sceneGraph)
      },
      onFrame: (dt) => {
        // A scene's own animation. It would overwrite anything the transformer's rotate
        // handle did, so at speed 0 the animation lets go entirely and shapes can be turned
        // by hand instead - which is why the speed reaches the scene rather than being
        // applied here.
        contentRef.current.onFrame?.(dt, speedRef.current)
        // Wheel/pinch/keyboard zoom change the camera directly (bypassing React) - poll
        // it back so the zoom slider stays in sync, without a setState on every frame.
        const handle = handleRef.current
        const currentZoom = handle?.getZoom()
        if (currentZoom !== undefined && currentZoom !== lastReportedZoom) {
          lastReportedZoom = currentZoom
          onZoomChangeRef.current?.(currentZoom)
        }
        // Draws the (margin-expanded) cull rectangle when the debug slider is non-zero;
        // updated every frame since it tracks the camera as it pans/zooms.
        if (handle) {
          cullBoundsOverlay.update(handle, handle.getCullMargin())
          // Re-fit the frame to whatever is selected: the selection may be moving under
          // a drag, spinning with the animation above, or unchanged - all one code path.
          const selection = transformer.selection
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
          onSelectionChange: (nodes) => {
            onSelectionChangeRef.current?.(nodes)
            handle.markGeometryDirty()
          },
          onMarquee: (corners) => marqueeOverlay.update(handle, corners),
        })
        controllerRef.current = inputController
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        onError?.(message)
      })

    return () => {
      cancelled = true
      inputController?.destroy()
      controllerRef.current = null
      transformerRef.current = null
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
    const handle = handleRef.current
    const sceneGraph = sceneGraphRef.current
    const transformer = transformerRef.current
    // Before the first frame the initial scene is built by `populate` instead, so there is
    // nothing to swap yet.
    if (!handle || !sceneGraph || !transformer) return

    // Drop the selection first: the transformer holds references to nodes that are about to
    // leave the graph, and a stale selection would keep re-fitting a frame around them.
    controllerRef.current?.setSelection([])

    const keep = new Set<Node>([transformer, handle.camera])
    for (const child of [...sceneGraph.root.children]) {
      if (!keep.has(child)) sceneGraph.root.removeChild(child)
    }

    contentRef.current = scene.build(sceneGraph)

    // Re-frame: each scene lays itself out around the origin, so a pan left over from the
    // previous one would otherwise start the new scene half off-screen.
    if (homeCameraRef.current) {
      handle.camera.eye = homeCameraRef.current.eye.clone()
      handle.camera.target = homeCameraRef.current.target.clone()
    }

    // Both lanes rebuild from the visible set, which has just changed wholesale.
    handle.markGeometryDirty()
    handle.markTextGeometryDirty()
  }, [scene, reloadToken])

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
