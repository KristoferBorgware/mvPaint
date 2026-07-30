// Camera2D - where the scene is looked at from. A plain object, not a scene node: a camera
// is not a thing IN the scene, it is the frame the scene is viewed through, and an
// application owns it. Nothing in the graph refers to it, and it refers to nothing in the
// graph, so a scene can be drawn through two cameras at once (a minimap, a print preview)
// without either knowing about the other.
//
// WHAT IT IS. A rectangle of world, placed like any other rectangle in this engine:
//
//   x, y     the world point at the viewport's TOP-LEFT corner. The scene is y-up, so the
//            view extends right and DOWNWARD from there - the same origin convention Rect,
//            Image and Text follow (see Shape's header).
//   zoom     viewport pixels per world unit. 1 means one world unit is one CSS pixel.
//   rotation radians, about the view's CENTRE, turning what you see counter-clockwise.
//
// A default camera therefore puts world (0, 0) at the top-left corner at 1:1 scale, which
// is what a scene renders through when an application supplies no camera of its own.
//
// The visible world rectangle, before rotation, is x in [x, x + width/zoom] and y in
// [y - height/zoom, y]; rotation turns that rectangle about its own middle, which is what
// anyone turning a view expects (turning about the corner would swing the content away).
//
// WHY IT STILL BUILDS A 4x4. The projection could be two multiplies and an add, and
// screenToWorld could be its exact inverse in two lines. It composes a real view and
// projection matrix instead, and unprojects through the inverse, because a 3D view mode is
// not ruled out: the render path already takes a view-projection and nothing else, so
// keeping the matrix seam here means a perspective camera would slot in without any lane,
// shader or culling code changing. The cost is one 4x4 inverse per screen-to-world call,
// which happens per pointer event, not per object.
//
// CSS PIXELS, NOT DEVICE PIXELS. zoom is in logical pixels, so a shape is the same physical
// size on a retina display as on an ordinary one - the device pixel ratio only decides how
// many physical pixels render each logical one. Callers pass the viewport's CSS size.

import { AABB } from '../math/AABB'
import { Matrix4x4 } from '../math/Matrix4x4'
import { Ray } from '../math/Ray'
import { Vector3 } from '../math/Vector3'
import { Vector4 } from '../math/Vector4'

export interface Camera2DOptions {
  /** World point at the viewport's top-left corner. Default (0, 0). */
  x?: number
  y?: number
  /** Viewport pixels per world unit; >1 magnifies. Default 1. */
  zoom?: number
  /** Radians, about the view centre, turning the scene counter-clockwise. Default 0. */
  rotation?: number
}

/** Smallest zoom that still describes a view - guards a divide, not a policy. */
const MIN_ZOOM = 1e-6

export class Camera2D {
  x: number
  y: number
  zoom: number
  rotation: number

  /**
   * Depth range of the view volume. Every lane overrides the projected z with a depth
   * derived from zIndex rank (see scene/picking.ts), so nothing here is ever clipped by
   * these - they exist to keep the projection well-formed, not to select content.
   */
  nearZ = -1000
  farZ = 1000

  constructor(options: Camera2DOptions = {}) {
    this.x = options.x ?? 0
    this.y = options.y ?? 0
    this.zoom = options.zoom ?? 1
    this.rotation = options.rotation ?? 0
  }

  /** The world rectangle's size at the current zoom, for a viewport of this CSS size. */
  viewSize(viewportWidth: number, viewportHeight: number): { width: number; height: number } {
    const zoom = Math.max(MIN_ZOOM, this.zoom)
    return { width: viewportWidth / zoom, height: viewportHeight / zoom }
  }

  /**
   * The world point at the middle of the view - what rotation turns about, and what a
   * caller usually means by "where the camera is looking".
   */
  center(viewportWidth: number, viewportHeight: number): { x: number; y: number } {
    const { width, height } = this.viewSize(viewportWidth, viewportHeight)
    return { x: this.x + width / 2, y: this.y - height / 2 }
  }

  /** Moves the camera so `worldX, worldY` sits at the middle of the view. */
  centerOn(worldX: number, worldY: number, viewportWidth: number, viewportHeight: number): void {
    const { width, height } = this.viewSize(viewportWidth, viewportHeight)
    this.x = worldX - width / 2
    this.y = worldY + height / 2
  }

  /**
   * Looks straight down -Z at the view centre. Rotation is carried in the up vector: with
   * up turned clockwise by `rotation`, the world appears turned counter-clockwise by it.
   */
  view(viewportWidth: number, viewportHeight: number): Matrix4x4 {
    const c = this.center(viewportWidth, viewportHeight)
    const up = new Vector3(Math.sin(this.rotation), Math.cos(this.rotation), 0)
    return Matrix4x4.lookAtRH(new Vector3(c.x, c.y, 1), new Vector3(c.x, c.y, 0), up)
  }

  /** Orthographic, sized by the world rectangle the viewport covers at this zoom. */
  proj(viewportWidth: number, viewportHeight: number): Matrix4x4 {
    const { width, height } = this.viewSize(viewportWidth, viewportHeight)
    return Matrix4x4.orthographicRH(width, height, this.nearZ, this.farZ)
  }

  /** Column-vector view-projection: clip = viewProjection * world. */
  viewProjection(viewportWidth: number, viewportHeight: number): Matrix4x4 {
    return this.proj(viewportWidth, viewportHeight).mul(this.view(viewportWidth, viewportHeight))
  }

  /**
   * World-space ray through a viewport pixel (CSS px from the viewport's top-left, y-down -
   * the coordinates pointer events arrive in). Unprojects through the inverse
   * view-projection, so it holds for whatever that matrix turns out to be.
   */
  screenPointToRay(px: number, py: number, viewportWidth: number, viewportHeight: number): Ray {
    // Pixel -> normalized device coords (WebGPU/D3D: x,y in [-1,1], y flipped, z in [0,1]).
    const ndcX = (2 * px) / viewportWidth - 1
    const ndcY = 1 - (2 * py) / viewportHeight

    const invViewProj = this.viewProjection(viewportWidth, viewportHeight).inverse()
    const nearH = invViewProj.transformVector4(new Vector4(ndcX, ndcY, 0, 1))
    const farH = invViewProj.transformVector4(new Vector4(ndcX, ndcY, 1, 1))
    const nearW = nearH.xyz().div(nearH.w)
    const farW = farH.xyz().div(farH.w)

    return new Ray(nearW, farW.sub(nearW).safeNormalized(Vector3.forward()))
  }

  /**
   * The world-space box the viewport currently covers - what viewport culling tests
   * against (see scene/culling.ts). Derived by unprojecting the four clip-space corners
   * rather than from x/y/zoom directly, so a turned view gives the AABB of the turned
   * rectangle, and so this can never disagree with what the projection actually shows.
   *
   * Z spans +-Infinity rather than the "real" 0 every 2D shape's world bounds sits at:
   * AABB.expanded() (the cull-margin debug knob) shrinks EVERY axis, and a margin big
   * enough to go negative on a zero-thickness Z range inverts it (min > max), which makes
   * AABB.intersects() reject every shape on its Z alone, regardless of X/Y overlap - i.e.
   * everything vanishes as soon as the margin goes negative. Z was never a real constraint
   * for a 2D scene, so leaving it unbounded is the correct answer, not a workaround.
   */
  viewBounds(viewportWidth: number, viewportHeight: number): AABB {
    const inv = this.viewProjection(viewportWidth, viewportHeight).inverse()
    const box = new AABB()
    for (const [nx, ny] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const h = inv.transformVector4(new Vector4(nx, ny, 0, 1))
      const p = h.xyz().div(h.w)
      box.encapsulate(new Vector3(p.x, p.y, 0))
    }
    return new AABB(new Vector3(box.min.x, box.min.y, -Infinity), new Vector3(box.max.x, box.max.y, Infinity))
  }
}
