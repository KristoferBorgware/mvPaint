---
"@mvpaint/engine": major
---

**Breaking.** The text classes are renamed so each says where its glyphs come from.

| was | is |
| --- | --- |
| `Text` | `MSDFText` |
| `TextOptions` | `MSDFTextOptions` |
| `TextBlock` | `Text` |
| `TextBlockOptions` | `TextOptions` |

`MSDFText` samples a distance-field atlas and `VectorText` tessellates real outlines, so the pair now reads as the choice it is. `Text` is the abstract base both extend — the runs, the block layout options and the shaping-invalidation protocol — and naming it `Text` puts the plain word on the shared idea rather than on one of the two implementations.

To migrate: `Text` becomes `MSDFText` at every construction site, and any code naming `TextBlock` as a base or a parameter type becomes `Text`. `TextOptions` changes meaning rather than disappearing — it is the base options interface now, and the MSDF one is `MSDFTextOptions`.

Selectors move with the class, since `nodeName` is the concrete class name: `find('Text')` matched the MSDF node and now matches nothing, `find('MSDFText')` matches it. `nodeType` is unchanged at `'Shape'` for both.

No behaviour changes.
