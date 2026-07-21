// No-clip fly FPS camera: a free-moving observer. TypeScript port of Fungine3D's
// Graphics/FreeFloatCamera.h/.cpp.
//
// Controls (mapped by FreeFlyController): WASD moves; W/S fly along the full look
// direction (look up/down to change altitude - there are no dedicated up/down keys),
// A/D strafe along the horizontal right axis, Shift moves faster. Mouse motion changes
// the look direction (yaw + pitch) while mouse-look is active.
//
// Orientation is a yaw + pitch pair (radians). Pitch is clamped just short of vertical
// so the view never flips - the classic singularity-free yaw/pitch model (no gimbal
// lock, no roll).

import { Camera } from './Camera'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Quaternion } from '../math/Quaternion'
import { Vector3 } from '../math/Vector3'

const DEG2RAD = Math.PI / 180

// Per-frame camera input. Kept free of DOM types so the camera stays testable.
export interface CameraInput {
  moveForward?: number // +W / -S  (-1..1): along the full look direction
  moveRight?: number // +D / -A  (-1..1): along the horizontal right axis
  lookX?: number // mouse dx in pixels (0 unless mouse-look is active)
  lookY?: number // mouse dy in pixels
  fast?: boolean // Shift: move at fastMultiplier speed
}

export class FreeFloatCamera extends Camera {
  // Tunables.
  moveSpeed = 12.0 // world units / second
  fastMultiplier = 4.0 // speed factor while `fast` is held
  lookSensitivity = 0.0025 // radians per pixel of mouse motion
  maxPitch = 89 * DEG2RAD // clamp: no flip

  private yaw = 0
  private pitch = 0

  // Orientation as yaw (about world +Y) and pitch (about local right). Applying pitch
  // first, then yaw, keeps pitch as a stable elevation at any heading.
  private orientation(): Quaternion {
    // a.mul(b) == "a applied first, then b": pitch about local right, then yaw about up.
    return Quaternion.fromAxisAngle(Vector3.right(), this.pitch).mul(
      Quaternion.fromAxisAngle(Vector3.up(), this.yaw),
    )
  }

  // Advance the camera by dt seconds given this frame's input.
  update(dt: number, input: CameraInput): void {
    const lookX = input.lookX ?? 0
    const lookY = input.lookY ?? 0
    const moveForward = input.moveForward ?? 0
    const moveRight = input.moveRight ?? 0

    // Mouse-look. Right/down mouse motion turns the view right/down (non-inverted).
    this.yaw -= lookX * this.lookSensitivity
    this.pitch -= lookY * this.lookSensitivity
    this.pitch = Math.max(-this.maxPitch, Math.min(this.maxPitch, this.pitch)) // never vertical
    this.yaw %= Math.PI * 2 // keep yaw bounded without changing the orientation

    const q = this.orientation()
    const forward = q.rotateVector(Vector3.forward())
    // Horizontal strafe axis (perpendicular to forward, level with the ground).
    const right = Vector3.cross(forward, Vector3.up()).safeNormalized()

    // No-clip translation along the look direction; W/S carry forward's vertical
    // component, so looking up/down changes altitude. safeNormalized keeps diagonal
    // motion from being faster and is a zero no-op when there is no input.
    const move = forward.mul(moveForward).add(right.mul(moveRight))
    const speed = this.moveSpeed * (input.fast ? this.fastMultiplier : 1)
    this.eye = this.eye.add(move.safeNormalized().mul(speed * dt))
  }

  view(): Matrix4x4 {
    const forward = this.orientation().rotateVector(Vector3.forward())
    return Matrix4x4.lookToRH(this.eye, forward, Vector3.up())
  }
}
