---
"@mvpaint/engine": patch
---

**The MSDF atlas carries a mip chain, so small text stops shimmering.**

A glyph drawn smaller than the atlas packed it is a minification, and one tap of a full-resolution distance field per screen pixel picks an arbitrary point out of a field that varies across the whole footprint. Move the camera and each glyph lands on different texels frame to frame — a line of small text crawls. Both paths sampled the atlas at level 0 and nothing else.

The atlas is now allocated with a full chain (`atlasMipLevels`, shared by both paths so a glyph minified on the fallback path is sampled exactly as on the other) and read through a sampler that blends between levels as well as within them.

Filling it differs by necessity. WebGL2 has `generateMipmap`. WebGPU deliberately has nothing of the kind — a chain is filled by rendering into it — so `webgpu/atlasMipmaps.ts` draws one full-screen triangle per level per layer, sampling the level above. Both run after every layer's level 0 has landed, never before.

Averaging a distance field is not the field of the averaged shape, so the deep levels are mush. They are never reached: the shader fades a glyph out as it approaches one screen pixel per field width, which is the first two or three levels of the chain.

Checked against real devices rather than inferred: the same atlas mipped both ways reads back identical at every level (mean 91.0, 91.0, 90.8, 90.5 down the first four), with no WebGPU validation error and no GL error.
