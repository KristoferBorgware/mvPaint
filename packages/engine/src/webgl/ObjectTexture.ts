// The per-object records, as a texture, because WebGL2 has no storage buffers.
//
// THE PROBLEM. The whole engine rests on one idea: a shape's triangles are packed once in its
// own coordinates, each vertex carries an integer object id, and the shader looks that
// object's matrix and material up in a big array. Moving a shape rewrites one record and
// touches no geometry. On WebGPU that array is a read-only storage buffer. WebGL2 has none -
// storage buffers arrived in GLES 3.1 and WebGL2 is GLES 3.0.
//
// A uniform buffer cannot stand in: a mesh record is 304 bytes and the guaranteed UBO size is
// 16 KB, so about fifty objects. The scenes this draws have thousands.
//
// So: an RGBA32F texture, read with texelFetch. Every record stride in this engine is already
// a multiple of 16 bytes (mesh 304, text 320, image 96, shadow 128), so a record is a whole
// number of texels - 19 of them for a mesh object - and the records tile the texture in order
// with no padding anywhere. texelFetch takes integer coordinates and ignores filtering
// entirely, so this needs no float-filtering extension; and the texture is only ever sampled,
// never rendered to, so it needs no float-render extension either. Nothing to feature-detect.
//
// WIDTH IS FIXED, deliberately. A row of 1024 texels holds ~53 mesh records, so the tens of
// thousands of objects this path is for come to a few hundred rows - nowhere near any device's
// limit, and there is no growth logic to write or to get wrong. It is a uniform rather than a
// compile-time constant only so the number lives in one place.
//
// INTEGERS ARE STORED AS FLOATS. fillType, stopCount and their kind are u32 in the WebGPU
// record, and reading those bits back through a float texture would hand the shader a
// denormal - 2u is 2.8e-45 - which some GPUs flush straight to zero. So this path writes them
// as ordinary floats and the shader reads them as ordinary floats. They are all small counts
// and enum codes, exactly representable, and it costs nothing: this staging array is the
// fallback's own, and never shared with the WebGPU one.

/** Texels per record - every record stride in this engine is a multiple of 16 bytes. */
export function recordTexels(strideBytes: number): number {
  if (strideBytes % 16 !== 0) {
    throw new Error(`ObjectTexture: a ${strideBytes}-byte record is not a whole number of RGBA32F texels`)
  }
  return strideBytes / 16
}

/** Texels per row. See the header - fixed on purpose. */
export const OBJECT_TEXTURE_WIDTH = 1024

/**
 * Rows spanned by `count` records - i.e. the texture's height, and the length the staging
 * array has to be padded to so the last partial row is still fully addressable.
 */
export function rowsFor(count: number, texelsPerRecord: number): number {
  return Math.max(1, Math.ceil((count * texelsPerRecord) / OBJECT_TEXTURE_WIDTH))
}

/**
 * The half-open row range holding records `[start, end)`.
 *
 * Uploads go a whole row at a time: texSubImage2D takes a rectangle, and a record range is
 * almost never row-aligned. Rounding outward re-sends at most one row's worth of untouched
 * texels at each end - the same trade the WebGPU path already makes when it merges dirty
 * slots within eight of each other rather than issuing two writes.
 */
export function rowRangeFor(start: number, end: number, texelsPerRecord: number): { row: number; rows: number } {
  const firstTexel = start * texelsPerRecord
  const lastTexel = end * texelsPerRecord // exclusive
  const row = Math.floor(firstTexel / OBJECT_TEXTURE_WIDTH)
  const rowEnd = Math.ceil(lastTexel / OBJECT_TEXTURE_WIDTH)
  return { row, rows: Math.max(1, rowEnd - row) }
}

/**
 * One lane's object records on the GPU: the staging floats the lane writes into, and the
 * texture they upload to.
 */
export class ObjectTexture {
  readonly texelsPerRecord: number
  /** Row-major RGBA32F texels, padded to whole rows. The lane writes records into this. */
  data: Float32Array

  private readonly gl: WebGL2RenderingContext
  private readonly label: string
  private texture: WebGLTexture | null = null
  private rows = 0
  private capacity = 0

  constructor(gl: WebGL2RenderingContext, strideBytes: number, label: string) {
    this.gl = gl
    this.label = label
    this.texelsPerRecord = recordTexels(strideBytes)
    this.data = new Float32Array(0)
    this.allocate(1)
  }

  /** Records this can currently hold. */
  get count(): number {
    return this.capacity
  }

  get width(): number {
    return OBJECT_TEXTURE_WIDTH
  }

  /**
   * Size for `count` records, discarding whatever was there.
   *
   * Always reallocates rather than growing in place, because the caller only reaches here on
   * a rebuild - and a rebuild means slot numbering just changed, so nothing previously
   * written to a slot number is still meaningful anyway.
   */
  allocate(count: number): void {
    const gl = this.gl
    this.capacity = Math.max(1, count)
    this.rows = rowsFor(this.capacity, this.texelsPerRecord)
    this.data = new Float32Array(this.rows * OBJECT_TEXTURE_WIDTH * 4)

    if (this.texture) gl.deleteTexture(this.texture)
    this.texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, OBJECT_TEXTURE_WIDTH, this.rows)
    // texelFetch ignores all of this, but a texture is only complete if it is set, and an
    // RGBA32F texture is not filterable without an extension - so NEAREST is also the only
    // legal answer.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  /** Uploads the rows covering records `[start, end)`. */
  uploadRecords(start: number, end: number): void {
    const { row, rows } = rowRangeFor(start, Math.min(end, this.capacity), this.texelsPerRecord)
    this.uploadRows(row, Math.min(rows, this.rows - row))
  }

  /** Uploads everything - the fallback for a frame whose changes are scattered too widely. */
  uploadAll(): void {
    this.uploadRows(0, this.rows)
  }

  private uploadRows(row: number, rows: number): void {
    if (rows <= 0 || !this.texture) return
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      row,
      OBJECT_TEXTURE_WIDTH,
      rows,
      gl.RGBA,
      gl.FLOAT,
      this.data,
      row * OBJECT_TEXTURE_WIDTH * 4,
    )
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  /** Binds to a texture unit, for a shader that will texelFetch it. */
  bind(unit: number): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
  }

  destroy(): void {
    if (this.texture) this.gl.deleteTexture(this.texture)
    this.texture = null
    this.data = new Float32Array(0)
    void this.label
  }
}
