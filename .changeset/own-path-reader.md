---
"@mvpaint/engine": minor
---

Read SVG path data in-house. `svgpath` was the engine's second runtime dependency and its only CommonJS one; `earcut` is now the only one it has.

Two new modules cover what it did. `svg/pathData.ts` reads the `d` grammar — the carried-over command letters, the optional separators, the packed arc flags — and hands over absolute movetos, linetos, cubics and quadratics, with the relative forms, the axis shorthands and the smooth shorthands all resolved. `svg/arcToCubic.ts` converts elliptical arcs to cubics. Both are written from the SVG 1.1 specification: section 8.3.9 for the grammar, appendix F.6 for the endpoint-to-centre arc conversion, with section numbers cited against each step.

Behaviour is held to the library it replaces by a differential test, which keeps `svgpath` as a devDependency and compares flattened contours across the grammar, six transform matrices, three flattening tolerances, and all 287 paths in the example app's tiger and Tux artwork. Agreement is to 1e-9, four orders of magnitude under the default flattening tolerance.

One deliberate difference. An arc whose endpoints coincide is now omitted, which is what the specification asks for (F.6.2); `svgpath` emits a zero-length lineto, reaching the mesh builder as a contour of two identical points. Nothing else changes.

Dropping the CommonJS dependency also makes the package loadable with no build step: `earcut` is already ESM, so a browser reaches the whole engine through a two-line import map, with no bundler and no CDN conversion in between.
