// Orbit (arcball) camera: rotates around a fixed focal point as if attached to a
// sphere centred on it. TypeScript port of Fungine3D's Graphics/OrbitCamera.h/.cpp.
// Dragging tumbles the camera over the sphere; wheel notches change `distance` (zoom).
//
// Orientation is azimuth (yaw) + elevation (pitch), radians. Elevation is clamped just
// short of the poles so the view never degenerates - no gimbal lock, no roll.

import { Camera } from './Camera'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Vector3 } from '../math/Vector3'

const DEG2RAD = Math.PI / 180

// Per-frame orbit input. Free of DOM types.
export interface OrbitInput {
  orbitX?: number // drag dx in pixels (0 unless dragging)
  orbitY?: number // drag dy in pixels
  zoom?: number // wheel notches (+ = zoom in)
}

export class OrbitCamera extends Camera {
  // Focal point the camera orbits.
  focus = new Vector3(0, 0, 0)

  // Tunables.
  distance = 20.0 // zoom: distance from the focal point
  minDistance = 1.0
  maxDistance = 200.0
  orbitSensitivity = 0.01 // radians per pixel of drag
  zoomSensitivity = 0.1 // fraction of distance per wheel notch
  maxPitch = 89 * DEG2RAD // clamp near poles

  private yaw = 0 // azimuth about world +Y
  private pitch = 0 // elevation about the orbit's right axis

  // Camera position on the sphere for the current yaw/pitch/distance.
  private eyePosition(): Vector3 {
    // Direction from the focus out to the camera. elevate about right first, then swing
    // about world up. Back() = {0,0,1}, so at yaw=pitch=0 the camera sits on +Z.
    const q = Quaternion.fromAxisAngle(Vector3.right(), this.pitch).mul(
      Quaternion.fromAxisAngle(Vector3.up(), this.yaw),
    )
    const dir = q.rotateVector(Vector3.back())
    return this.focus.add(dir.mul(this.distance))
  }

  update(input: OrbitInput): void {
    const orbitX = input.orbitX ?? 0
    const orbitY = input.orbitY ?? 0
    const zoom = input.zoom ?? 0

    // Drag tumbles the camera over the sphere; negate here to invert an axis.
    this.yaw -= orbitX * this.orbitSensitivity
    this.pitch += orbitY * this.orbitSensitivity
    this.pitch = Math.max(-this.maxPitch, Math.min(this.maxPitch, this.pitch)) // off the poles

    // Wheel zoom is multiplicative so it feels even at any distance.
    if (zoom !== 0) {
      this.distance *= 1 - zoom * this.zoomSensitivity
      this.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.distance))
    }

    this.eye = this.eyePosition() // keep the base member in sync
  }

  view(): Matrix4x4 {
    return Matrix4x4.lookAtRH(this.eyePosition(), this.focus, Vector3.up())
  }
}
