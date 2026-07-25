import { useEffect, useRef } from 'react'
import { createSceneRenderer, type Rect, type SceneRendererHandle } from '@mvpaint/engine'
import { buildDemoScene } from '../webgpu/demoScene'

interface WebGPUCanvasProps {
  /** Spin speed in radians/second. Updated live without recreating the renderer. */
  speed: number
  /** Camera zoom factor (>1 zooms in). Updated live without recreating the renderer. */
  zoom: number
  /** Called with a human-readable message on WebGPU init or device errors. */
  onError?: (message: string) => void
}

export function WebGPUCanvas({ speed, zoom, onError }: WebGPUCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const handleRef = useRef<SceneRendererHandle | null>(null)
  const speedRef = useRef(speed)

  // Initialize the renderer once, on mount.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    let angle = 0
    let spins = new Map<Rect, number>()

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
      },
    })
      .then((handle) => {
        if (cancelled) {
          handle.destroy()
          return
        }
        handleRef.current = handle
        handle.setZoom(zoom)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        onError?.(message)
      })

    return () => {
      cancelled = true
      handleRef.current?.destroy()
      handleRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the animation loop's speed reference current without recreating the renderer.
  useEffect(() => {
    speedRef.current = speed
  }, [speed])

  // Push zoom changes to the running renderer.
  useEffect(() => {
    handleRef.current?.setZoom(zoom)
  }, [zoom])

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}
