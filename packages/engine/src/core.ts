// The half of @mvpaint/engine that runs anywhere: geometry, glyph metrics, the style ladder and
// the outline tessellator. No device, no canvas, and - the point of the split - no assets.
//
// The main entry point imports the four MSDF atlas PNGs and the four polygon atlases as `?url`,
// which only a bundler resolves. That is right for an application, and fatal for everything that
// is not one: @mvpaint/ttf and its self-test, the offline atlas generators in packages/scripts
// (run under tsx), and any application code that wants to shape or measure text before a device
// exists. Those import this entry point instead - `@mvpaint/engine/core` - and get plain modules
// node can load.
//
// Everything here is also exported from the main entry point, so an application never has to
// choose: import '@mvpaint/engine' and this is part of it.

export * from './math/Vector2'

export * from './svg/flattenPath'

// Contour is the shape @mvpaint/ttf hands its flattened glyph rings back in - the contract
// between the two packages, not an internal.
export type { LineJoin, LineCap, StrokeAlign, Contour } from './render/stroke'

export * from './text/msdfMetrics'
// The style table. resolveStyle is how every text path picks a face for a requested style, and
// sharing it is what keeps a runtime-parsed font falling back the same way a baked atlas does.
export { STYLE_ORDER, resolveStyle, type FontStyle } from './text/msdfProvider'
export * from './text/layout'
export * from './text/vectorGlyphs'
export * from './text/PolygonFont'
