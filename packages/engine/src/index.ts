// Public entry point for @mvpaint/engine: the scene graph, shapes, camera, SVG loader,
// and both text implementations (MSDF atlas text and outline-tessellated vector text) -
// everything needed to render a 2D scene through createSceneRenderer(), without any
// example/demo content.

export * from './math/AABB'
export * from './math/Matrix4x4'
export * from './math/Quaternion'
export * from './math/Ray'
export * from './math/Transform'
export * from './math/Vector2'
export * from './math/Vector3'
export * from './math/Vector4'

export * from './camera/Camera2D'

export * from './events/NodeEvent'
export * from './events/eventNames'
export * from './events/listenerCensus'
export * from './input/SceneInputDispatcher'
export * from './events/sceneEvents'

export * from './scene/Scene'
export * from './scene/picking'

export * from './shapes/Node'
export * from './shapes/Container'
export * from './shapes/Group'
export * from './shapes/Layer'
export * from './shapes/Shape'
export * from './shapes/zOrder'
export * from './shapes/Circle'
export * from './shapes/CustomShape'
export * from './shapes/ShapeContext'
export * from './shapes/Path'
export * from './shapes/Polyline'
export * from './shapes/Rect'
export * from './shapes/Image'
export * from './shapes/Text'
export * from './shapes/TextBlock'
export * from './shapes/VectorText'

export type { RGBA, Point2, FillPriority, GradientStop, MeshMaterial, MeshSink } from './render/meshFormat'
export { parseColor, type ColorInput, type ColorStopInput } from './render/color'
export type { LineJoin, LineCap, StrokeAlign } from './render/stroke'

export * from './svg/flattenPath'
export * from './svg/loadSvg'

export * from './image/ImageTexture'
export * from './webgpu/ImageTexture'
export * from './image/imageUv'
export * from './image/svgSize'

export * from './webgpu/FontBook'
export * from './text/layout'
export * from './text/textQuad'
export * from './text/textPath'
export * from './text/msdfMetrics'
export * from './text/vectorGlyphs'
export * from './text/PolygonFont'
export * from './text/vectorFonts'

export * from './systems/CanvasResizer'
export * from './webgpu/GpuContext'
export * from './webgpu/FrameRenderer'

export * from './input/inputOptions'
export * from './input/sceneInput'
export * from './input/MarqueeOverlay'
export * from './input/viewport'
export * from './input/cameraControls'
export * from './input/nodeDrag'
export * from './scene/selection'
export * from './shapes/Transformer'
export * from './shapes/transformerMath'
export * from './input/MarqueeTool'

export * from './renderer/adapter'
export * from './renderer/canvasTarget'
export * from './renderer/frameListeners'
export * from './renderer/SceneRendererHandle'
export { createSceneRenderer } from './renderer/createSceneRenderer'
// The WebGPU path's own entry point, for an application that wants it and no fallback.
export { SceneRenderer, createWebGpuSceneRenderer } from './webgpu'
