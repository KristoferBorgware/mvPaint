// Self-test for the WebGL2 fallback's pure half (no GL, no DOM).
//
// Two things on this path have exact answers that a screenshot would not catch, and both are
// arithmetic that stands between a correct record and a wrong colour:
//
//   - the data texture's index maths, which decides where a record lands and which rows an
//     upload has to cover (GlObjectTexture.ts);
//   - every generated shader's texel offsets, which have to agree with the render/*Format.ts
//     module they were generated from by construction rather than by luck - and, for the
//     shadow lane, the two halves of the render-to-texture flip, which only work together.
//
// Run with: npx vitest run packages/engine/src/webgl/webgl.test.ts

import { expect, it } from 'vitest'
import {
  OBJECT_TEXTURE_WIDTH,
  recordTexels,
  rowRangeFor,
  rowsFor,
} from './GlObjectTexture'
import { componentOf, meshFragmentGlsl, meshVertexGlsl, texelOf } from './shaders/mesh.glsl'
import { textFragmentGlsl, textVertexGlsl } from './shaders/text.glsl'
import { imageFragmentGlsl, imageVertexGlsl } from './shaders/image.glsl'
import {
  shadowBlurFragmentGlsl,
  shadowFilterVertexGlsl,
  shadowQuadFragmentGlsl,
  shadowQuadVertexGlsl,
  shadowSilhouetteVertexGlsl,
} from './shaders/shadow.glsl'
import {
  OBJECT_DEPTH_OFFSET,
  OBJECT_FILL_COLOR_OFFSET,
  OBJECT_STRIDE,
  OBJECT_STROKE_COLOR_OFFSET,
} from '../render/meshFormat'
import { TEXT_OBJECT_ATLAS_LAYER_OFFSET, TEXT_OBJECT_STRIDE } from '../render/textFormat'
import { IMAGE_OBJECT_STRIDE, IMAGE_OBJECT_TINT_OFFSET } from '../render/imageFormat'
import { SHADOW_OBJECT_COLOR_OFFSET, SHADOW_OBJECT_STRIDE } from '../render/shadowFormat'

/**
 * Every check in this file goes through here, so each one reads as the sentence it is making
 * and vitest reports that sentence when it stops being true.
 */
function assert(cond: boolean, msg: string): void {
  expect(cond, msg).toBe(true)
}

it('records are a whole number of texels', () => {
    assert(recordTexels(OBJECT_STRIDE) === 19, 'a 304-byte mesh record is 19 RGBA32F texels')
    assert(recordTexels(16) === 1, 'a one-texel record is one texel')
    let threw = false
    try {
      recordTexels(300)
    } catch {
      threw = true
    }
    assert(threw, 'a stride that is not a multiple of 16 is rejected rather than silently truncated')
})

it('how many rows a given object count needs', () => {
    const texels = recordTexels(OBJECT_STRIDE)
    assert(rowsFor(0, texels) === 1, 'an empty lane still gets one row - a zero-sized texture is not a texture')
    assert(rowsFor(1, texels) === 1, 'one object fits in one row')
    // 1024 / 19 = 53.9, so 53 records fit in a row and the 54th starts the next one.
    assert(rowsFor(53, texels) === 1, '53 mesh records fit in a 1024-texel row')
    assert(rowsFor(54, texels) === 2, 'and the 54th spills into a second')
    assert(rowsFor(20000, texels) === Math.ceil((20000 * 19) / OBJECT_TEXTURE_WIDTH), '20k objects is a few hundred rows')
    assert(rowsFor(20000, texels) < 2048, 'which is well inside the 2048 every WebGL2 device guarantees')
})

it('an upload covers every changed record, and never fewer', () => {
    const texels = recordTexels(OBJECT_STRIDE)
    // The property that matters: for any record range, the rows returned must contain every
    // texel of every record in it. Missing one shows up as a shape that stopped updating.
    for (const [start, end] of [
      [0, 1],
      [0, 53],
      [52, 55],
      [53, 54],
      [100, 101],
      [999, 1000],
      [0, 20000],
    ] as const) {
      const { row, rows } = rowRangeFor(start, end, texels)
      const firstTexel = start * texels
      const lastTexel = end * texels - 1
      assert(row * OBJECT_TEXTURE_WIDTH <= firstTexel, `rows for [${start},${end}) start at or before the first texel`)
      assert(
        (row + rows) * OBJECT_TEXTURE_WIDTH > lastTexel,
        `rows for [${start},${end}) reach past the last texel`,
      )
      assert(rows >= 1, `[${start},${end}) uploads at least one row`)
    }

    // A record wholly inside one row costs exactly one row, not two - the rounding is outward,
    // not generous.
    assert(rowRangeFor(0, 1, texels).rows === 1, 'a single record in the first row uploads one row')
    // Record 53 starts at texel 1007 and ends at 1026, so it genuinely straddles two rows.
    assert(rowRangeFor(53, 54, texels).rows === 2, 'a record that straddles a row boundary uploads both')
})

it('the generated GLSL agrees with the byte offsets it was generated from', () => {
    assert(texelOf(0) === 0 && componentOf(0) === 0, 'byte 0 is texel 0, component x')
    assert(texelOf(OBJECT_DEPTH_OFFSET) === 5 && componentOf(OBJECT_DEPTH_OFFSET) === 1, 'depth is texel 5.y')
    assert(texelOf(OBJECT_FILL_COLOR_OFFSET) === 17, 'the fill colour is a whole texel, 17')
    assert(componentOf(OBJECT_FILL_COLOR_OFFSET) === 0, 'and 16-byte aligned, so it starts at x')
    assert(texelOf(OBJECT_STROKE_COLOR_OFFSET) === 18, 'the stroke colour is texel 18 - the last of the 19')
    assert(texelOf(OBJECT_STRIDE - 4) === 18, 'the record ends inside its last texel, with nothing spare')

    // The shader must carry the record size it was generated with. If OBJECT_STRIDE ever
    // changes, this is what says so before a frame comes out wrong.
    assert(
      meshVertexGlsl.includes(`const int OBJ_TEXELS = ${OBJECT_STRIDE / 16};`),
      'the vertex shader is generated with the current record size',
    )
    assert(
      meshFragmentGlsl.includes(`const int OBJ_TEXELS = ${OBJECT_STRIDE / 16};`),
      'and so is the fragment shader',
    )
    // The depth remap is the one line that differs from the WGSL, and dropping it would put
    // every shape at the near plane instead of at its zIndex rank.
    assert(meshVertexGlsl.includes('* 2.0 - 1.0) * clip.w'), "the vertex shader remaps WebGPU's [0,1] depth into GL's [-1,1]")
    assert(!meshFragmentGlsl.includes('floatBitsToUint'), 'integer fields are read as floats, never as reinterpreted bits')
    for (const source of [meshVertexGlsl, meshFragmentGlsl]) {
      assert(source.startsWith('#version 300 es\n'), 'both stages declare GLSL ES 300 on the very first line')
    }
})

it('the text lane\'s shader, on the same terms', () => {
    const texels = recordTexels(TEXT_OBJECT_STRIDE)
    assert(texels === 20, 'a 320-byte text record is 20 texels')
    assert(rowsFor(1000, texels) === Math.ceil((1000 * 20) / OBJECT_TEXTURE_WIDTH), '1000 runs is 20 rows')

    for (const source of [textVertexGlsl, textFragmentGlsl]) {
      assert(source.startsWith('#version 300 es\n'), 'both text stages declare GLSL ES 300 first')
      assert(source.includes(`const int OBJ_TEXELS = ${TEXT_OBJECT_STRIDE / 16};`), 'generated with the text record size')
    }
    assert(textVertexGlsl.includes('* 2.0 - 1.0) * clip.w'), 'the text vertex shader remaps depth into GL clip space')
    assert(!textFragmentGlsl.includes('floatBitsToUint'), 'the text shader reads integer fields as floats too')

    // The atlas layer is a per-RUN value in the record, and it is what lets a paragraph mixing
    // four styles draw in one call. Reading it from the wrong texel draws every run in one style.
    assert(
      textFragmentGlsl.includes(`obj(id, ${TEXT_OBJECT_ATLAS_LAYER_OFFSET >> 4})`),
      "the atlas layer is read from the record's own texel",
    )
    assert(textFragmentGlsl.includes('sampler2DArray'), 'all four styles are layers of one array texture')
    // Derivatives are undefined in non-uniform control flow, and a quad can mix glyph and
    // decoration fragments - so both fwidth() calls must precede the branch on the glyph bit.
    const branch = textFragmentGlsl.indexOf('GLYPH_BIT) == 0u')
    assert(textFragmentGlsl.indexOf('fwidth(v_uv)') < branch, 'the uv derivative is taken before the glyph branch')
    assert(textFragmentGlsl.indexOf('fwidth(v_localPos)') < branch, 'and so is the local one')
    assert(textFragmentGlsl.indexOf('texture(u_atlas') < branch, 'and the atlas sample, which is also a derivative read')
})

it('the image lane', () => {
    assert(recordTexels(IMAGE_OBJECT_STRIDE) === 6, 'a 96-byte image record is 6 texels - a transform, a tint, a depth')
    for (const source of [imageVertexGlsl, imageFragmentGlsl]) {
      assert(source.startsWith('#version 300 es\n'), 'both image stages declare GLSL ES 300 first')
      assert(source.includes(`const int OBJ_TEXELS = ${IMAGE_OBJECT_STRIDE / 16};`), 'generated with the image record size')
    }
    assert(imageVertexGlsl.includes('* 2.0 - 1.0) * clip.w'), 'the image vertex shader remaps depth into GL clip space')
    // The tint is 16-byte aligned, so it is a whole texel and needs no component index.
    assert(
      imageFragmentGlsl.includes(`obj(id, ${IMAGE_OBJECT_TINT_OFFSET / 16})`),
      'the tint is read as a whole texel',
    )
    assert(!imageFragmentGlsl.includes('floatBitsToUint'), 'the image record has no integer fields to misread')
})

it('the shadow lane, and the one place the two paths genuinely diverge', () => {
    assert(recordTexels(SHADOW_OBJECT_STRIDE) === 8, 'a 128-byte shadow record is 8 texels')
    for (const source of [shadowQuadVertexGlsl, shadowQuadFragmentGlsl]) {
      assert(source.startsWith('#version 300 es\n'), 'both shadow-quad stages declare GLSL ES 300 first')
      assert(source.includes(`const int OBJ_TEXELS = ${SHADOW_OBJECT_STRIDE / 16};`), 'generated with the record size')
    }
    assert(shadowQuadVertexGlsl.includes('* 2.0 - 1.0) * clip.w'), 'the shadow quad remaps depth into GL clip space')
    assert(
      shadowQuadFragmentGlsl.includes(`obj(id, ${SHADOW_OBJECT_COLOR_OFFSET / 16})`),
      "the shadow's colour comes from the record, so recolouring never touches the baked texture",
    )

    // THE FLIP. WebGPU puts NDC y = +1 in a texture's first texel row and GL puts it in the
    // last, so a bake ported unchanged comes out mirrored - and mirrored again per filter pass.
    // It is corrected in exactly two places, and they only work together:
    //
    //   1. the silhouette projection's y is negated (webgl/GlShadowAtlas.ts passes -(2/quadH));
    //   2. the fullscreen vertex shader maps uv.y STRAIGHT THROUGH, where the WGSL flips it.
    //
    // Getting one without the other gives upside-down shadows, so both are pinned here.
    assert(
      shadowFilterVertexGlsl.includes('v_uv = vec2((x + 1.0) * 0.5, (y + 1.0) * 0.5);'),
      'the filter passes map uv.y straight through, so each reads the row it writes',
    )
    assert(
      !shadowFilterVertexGlsl.includes('1.0 - (y + 1.0)'),
      "and do NOT carry the WGSL's flip, which would mirror the image on every pass",
    )
    assert(
      shadowSilhouetteVertexGlsl.includes('a_position * u_scale + u_offset'),
      'the silhouette projection is a plain scale-and-offset, with the flip applied to the uniform',
    )
    // Both filter kernels bound their loops by a constant so the shader compiles everywhere;
    // an unbounded dynamic loop is legal GLSL ES 300 but not reliably compiled.
    assert(shadowBlurFragmentGlsl.includes('i <= MAX_TAPS'), 'the blur loop is bounded by a constant')
    assert(shadowBlurFragmentGlsl.includes('if (i > r) break;'), 'and exits early at the real radius')
})
