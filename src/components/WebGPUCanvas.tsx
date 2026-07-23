import { useEffect, useRef } from 'react'
import { createSceneRenderer, type SceneRendererHandle } from '../webgpu/SceneRenderer'

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

  // Initialize the renderer once, on mount.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false

    createSceneRenderer(canvas, { onDeviceError: (message) => onError?.(message) })
      .then((handle) => {
        if (cancelled) {
          handle.destroy()
          return
        }
        handleRef.current = handle
        handle.setSpeed(speed)
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

  // Push speed changes to the running renderer.
  useEffect(() => {
    handleRef.current?.setSpeed(speed)
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
