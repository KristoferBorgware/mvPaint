import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import Stats from 'stats.js'
import {
  createSceneRenderer,
  SceneInputController,
  type PickableNode,
  type Rect,
  type SceneRendererHandle,
} from '@mvpaint/engine'
import { buildDemoScene } from '../webgpu/demoScene'
import { SelectionHighlight } from '../webgpu/selectionHighlight'
import { CullBoundsOverlay } from '../webgpu/cullBoundsOverlay'

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
  /** Called with a human-readable message on WebGPU init or device errors. */
  onError?: (message: string) => void
  /** Called with the clicked/tapped node, or null on empty space / Escape. */
  onSelect?: (node: PickableNode | null) => void
}

export interface WebGPUCanvasHandle {
  /** Clears the current selection (and its highlight) the same way Escape does. */
  clearSelection: () => void
}

export const WebGPUCanvas = forwardRef<WebGPUCanvasHandle, WebGPUCanvasProps>(function WebGPUCanvas(
  { speed, zoom, onZoomChange, cullMargin, onError, onSelect },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<SceneRendererHandle | null>(null)
  const highlightRef = useRef<SelectionHighlight | null>(null)
  const speedRef = useRef(speed)
  const onZoomChangeRef = useRef(onZoomChange)
  const onSelectRef = useRef(onSelect)

  useEffect(() => {
    onZoomChangeRef.current = onZoomChange
  }, [onZoomChange])
  useEffect(() => {
    onSelectRef.current = onSelect
  }, [onSelect])

  useImperativeHandle(
    ref,
    () => ({
      clearSelection: () => {
        const handle = handleRef.current
        const highlight = highlightRef.current
        if (!handle || !highlight) return
        highlight.update(handle, null)
        onSelectRef.current?.(null)
      },
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
    const highlight = new SelectionHighlight()
    highlightRef.current = highlight
    const cullBoundsOverlay = new CullBoundsOverlay()

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
      },
      onFrame: (dt) => {
        angle += dt * speedRef.current
        for (const [rect, spinScale] of spins) {
          rect.rotation = angle * spinScale
        }
        // Wheel/pinch/keyboard zoom change the camera directly (bypassing React) - poll
        // it back so the zoom slider stays in sync, without a setState on every frame.
        const currentZoom = handleRef.current?.getZoom()
        if (currentZoom !== undefined && currentZoom !== lastReportedZoom) {
          lastReportedZoom = currentZoom
          onZoomChangeRef.current?.(currentZoom)
        }
        // Draws the (margin-expanded) cull rectangle when the debug slider is non-zero;
        // updated every frame since it tracks the camera as it pans/zooms.
        if (handleRef.current) {
          cullBoundsOverlay.update(handleRef.current, handleRef.current.getCullMargin())
        }
        // Keeps the selection outline on its node as that node moves - dragged by the
        // pointer, or spun by the animation above.
        highlight.sync()
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
          onPick: (node) => {
            highlight.update(handle, node)
            onSelectRef.current?.(node)
          },
          // Grabbing a node selects it, the way direct-manipulation editors do - so the
          // outline is already on it (and following it, via sync() above) as it moves.
          onDragStart: (node) => {
            highlight.update(handle, node)
            onSelectRef.current?.(node)
          },
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        onError?.(message)
      })

    return () => {
      cancelled = true
      inputController?.destroy()
      handleRef.current?.destroy()
      handleRef.current = null
      highlightRef.current = null
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

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
    </div>
  )
})
