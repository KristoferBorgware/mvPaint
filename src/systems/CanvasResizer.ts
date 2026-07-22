// System component: keeps a canvas's backing-store size in sync with its CSS size,
// accounting for device pixel ratio. Watches the element with a ResizeObserver and
// also exposes update() so a render loop can re-check each frame (ResizeObserver does
// not fire on DPR-only changes, e.g. dragging the window between monitors).

export interface CanvasResizerOptions {
  /** Cap on device pixel ratio, to bound the backing-store resolution. */
  maxDevicePixelRatio?: number
}

export class CanvasResizer {
  /** Current backing-store size in physical pixels. */
  width = 1
  height = 1

  private readonly canvas: HTMLCanvasElement
  private readonly maxDpr: number
  private readonly observer: ResizeObserver

  constructor(canvas: HTMLCanvasElement, options: CanvasResizerOptions = {}) {
    this.canvas = canvas
    this.maxDpr = options.maxDevicePixelRatio ?? 2
    this.observer = new ResizeObserver(() => this.update())
    this.observer.observe(canvas)
    this.update()
  }

  /** Recompute the backing-store size from CSS size * DPR; resizes the canvas if needed. */
  update(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr)
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr))
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr))
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height
    }
    this.width = this.canvas.width
    this.height = this.canvas.height
  }

  dispose(): void {
    this.observer.disconnect()
  }
}
