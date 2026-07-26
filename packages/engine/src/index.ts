// Public entry point for @mvpaint/engine: the scene graph, shapes, camera, SVG loader,
// and MSDF text - everything needed to render a 2D scene through createSceneRenderer(),
// without any example/demo content.

export * from './math/AABB'
export * from './math/Matrix4x4'
export * from './math/Quaternion'
export * from './math/Ray'
export * from './math/Transform'
export * from './math/Vector2'
export * from './math/Vector3'
export * from './math/Vector4'

export * from './camera/Camera'
export * from './camera/FreeFloatCamera'
export * from './camera/FreeFlyController'
export * from './camera/OrbitCamera'
export * from './camera/OrthographicCamera'

export * from './scene/Scene'
export * from './scene/picking'

export * from './shapes/Node'
export * from './shapes/Container'
export * from './shapes/Shape'
export * from './shapes/Circle'
export * from './shapes/Path'
export * from './shapes/Polyline'
export * from './shapes/Rect'
export * from './shapes/Text'

export type { RGBA, Point2, FillPriority, GradientStop } from './render/meshFormat'
export type { LineJoin, LineCap } from './render/stroke'

export * from './svg/loadSvg'

export * from './text/FontAtlas'
export * from './text/layout'
export * from './text/msdfMetrics'

export * from './systems/CanvasResizer'
export * from './systems/GpuContext'
export * from './systems/FrameRenderer'

export * from './input/viewport'
export * from './input/cameraControls'
export * from './input/nodeDrag'
export * from './scene/selection'
export * from './shapes/Transformer'
export * from './shapes/transformerMath'
export * from './input/SceneInputController'

export * from './webgpu/SceneRenderer'
