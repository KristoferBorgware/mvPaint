# Diagrams

Every `.svg` here is committed, so the documents render on GitHub with no build step.

Two kinds sit side by side:

| | Source | Files |
| --- | --- | --- |
| Generated from Mermaid | `mermaid/*.mmd` | `architecture-overview.svg`, `node-hierarchy.svg`, `draw-order.svg`, `lane-anatomy.svg`, `invalidation.svg`, `text-pipeline.svg`, `render-paths.svg` |
| Hand-authored | the SVG itself | `resources-holders.svg`, `resources-fonts.svg` |

Each `.mmd` renders to a `.svg` of the same name one directory up.

## Regenerating a Mermaid diagram

Mermaid CLI is not a dependency of this repository — the SVGs are the artefact, and the tool
pulls a headless browser. Install it wherever is convenient and point it at a source file:

```bash
npx -y @mermaid-js/mermaid-cli -i docs/mermaid/architecture-overview.mmd -o docs/architecture-overview.svg -c docs/mermaid/config.json -b "#fbfcfe" -s 1 && node docs/mermaid/normalize.mjs docs/architecture-overview.svg
```

Both halves matter, and each fixes a way an SVG can look right in a browser tab and arrive broken
in a Markdown file:

- **`htmlLabels: false`** in `config.json`. Mermaid's default writes node labels as
  `<foreignObject>` holding HTML. A browser showing an SVG through an `<img>` tag — which is what
  a Markdown image is — renders none of it, so the boxes arrive empty. With the flag off, labels
  are real `<text>` elements.
- **`normalize.mjs`** writes an explicit `width` and `height` onto the root from the `viewBox`.
  Mermaid emits `width="100%"` with no height, which leaves an `<img>` with no intrinsic size and
  no aspect ratio to fall back on, and the picture collapses to a small empty box. `useMaxWidth:
  false` handles this for flowcharts and is ignored by the class diagram renderer, so the size is
  written afterwards for every kind at once.

`-b "#fbfcfe"` paints an opaque background. GitHub serves the same image to a reader on a dark
theme, and dark label text on a transparent background is unreadable there.

Line breaks are `<br/>` in the source. `wrappingWidth` is set high enough that Mermaid never
inserts its own, which it otherwise does mid-token. Entities like `&nbsp;` are **not** decoded
with `htmlLabels` off and render literally — use `·` or a line break instead.

## Checking one before committing it

Every generated file should satisfy all four:

| | |
| --- | --- |
| an explicit `width` and `height` on the root | otherwise it collapses inside an `<img>` |
| no `<foreignObject>` | otherwise the labels vanish inside an `<img>` |
| no `href`/`src` pointing off-document | a Markdown image loads no subresources |
| an opaque background | so a dark-theme reader can read the labels |

## The palette

Shared with the hand-authored diagrams, so the two kinds read as one set.

| Meaning | Fill | Stroke |
| --- | --- | --- |
| An application, or an entry point | `#ffffff` | `#c3cadb` |
| The global resource cache | `#f2f8ef` | `#3d8a26` |
| Bound to one device | `#eef6f6` | `#007a80` |
| Shared by both render paths | `#fff8ec` | `#b4761a` |
| Scene-graph classes | `#ffffff` | `#8b93a7` |
