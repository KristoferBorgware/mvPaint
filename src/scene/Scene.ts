// Scene - owns the scene-graph root (a Container) and resolves the active camera by
// traversing the tree for the Camera whose `active` flag is set.

import { Container } from './Container'
import { Camera } from '../camera/Camera'

export class Scene {
  readonly root = new Container('root')

  private activeCameraNode: Camera | null = null

  /**
   * Re-resolve the active camera by traversing the graph (pre-order, first match wins).
   * Call at startup and whenever a camera's `active` flag changes.
   */
  refreshActiveCamera(): Camera | null {
    this.activeCameraNode = null
    this.root.traversePreOrder((node) => {
      if (this.activeCameraNode) return
      if (node instanceof Camera && node.active) this.activeCameraNode = node
    })
    return this.activeCameraNode
  }

  get activeCamera(): Camera | null {
    return this.activeCameraNode
  }
}
