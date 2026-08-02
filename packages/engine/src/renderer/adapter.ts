// Which GPU drew the frame, and the one lever there is for choosing it.
//
// THERE IS NO DEVICE LIST. Neither WebGPU nor WebGL lets a page enumerate the GPUs in a
// machine and pick one by name - that is a deliberate omission, because a list of exact
// hardware is a strong fingerprint. What both give instead is a HINT with two settings, and
// the browser maps it onto whatever adapters it has:
//
//   'high-performance'  the discrete card, on a machine that has one
//   'low-power'         the integrated one
//
// So a laptop with an Intel iGPU and an NVIDIA card can be steered from one to the other, and
// that is the whole of the control available. It is a hint and not an instruction: a machine
// with one GPU ignores it, and so does one whose browser has already been pinned elsewhere -
// on Windows, Chrome's GPU process follows the per-app setting in Windows Graphics Settings
// and in the vendor's own control panel, and no page can override that from inside. If the
// hint appears to do nothing, chrome://gpu says which adapter the browser itself is on, and
// that is the setting to change.
//
// The default here is 'high-performance', which is NOT the platform default. The platform
// defaults to letting the browser choose, and browsers choose the integrated GPU: the right
// call for a page that draws a form, and the wrong one for a renderer whose whole premise is
// putting a hundred thousand shapes through a depth-tested pass. An application that would
// rather have the battery says so with `powerPreference: 'low-power'`.
//
// What came back is reported rather than assumed - see RendererAdapter, and handle.adapter.
// A hint that was not honoured is invisible otherwise, and "it runs at 12fps on my desktop"
// is a much harder report to act on than the same sentence with an adapter string attached.

/** The hint passed to both paths when acquiring a context. */
export type GpuPowerPreference = 'high-performance' | 'low-power'

/**
 * What the browser was willing to say about the GPU it actually gave us.
 *
 * Every field is best effort and may be an empty string: this is fingerprinting surface, so
 * browsers redact it to varying degrees (Firefox and private-browsing modes withhold the most,
 * and WebGPU's `adapter.info` is deliberately coarser than the raw driver string WebGL's
 * debug extension exposes). Nothing in the engine branches on any of it - it exists to be
 * shown to a person.
 */
export interface RendererAdapter {
  /** What was ASKED for. Whether it was honoured is what the rest of this record answers. */
  readonly powerPreference: GpuPowerPreference
  /** e.g. 'nvidia', 'intel', 'apple'. */
  readonly vendor: string
  /** The GPU family, e.g. 'blackwell', 'gen-12lp'. WebGPU only. */
  readonly architecture: string
  /** A vendor-specific model identifier, e.g. a PCI device id. WebGPU only. */
  readonly device: string
  /** The driver's own free-form description, which is usually the most readable of the lot. */
  readonly description: string
  /**
   * True when what came back is a SOFTWARE renderer - SwiftShader, llvmpipe, WARP. The scene
   * will draw correctly and slowly, which looks exactly like a performance bug in the engine
   * until you know. Both paths warn once at startup when this is set.
   */
  readonly fallback: boolean
}

/**
 * A one-line summary for a log or a debug panel; never empty.
 *
 * The driver's own description wins outright when there is one, because it already names the
 * vendor and the part - 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 ...)' gains nothing from
 * having 'NVIDIA' appended to it. The other two fields are the fallback for WebGPU, which
 * often gives a family and a vendor and no description at all.
 */
export function describeAdapter(adapter: RendererAdapter): string {
  const suffix = adapter.fallback ? ' (software)' : ''
  if (adapter.description.length > 0) return `${adapter.description}${suffix}`

  const parts = [adapter.vendor, adapter.architecture].filter((part) => part.length > 0)
  return `${parts.length > 0 ? parts.join(' ') : 'GPU not disclosed'}${suffix}`
}
