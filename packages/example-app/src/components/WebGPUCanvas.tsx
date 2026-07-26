import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import Stats from 'stats.js'
import {
  boxForNodes,
  createSceneRenderer,
  SceneInputController,
  Transformer,
  type Rect,
  type SceneRendererHandle,
  type Shape,
} from '@mvpaint/engine'
import { buildDemoScene } from '../webgpu/demoScene'
import { CullBoundsOverlay } from '../webgpu/cullBoundsOverlay'
import { MarqueeOverlay } from '../webgpu/marqueeOverlay'

interface WebGPUCanvasProps {
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
}

export const WebGPUCanvas = forwardRef<WebGPUCanvasHandle, WebGPUCanvasProps>(function WebGPUCanvas(
  { speed, zoom, onZoomChange, cullMargin, uniformCornerScale, onError, onSelectionChange },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<SceneRendererHandle | null>(null)
  const controllerRef = useRef<SceneInputController | null>(null)
  const transformerRef = useRef<Transformer | null>(null)
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
    }),
    [],
  )

  // Initialize the renderer once, on mount.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    let angle = 0
    let spins = new Map<Rect, number>()
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
      populate: (scene) => {
        spins = buildDemoScene(scene)
        scene.root.addChild(transformer)
      },
      onFrame: (dt) => {
        // The spin drives these rects' rotation every frame, which would overwrite
        // anything the transformer's rotate handle did to them - so at speed 0 the
        // animation lets go entirely and they can be turned by hand instead.
        if (speedRef.current > 0) {
          angle += dt * speedRef.current
          for (const [rect, spinScale] of spins) {
            rect.rotation = angle * spinScale
          }
        }
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
