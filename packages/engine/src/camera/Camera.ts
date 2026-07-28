// Right-handed perspective camera. Produces view/projection matrices; owns no GPU
// state. Aspect ratio is supplied per-frame by the renderer. Column-vector /
// WebGPU-native, matching src/math. Extends Node, so a camera can live anywhere in
// the scene graph and picks up a world transform from its ancestors.
//
// view() is overridable so derived cameras (e.g. FreeFloatCamera) supply their own
// orientation while sharing the projection. The `active` flag marks which camera the
// scene renders through.

import { Matrix4x4 } from '../math/Matrix4x4'
import { Ray } from '../math/Ray'
import { Vector3 } from '../math/Vector3'
import { Vector4 } from '../math/Vector4'
import { Node } from '../shapes/Node'

export class Camera extends Node {
  override readonly nodeName: string = 'Camera'

  /** The scene renders through the camera whose flag is set. */
  active = false

  eye = new Vector3(0, 7, 18)
  target = new Vector3(0, 3, 0)
  up = new Vector3(0, 1, 0)
  fovY = Math.PI / 4
  nearZ = 0.1
  farZ = 500

  constructor(name = '') {
    super(name)
  }

  view(): Matrix4x4 {
    return Matrix4x4.lookAtRH(this.eye, this.target, this.up)
  }

  proj(aspect: number): Matrix4x4 {
    return Matrix4x4.perspectiveFovRH(this.fovY, aspect, this.nearZ, this.farZ)
  }

  /** Column-vector view-projection: projection * view (clip = viewProj * world). */
  viewProjection(aspect: number): Matrix4x4 {
    return this.proj(aspect).mul(this.view())
  }

  /**
   * World-space ray through a client-area pixel (px, py) for a viewport of the given
   * size. Unprojects through inverse(projection * view); works for any camera since
   * view() is overridable.
   */
  screenPointToRay(px: number, py: number, viewportW: number, viewportH: number): Ray {
    // Pixel -> normalized device coords (WebGPU/D3D: x,y in [-1,1], y flipped, z in [0,1]).
    const ndcX = (2 * px) / viewportW - 1
    const ndcY = 1 - (2 * py) / viewportH

    const invViewProj = this.viewProjection(viewportW / viewportH).inverse()

    // Unproject the near (z=0) and far (z=1) points and perspective-divide by w.
    const nearH = invViewProj.transformVector4(new Vector4(ndcX, ndcY, 0, 1))
    const farH = invViewProj.transformVector4(new Vector4(ndcX, ndcY, 1, 1))
    const nearW = nearH.xyz().div(nearH.w)
    const farW = farH.xyz().div(farH.w)

    return new Ray(nearW, farW.sub(nearW).safeNormalized(Vector3.forward()))
  }

  /** Camera world matrix (inverse view) - the Node localMatrix() seam. */
  override localMatrix(): Matrix4x4 {
    return this.view().inverse()
  }
}
