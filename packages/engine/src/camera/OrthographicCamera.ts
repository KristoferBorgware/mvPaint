// OrthographicCamera - a 2D-in-3D camera. Positioned on +Z looking down the -Z axis
// (depth), with X = left/right and Y = up/down. Uses an orthographic projection (no
// perspective foreshortening) sized by a vertical extent in world units, so content in
// the Z=0 plane renders like a 2D canvas while still living in 3D space.

import { Camera } from './Camera'
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

  // Orthographic projection: width follows the aspect ratio so pixels stay square.
  override proj(aspect: number): Matrix4x4 {
    return Matrix4x4.orthographicRH(this.viewHeight * aspect, this.viewHeight, this.nearZ, this.farZ)
  }
}
