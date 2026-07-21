import { useEffect, useRef } from 'react'
import { createCubeRenderer, type CubeRendererHandle } from '../webgpu/CubeRenderer'

interface WebGPUCanvasProps {
  /** Spin speed in radians/second. Updated live without recreating the renderer. */
  speed: number
  /** Called with a human-readable message if WebGPU initialization fails. */
  onError?: (message: string) => void
}

export function WebGPUCanvas({ speed, onError }: WebGPUCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const handleRef = useRef<CubeRendererHandle | null>(null)

  // Initialize the renderer once, on mount.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false

    createCubeRenderer(canvas)
      .then((handle) => {
        if (cancelled) {
          handle.destroy()
          return
        }
        handleRef.current = handle
        handle.setSpeed(speed)
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

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}
