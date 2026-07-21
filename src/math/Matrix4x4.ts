// Matrix4x4 - general 4x4 matrix, WebGPU-native. Storage is column-major and the
// convention is right-handed, column-vector: points multiply on the right, p' = M * p,
// and A.mul(B) is the product A*B (so (A*B)*p runs B first, then A). This is the same
// layout and convention as WGSL, glMatrix and the WebGPU tutorials, so an MVP is
// composed the textbook way - projection * view * model - and its `.m` uploads straight
// into a `mvp * pos` uniform with no transpose (see toGPU()).
//
// Derived from Fungine3D's Core/Matrix4x4.h (a DirectXMath / row-vector type),
// transposed into WebGPU's column-vector convention.

import { Quaternion } from './Quaternion'
import { Vector3 } from './Vector3'
import { Vector4 } from './Vector4'

/** Element accessor for a column-major 16-float array: index col*4 + row. */
function idx(row: number, col: number): number {
  return col * 4 + row
}

export class Matrix4x4 {
  /** 16 floats, column-major (m[col*4 + row]) - WGSL's native layout. */
  readonly m: Float32Array

  constructor(elements?: ArrayLike<number>) {
    this.m = new Float32Array(16)
    if (elements) {
      this.m.set(elements)
    } else {
      this.m[0] = 1
      this.m[5] = 1
      this.m[10] = 1
      this.m[15] = 1
    }
  }

  clone(): Matrix4x4 {
    return new Matrix4x4(this.m)
  }

  get(row: number, col: number): number {
    return this.m[idx(row, col)]
  }

  /** Column-major copy (native storage order). */
  toArray(): number[] {
    return Array.from(this.m)
  }

  /**
   * Buffer to upload to a WGSL uniform consumed as `mvp * pos`. Storage is already
   * column-major / column-vector - identical to WGSL's layout - so this is simply the
   * backing `.m`, with no transpose.
   */
  toGPU(): Float32Array {
    return this.m
  }

  // ---- factories ----
  static identity(): Matrix4x4 {
    return new Matrix4x4()
  }

  static translation(t: Vector3): Matrix4x4 {
    const r = new Matrix4x4()
    r.m[12] = t.x
    r.m[13] = t.y
    r.m[14] = t.z
    return r
  }

  static scaling(s: Vector3): Matrix4x4 {
    const r = new Matrix4x4()
    r.m[0] = s.x
    r.m[5] = s.y
    r.m[10] = s.z
    return r
  }

  static rotationX(a: number): Matrix4x4 {
    const c = Math.cos(a)
    const s = Math.sin(a)
    const r = new Matrix4x4()
    r.m[5] = c
    r.m[6] = s
    r.m[9] = -s
    r.m[10] = c
    return r
  }

  static rotationY(a: number): Matrix4x4 {
    const c = Math.cos(a)
    const s = Math.sin(a)
    const r = new Matrix4x4()
    r.m[0] = c
    r.m[2] = -s
    r.m[8] = s
    r.m[10] = c
    return r
  }

  static rotationZ(a: number): Matrix4x4 {
    const c = Math.cos(a)
    const s = Math.sin(a)
    const r = new Matrix4x4()
    r.m[0] = c
    r.m[1] = s
    r.m[4] = -s
    r.m[5] = c
    return r
  }

  static rotationAxis(axis: Vector3, a: number): Matrix4x4 {
    return Matrix4x4.rotationQuaternion(Quaternion.fromAxisAngle(axis, a))
  }

  static rotationQuaternion(q: Quaternion): Matrix4x4 {
    const { x, y, z, w } = q
    const xx = x * x
    const yy = y * y
    const zz = z * z
    const xy = x * y
    const xz = x * z
    const yz = y * z
    const wx = w * x
    const wy = w * y
    const wz = w * z
    const r = new Matrix4x4()
    r.m[0] = 1 - 2 * (yy + zz)
    r.m[1] = 2 * (xy + wz)
    r.m[2] = 2 * (xz - wy)
    r.m[4] = 2 * (xy - wz)
    r.m[5] = 1 - 2 * (xx + zz)
    r.m[6] = 2 * (yz + wx)
    r.m[8] = 2 * (xz + wy)
    r.m[9] = 2 * (yz - wx)
    r.m[10] = 1 - 2 * (xx + yy)
    return r
  }

  static rotationRollPitchYaw(pitch: number, yaw: number, roll: number): Matrix4x4 {
    return Matrix4x4.rotationQuaternion(Quaternion.fromEuler(pitch, yaw, roll))
  }

  static lookAtRH(eye: Vector3, target: Vector3, up: Vector3): Matrix4x4 {
    return Matrix4x4.lookToRH(eye, target.sub(eye), up)
  }

  static lookToRH(eye: Vector3, dir: Vector3, up: Vector3): Matrix4x4 {
    const zaxis = dir.neg().normalized() // R2
    const xaxis = Vector3.cross(up, zaxis).normalized() // R0
    const yaxis = Vector3.cross(zaxis, xaxis) // R1
    const r = new Matrix4x4()
    r.m[0] = xaxis.x
    r.m[1] = yaxis.x
    r.m[2] = zaxis.x
    r.m[4] = xaxis.y
    r.m[5] = yaxis.y
    r.m[6] = zaxis.y
    r.m[8] = xaxis.z
    r.m[9] = yaxis.z
    r.m[10] = zaxis.z
    r.m[12] = -Vector3.dot(xaxis, eye)
    r.m[13] = -Vector3.dot(yaxis, eye)
    r.m[14] = -Vector3.dot(zaxis, eye)
    r.m[15] = 1
    return r
  }

  static perspectiveFovRH(fovY: number, aspect: number, nearZ: number, farZ: number): Matrix4x4 {
    const sinFov = Math.sin(0.5 * fovY)
    const cosFov = Math.cos(0.5 * fovY)
    const height = cosFov / sinFov
    const width = height / aspect
    const fRange = farZ / (nearZ - farZ)
    const r = new Matrix4x4(new Float32Array(16))
    r.m[0] = width
    r.m[5] = height
    r.m[10] = fRange
    r.m[11] = -1
    r.m[14] = fRange * nearZ
    return r
  }

  static orthographicRH(w: number, h: number, nearZ: number, farZ: number): Matrix4x4 {
    const fRange = 1 / (nearZ - farZ)
    const r = new Matrix4x4()
    r.m[0] = 2 / w
    r.m[5] = 2 / h
    r.m[10] = fRange
    r.m[14] = fRange * nearZ
    r.m[15] = 1
    return r
  }

  // Compose translation, rotation, scale (column-vector: T * R * S, so a point is
  // scaled, then rotated, then translated).
  static trs(translation: Vector3, rotation: Quaternion, scale: Vector3): Matrix4x4 {
    return Matrix4x4.translation(translation)
      .mul(Matrix4x4.rotationQuaternion(rotation))
      .mul(Matrix4x4.scaling(scale))
  }

  // ---- operations ----
  // Matrix product this * r. Applied to a point, (this * r) * p runs r first, then this.
  mul(rhs: Matrix4x4): Matrix4x4 {
    const a = this.m
    const b = rhs.m
    const out = new Float32Array(16)
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let sum = 0
        for (let k = 0; k < 4; k++) {
          sum += a[idx(i, k)] * b[idx(k, j)]
        }
        out[idx(i, j)] = sum
      }
    }
    return new Matrix4x4(out)
  }

  transpose(): Matrix4x4 {
    const a = this.m
    const out = new Float32Array(16)
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        out[idx(j, i)] = a[idx(i, j)]
      }
    }
    return new Matrix4x4(out)
  }

  determinant(): number {
    const m = this.m
    const m00 = m[0]
    const m01 = m[1]
    const m02 = m[2]
    const m03 = m[3]
    const m10 = m[4]
    const m11 = m[5]
    const m12 = m[6]
    const m13 = m[7]
    const m20 = m[8]
    const m21 = m[9]
    const m22 = m[10]
    const m23 = m[11]
    const m30 = m[12]
    const m31 = m[13]
    const m32 = m[14]
    const m33 = m[15]

    const b00 = m00 * m11 - m01 * m10
    const b01 = m00 * m12 - m02 * m10
    const b02 = m00 * m13 - m03 * m10
    const b03 = m01 * m12 - m02 * m11
    const b04 = m01 * m13 - m03 * m11
    const b05 = m02 * m13 - m03 * m12
    const b06 = m20 * m31 - m21 * m30
    const b07 = m20 * m32 - m22 * m30
    const b08 = m20 * m33 - m23 * m30
    const b09 = m21 * m32 - m22 * m31
    const b10 = m21 * m33 - m23 * m31
    const b11 = m22 * m33 - m23 * m32

    return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  }

  inverse(): Matrix4x4 {
    const m = this.m
    const m00 = m[0]
    const m01 = m[1]
    const m02 = m[2]
    const m03 = m[3]
    const m10 = m[4]
    const m11 = m[5]
    const m12 = m[6]
    const m13 = m[7]
    const m20 = m[8]
    const m21 = m[9]
    const m22 = m[10]
    const m23 = m[11]
    const m30 = m[12]
    const m31 = m[13]
    const m32 = m[14]
    const m33 = m[15]

    const b00 = m00 * m11 - m01 * m10
    const b01 = m00 * m12 - m02 * m10
    const b02 = m00 * m13 - m03 * m10
    const b03 = m01 * m12 - m02 * m11
    const b04 = m01 * m13 - m03 * m11
    const b05 = m02 * m13 - m03 * m12
    const b06 = m20 * m31 - m21 * m30
    const b07 = m20 * m32 - m22 * m30
    const b08 = m20 * m33 - m23 * m30
    const b09 = m21 * m32 - m22 * m31
    const b10 = m21 * m33 - m23 * m31
    const b11 = m22 * m33 - m23 * m32

    const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
    if (det === 0) return Matrix4x4.identity()
    const invDet = 1 / det

    const out = new Float32Array(16)
    out[0] = (m11 * b11 - m12 * b10 + m13 * b09) * invDet
    out[1] = (-m01 * b11 + m02 * b10 - m03 * b09) * invDet
    out[2] = (m31 * b05 - m32 * b04 + m33 * b03) * invDet
    out[3] = (-m21 * b05 + m22 * b04 - m23 * b03) * invDet
    out[4] = (-m10 * b11 + m12 * b08 - m13 * b07) * invDet
    out[5] = (m00 * b11 - m02 * b08 + m03 * b07) * invDet
    out[6] = (-m30 * b05 + m32 * b02 - m33 * b01) * invDet
    out[7] = (m20 * b05 - m22 * b02 + m23 * b01) * invDet
    out[8] = (m10 * b10 - m11 * b08 + m13 * b06) * invDet
    out[9] = (-m00 * b10 + m01 * b08 - m03 * b06) * invDet
    out[10] = (m30 * b04 - m31 * b02 + m33 * b00) * invDet
    out[11] = (-m20 * b04 + m21 * b02 - m23 * b00) * invDet
    out[12] = (-m10 * b09 + m11 * b07 - m12 * b06) * invDet
    out[13] = (m00 * b09 - m01 * b07 + m02 * b06) * invDet
    out[14] = (-m30 * b03 + m31 * b01 - m32 * b00) * invDet
    out[15] = (m20 * b03 - m21 * b01 + m22 * b00) * invDet
    return new Matrix4x4(out)
  }

  // Transform a position: M * (x,y,z,1), then perspective-divide by w.
  transformPoint(p: Vector3): Vector3 {
    const m = this.m
    const x = p.x * m[0] + p.y * m[4] + p.z * m[8] + m[12]
    const y = p.x * m[1] + p.y * m[5] + p.z * m[9] + m[13]
    const z = p.x * m[2] + p.y * m[6] + p.z * m[10] + m[14]
    const w = p.x * m[3] + p.y * m[7] + p.z * m[11] + m[15]
    const inv = w !== 0 ? 1 / w : 1
    return new Vector3(x * inv, y * inv, z * inv)
  }

  // Transform a direction: M * (x,y,z,0) (ignores translation, no divide).
  transformDirection(d: Vector3): Vector3 {
    const m = this.m
    return new Vector3(
      d.x * m[0] + d.y * m[4] + d.z * m[8],
      d.x * m[1] + d.y * m[5] + d.z * m[9],
      d.x * m[2] + d.y * m[6] + d.z * m[10],
    )
  }

  // Full 4-component transform: M * v (no divide).
  transformVector4(v: Vector4): Vector4 {
    const m = this.m
    return new Vector4(
      v.x * m[0] + v.y * m[4] + v.z * m[8] + v.w * m[12],
      v.x * m[1] + v.y * m[5] + v.z * m[9] + v.w * m[13],
      v.x * m[2] + v.y * m[6] + v.z * m[10] + v.w * m[14],
      v.x * m[3] + v.y * m[7] + v.z * m[11] + v.w * m[15],
    )
  }

  // Decompose into scale, rotation, translation. Returns null if the matrix is
  // not decomposable (zero scale on some axis). Shear is not recoverable.
  decompose(): { scale: Vector3; rotation: Quaternion; translation: Vector3 } | null {
    const m = this.m
    const translation = new Vector3(m[12], m[13], m[14])

    // The upper-3x3 basis vectors (as laid out in storage); their lengths are the scales.
    let r0 = new Vector3(m[0], m[1], m[2])
    let r1 = new Vector3(m[4], m[5], m[6])
    let r2 = new Vector3(m[8], m[9], m[10])

    let sx = r0.length()
    let sy = r1.length()
    let sz = r2.length()

    // A negative determinant means the basis is mirrored; flip one axis so the
    // remaining rotation is a proper (right-handed) rotation.
    const det =
      m[0] * (m[5] * m[10] - m[6] * m[9]) -
      m[1] * (m[4] * m[10] - m[6] * m[8]) +
      m[2] * (m[4] * m[9] - m[5] * m[8])
    if (det < 0) {
      sx = -sx
    }

    if (sx === 0 || sy === 0 || sz === 0) return null

    r0 = r0.div(sx)
    r1 = r1.div(sy)
    r2 = r2.div(sz)

    // Build the pure-rotation matrix and convert to a quaternion (Shepperd's method,
    // matching the convention of rotationQuaternion()).
    const r00 = r0.x
    const r01 = r0.y
    const r02 = r0.z
    const r10 = r1.x
    const r11 = r1.y
    const r12 = r1.z
    const r20 = r2.x
    const r21 = r2.y
    const r22 = r2.z

    const trace = r00 + r11 + r22
    let qx: number
    let qy: number
    let qz: number
    let qw: number
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1)
      qw = 0.25 / s
      qx = (r12 - r21) * s
      qy = (r20 - r02) * s
      qz = (r01 - r10) * s
    } else if (r00 > r11 && r00 > r22) {
      const s = 2 * Math.sqrt(1 + r00 - r11 - r22)
      qw = (r12 - r21) / s
      qx = 0.25 * s
      qy = (r01 + r10) / s
      qz = (r02 + r20) / s
    } else if (r11 > r22) {
      const s = 2 * Math.sqrt(1 + r11 - r00 - r22)
      qw = (r20 - r02) / s
      qx = (r01 + r10) / s
      qy = 0.25 * s
      qz = (r12 + r21) / s
    } else {
      const s = 2 * Math.sqrt(1 + r22 - r00 - r11)
      qw = (r01 - r10) / s
      qx = (r02 + r20) / s
      qy = (r12 + r21) / s
      qz = 0.25 * s
    }

    return {
      scale: new Vector3(sx, sy, sz),
      rotation: new Quaternion(qx, qy, qz, qw).normalized(),
      translation,
    }
  }
}
