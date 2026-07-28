// OrthographicCamera - a 2D-in-3D camera. Positioned on +Z looking down the -Z axis
// (depth), with X = left/right and Y = up/down. Uses an orthographic projection (no
// perspective foreshortening) sized by a vertical extent in world units, so content in
// the Z=0 plane renders like a 2D canvas while still living in 3D space.

import { Camera } from './Camera'
import { AABB } from '../math/AABB'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Vector3 } from '../math/Vector3'

export class OrthographicCamera extends Camera {
  /** Vertical extent of the view volume, in world units (a zoom control). */
  viewHeight = 10

  constructor(name = '') {
    super(name)
    // Look down -Z from +Z; X right, Y up.
    this.eye = new Vector3(0, 0, 10)
    this.target = new Vector3(0, 0, 0)
    this.up = new Vector3(0, 1, 0)
    this.nearZ = 0.1
    this.farZ = 100
  }

  protected override attrKeys(): readonly string[] {
    return [...super.attrKeys(), 'viewHeight']
  }

  // Orthographic projection: width follows the aspect ratio so pixels stay square.
  override proj(aspect: number): Matrix4x4 {
    return Matrix4x4.orthographicRH(this.viewHeight * aspect, this.viewHeight, this.nearZ, this.farZ)
  }

  /**
   * The camera's current view rectangle in world space - an orthographic camera's
   * frustum IS just an axis-aligned box centered on the camera, no plane/frustum math
   * needed. Used for viewport culling (see scene/culling.ts): whatever doesn't overlap
   * this box isn't worth drawing.
   *
   * Z spans +-Infinity rather than the "real" 0 every 2D shape's world bounds sits at:
   * AABB.expanded() (the cull-margin debug knob) shrinks EVERY axis, and a margin big
   * enough to go negative on a zero-thickness Z range inverts it (min > max), which
   * makes AABB.intersects() reject every shape's Z on its own, regardless of X/Y overlap
   * - i.e. everything vanishes as soon as the margin goes negative. Z was never a real
   * constraint for a 2D scene to begin with, so making it unbounded here is the correct
   * fix, not a workaround: only X/Y ever decide "on screen" for this camera.
   */
  viewBounds(aspect: number): AABB {
    const halfHeight = this.viewHeight / 2
    const halfWidth = halfHeight * aspect
    return new AABB(
      new Vector3(this.eye.x - halfWidth, this.eye.y - halfHeight, -Infinity),
      new Vector3(this.eye.x + halfWidth, this.eye.y + halfHeight, Infinity),
    )
  }
}
