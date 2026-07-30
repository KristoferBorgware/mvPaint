// Scene - owns the scene-graph root. Nothing else: a scene is the content, and where it is
// looked at from is a Camera2D the application supplies to the renderer (see
// webgpu/SceneRenderer). Keeping the camera out means one scene can be drawn through
// several at once, and that adding content can never disturb the view.

import { Container } from '../shapes/Container'

export class Scene {
  readonly root = new Container('root')
}
