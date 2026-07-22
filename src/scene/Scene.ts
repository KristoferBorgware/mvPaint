// Scene - owns the scene-graph root and resolves the active camera by traversing the
// tree for the Camera whose `active` flag is set. TypeScript port of the scene-graph
// parts of Fungine3D's Scene/Scene.h/.cpp; the GameObject/MeshComponent/Renderer-driven
// Update(), Render() and WorldBounds() are intentionally omitted (no GameObjects or
// components in this port).

import { Node } from './Node'
import { Camera } from '../camera/Camera'

export class Scene {
  readonly root = new Node('root')

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
