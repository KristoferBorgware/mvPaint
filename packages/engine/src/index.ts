// Public entry point for @mvpaint/engine: the scene graph, shapes, camera, SVG loader,
// and both text implementations (MSDF atlas text and outline-tessellated vector text) -
// everything needed to render a 2D scene through createSceneRenderer(), without any
// example/demo content.
//
// This entry point carries the one asset the engine ships - the Inter MSDF atlas, so text draws
// out of the box - so it needs a bundler. The device-free, asset-free subset of it - geometry,
// metrics, the style ladder, the outline tessellator - is also published on its own as
// '@mvpaint/engine/core', for the things that cannot have one. See core.ts.
//
// Outlines for VectorText are NOT here: a polygon atlas is an application's asset, supplied
// through the VectorFonts interface (see text/vectorGlyphs.ts). @mvpaint/assets is this
// repository's own, and @mvpaint/ttf is the runtime-parsing alternative.

export * from './core'

export * from './math/AABB'
export * from './math/Matrix4x4'
export * from './math/Quaternion'
export * from './math/Ray'
export * from './math/Transform'
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

export type { RGBA, FillPriority, GradientStop, MeshMaterial, MeshSink } from './render/meshFormat'
export { parseColor, MV_GREEN, type ColorInput, type ColorStopInput } from './render/color'

export * from './svg/loadSvg'

export * from './image/ImageTexture'
export * from './webgpu/ImageTexture'
export * from './image/imageUv'
export * from './image/svgSize'

export * from './webgpu/FontBook'
export * from './webgpu/FontLibrary'
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
