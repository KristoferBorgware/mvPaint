// Public entry point for @mvpaint/engine: the scene graph, shapes, camera, SVG loader,
// and both text implementations (MSDF atlas text and outline-tessellated vector text) -
// everything needed to render a 2D scene through createSceneRenderer(), without any
// example/demo content.
//
// This entry point reaches the render paths, so it assumes a bundler. The device-free subset -
// geometry, metrics, the style ladder, the outline tessellator - is also published on its own as
// '@mvpaint/engine/core', for the things that cannot have one. See core.ts.
//
// NO TYPEFACE OF ANY KIND is here. The engine ships none: both text implementations draw from
// assets an application supplies and registers under a name (see resources/FontRegistry.ts), so
// a family nothing was registered under draws nothing. packages/example-app serves this
// repository's atlases, and @mvpaint/ttf parses a font file at runtime.

export * from './core'

export * from './math/AABB'
export * from './math/angle'
export * from './math/Matrix4x4'
export * from './math/Quaternion'
export * from './math/Ray'
export * from './math/Transform'
export * from './math/Vector3'
export * from './math/Vector4'

export * from './camera/Camera2D'
export * from './camera/cameraTween'

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
export * from './shapes/curvePoints'
export * from './shapes/Rect'
export * from './shapes/Image'
export * from './shapes/MSDFText'
export * from './shapes/Text'
export * from './shapes/VectorText'
export * from './shapes/singleRun'
export * from './shapes/UniformMSDFText'
export * from './shapes/UniformVectorText'

export * from './tween/Tween'
export * from './tween/TweenTimeline'
export * from './tween/easings'
export * from './tween/ticker'

export * from './render/nonzero'
export type { RGBA, FillPriority, GradientStop, MeshMaterial, MeshSink } from './render/meshFormat'
export { parseColor, MV_GREEN, type ColorInput, type ColorStopInput } from './render/color'

export * from './svg/loadSvg'

export * from './image/ImageTexture'
export * from './resources/cachingImageFactory'
export * from './webgpu/ImageTexture'
export * from './image/imageUv'
export * from './image/svgSize'

export * from './webgpu/MSDFFontBook'
export * from './webgpu/MSDFFontLibrary'
export * from './text/textQuad'
export * from './text/textPath'

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
export * from './serialize/nodeRegistry'
export * from './serialize/serialize'
export * from './shapes/Transformer'
export * from './shapes/transformerMath'
export * from './input/MarqueeTool'

export * from './systems/adapter'
export * from './systems/canvasTarget'
export * from './systems/frameListeners'
export * from './systems/SceneRendererHandle'
export { createSceneRenderer } from './systems/createSceneRenderer'
// The WebGPU path's own entry point, for an application that wants it and no fallback.
export { SceneRenderer, createWebGpuSceneRenderer } from './webgpu'
