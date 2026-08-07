# @mvpaint/scripts

Offline tools. Nothing here ships in an application — these are run by hand, on a developer's
machine, and what they write is copied into an application deliberately.

One folder per tool, each owning its own inputs and outputs:

| Folder | What it does |
| --- | --- |
| [`textgen/`](textgen) | Font files in, glyph atlases out — MSDF pages for the text lane and flattened outlines for the vector lane |

```bash
npm run gen:fonts      # textgen: both kinds of atlas
npm run gen:msdf       # textgen: MSDF only
npm run gen:polygons   # textgen: outlines only
npm test               # every tool's self-tests
```

## Why one package rather than one per tool

These are private and never published, so the usual reason to split — keeping a consumer from
installing a dependency it will never call — does not apply. What a split would cost is real:
a manifest, a tsconfig and test wiring per tool, and a second copy of tsx. A folder gets a tool
its own place without any of that.

The line that matters is the one already drawn: this package is not the engine. Both generators
need a font parser and one needs an SDF generator, together a good deal more code than the
renderer itself, and out here they cannot be imported by accident. See
[textgen/README.md](textgen/README.md).
