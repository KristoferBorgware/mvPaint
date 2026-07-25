// Ray - an origin + (unit) direction, with a slab test against an AABB. Reuses
// Vector3 and AABB. Right-handed, same space as everything else.

import type { AABB } from './AABB'
import { Vector3 } from './Vector3'

const FLT_MAX = 3.402823466e38

/** Result of a successful ray/AABB intersection. */
export interface RayHit {
  /** Entry distance along the ray (>= 0). */
  t: number
  /** Outward normal of the entered face; zero if the origin is inside the box. */
  normal: Vector3
}

export class Ray {
  origin: Vector3
  direction: Vector3 // assumed normalized

  constructor(origin: Vector3 = new Vector3(0, 0, 0), direction: Vector3 = new Vector3(0, 0, -1)) {
    this.origin = origin
    this.direction = direction
  }

  at(t: number): Vector3 {
    return this.origin.add(this.direction.mul(t))
  }

  // Slab intersection. Returns the hit (entry distance and outward face normal) or
  // null on a miss. On an inside-origin hit, t is 0 and the normal is zero. Handles
  // axis-parallel rays and zero-thickness boxes.
  intersectAABB(box: AABB): RayHit | null {
    const o = [this.origin.x, this.origin.y, this.origin.z]
    const d = [this.direction.x, this.direction.y, this.direction.z]
    const mn = [box.min.x, box.min.y, box.min.z]
    const mx = [box.max.x, box.max.y, box.max.z]

    let tmin = 0.0 // clamp entry to 0 so an inside origin hits at t=0
    let tmax = FLT_MAX
    let hitAxis = -1
    let hitSign = 0.0

    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-8) {
        // Parallel to this slab: miss unless the origin is within it.
        if (o[i] < mn[i] || o[i] > mx[i]) return null
        continue
      }
      const inv = 1.0 / d[i]
      let t1 = (mn[i] - o[i]) * inv // near face
      let t2 = (mx[i] - o[i]) * inv // far face
      let sign = -1.0 // entering via the min face
      if (t1 > t2) {
        const tmp = t1
        t1 = t2
        t2 = tmp
        sign = 1.0 // ... or the max face
      }
      if (t1 > tmin) {
        tmin = t1
        hitAxis = i
        hitSign = sign
      }
      if (t2 < tmax) tmax = t2
      if (tmin > tmax) return null
    }

    const normal = Vector3.zero()
    if (hitAxis === 0) normal.x = hitSign
    else if (hitAxis === 1) normal.y = hitSign
    else if (hitAxis === 2) normal.z = hitSign
    return { t: tmin, normal }
  }
}
