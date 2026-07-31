// How each lane's vertex bytes are described to WebGPU.
//
// The BYTES are not decided here - they are decided in render/*Format.ts, which both render
// paths pack against and neither owns. What is decided here is only how to spell that layout
// for this API, and a GPUVertexBufferLayout is a WebGPU type, so it lives on this side of the
// line rather than leaving one WebGPU declaration stranded in the neutral half.
//
// Every stride below is imported rather than written out, so a format change cannot leave the
// pipeline describing the old one. The WebGL path answers the same question with
// vertexAttribPointer calls in its batchers (see webgl/lanes/), from the same constants.

import { MESH_VERTEX_STRIDE } from '../render/meshFormat'
import { TEXT_VERTEX_STRIDE } from '../render/textFormat'
import { IMAGE_VERTEX_STRIDE } from '../render/imageFormat'
import { SHADOW_VERTEX_STRIDE } from '../render/shadowFormat'

/** position f32x2 + packedId u32 (object index, top bit = isFill). */
export const MESH_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: MESH_VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position (local)
    { shaderLocation: 1, offset: 8, format: 'uint32' }, //    packedId
  ],
}

/** position f32x2 + uv f32x2 + colour f32x4 + packedId u32 (top bit = isGlyph). */
export const TEXT_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: TEXT_VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' }, //  position (local)
    { shaderLocation: 1, offset: 8, format: 'float32x2' }, //  uv (atlas)
    { shaderLocation: 2, offset: 16, format: 'float32x4' }, // colour
    { shaderLocation: 3, offset: 32, format: 'uint32' }, //    packedId
  ],
}

/** position f32x2 + uv f32x2 + objectId u32. No per-vertex colour: a tint is per object. */
export const IMAGE_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: IMAGE_VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position (local)
    { shaderLocation: 1, offset: 8, format: 'float32x2' }, // uv
    { shaderLocation: 2, offset: 16, format: 'uint32' }, //   objectId
  ],
}

/** corner (0..1 in each axis) + objectId u32. The quad's real bounds are per object. */
export const SHADOW_VERTEX_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: SHADOW_VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x2' }, // corner
    { shaderLocation: 1, offset: 8, format: 'uint32' }, //    objectId
  ],
}
