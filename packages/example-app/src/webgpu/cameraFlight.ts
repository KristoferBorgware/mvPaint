// What a camera flight is aimed AT - the measuring half of the Fit buttons, kept out of the
// component so it can be checked without a canvas.
//
// Flying the view is the engine's business (see cameraTween); deciding what to frame is the
// application's, and it is the half with judgement in it. Two decisions live here:
//
//   - WHAT COUNTS AS THE SCENE. The selection frame, the marquee rectangle and this app's
//     debug overlay are in the same root as the drawing, and are the editor rather than the
//     picture. A "fit the scene" that included them would frame a different box depending on
//     what happened to be selected.
//   - HOW FAR A FIT MAY MAGNIFY. viewForBounds answers arithmetically, and one small shape
//     asks for a zoom of several hundred. A maximum is a matter of taste, so it is set here
//     rather than in the engine, which has no way to know what the box is for.

import { viewForBounds, type ClientRect, type LocalBoundsResolver, type Node, type Viewport } from '@mvpaint/engine'

/** How much viewport a fit leaves around what it frames, in CSS pixels. */
export const FIT_PADDING = 48

/** How far a fit may magnify, whatever the arithmetic asks for. */
export const MAX_FIT_ZOOM = 8

/** Where a flight should end. `zoom` is absent when what was framed has no size to fit. */
export interface FlightPlan {
  center: { x: number; y: number }
  zoom?: number
  rotation: number
}

/** The union of two boxes in the same space. */
export function unionRect(a: ClientRect, b: ClientRect): ClientRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

/**
 * The box a set of nodes covers together, in `relativeTo`'s space, or null if they cover
 * nothing. Nodes with no extent are skipped rather than collapsing the box onto their origin.
 *
 * `boundsOf` is how text is measured: an MSDFText's glyphs live in an atlas the renderer owns,
 * so it cannot measure itself and the caller supplies the resolver (see handle.localBoundsOf).
 */
export function unionBounds(
  nodes: Iterable<Node>,
  relativeTo: Node,
  boundsOf: LocalBoundsResolver,
): ClientRect | null {
  let box: ClientRect | null = null
  for (const node of nodes) {
    if (!node.visible) continue
    const rect = node.getClientRect({ relativeTo, boundsOf })
    if (rect.width === 0 && rect.height === 0) continue
    box = box ? unionRect(box, rect) : rect
  }
  return box
}

/** Everything directly under the root that is the drawing rather than the editor. */
export function sceneContent(children: readonly Node[], furniture: ReadonlySet<Node>): Node[] {
  return children.filter((child) => !furniture.has(child))
}

/**
 * Where the view should go to frame a box: centred on it, zoomed to fit within FIT_PADDING of
 * every edge but no further than MAX_FIT_ZOOM, and upright.
 *
 * Upright because viewForBounds measures an axis-aligned box against an axis-aligned viewport,
 * so a turned view is not the one it solved for - a fit that left the rotation alone would not
 * actually fit.
 */
export function fitPlan(box: ClientRect, viewport: Viewport): FlightPlan {
  const view = viewForBounds(box, viewport, FIT_PADDING)
  return {
    center: view.center,
    zoom: view.zoom === undefined ? undefined : Math.min(view.zoom, MAX_FIT_ZOOM),
    rotation: 0,
  }
}
