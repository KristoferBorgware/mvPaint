# Diagrams

Every `.svg` here is committed, so the documents render on GitHub with no build step.

Two kinds sit side by side:

| | Source | Files |
| --- | --- | --- |
| Generated from Mermaid | `mermaid/*.mmd` | `architecture-overview.svg` |
| Hand-authored | the SVG itself | `resources-holders.svg`, `resources-fonts.svg` |

## Regenerating a Mermaid diagram

Mermaid CLI is not a dependency of this repository — the SVGs are the artefact, and the tool
pulls a headless browser. Install it wherever is convenient and point it at a source file:

```bash
npx -y @mermaid-js/mermaid-cli -i docs/mermaid/architecture-overview.mmd -o docs/architecture-overview.svg -c docs/mermaid/config.json -b "#fbfcfe" -s 1
```

`config.json` carries the two settings the output depends on:

- **`htmlLabels: false`.** Mermaid's default writes node labels as `<foreignObject>` holding
  HTML. A browser showing an SVG through an `<img>` tag — which is what a Markdown image is —
  renders none of it, so the boxes arrive empty. With the flag off, labels are real `<text>`
  elements.
- **`useMaxWidth: false`**, which writes explicit `width` and `height` onto the `<svg>` instead
  of `width="100%"`.

`-b "#fbfcfe"` paints an opaque background. GitHub serves the same image to a reader on a dark
theme, and dark label text on a transparent background is unreadable there.

Line breaks are `<br/>` in the source. `wrappingWidth` is set high enough that Mermaid never
inserts its own, which it otherwise does mid-token.

## The palette

Shared with the hand-authored diagrams, so the two kinds read as one set.

| Meaning | Fill | Stroke |
| --- | --- | --- |
| An application, or an entry point | `#ffffff` | `#c3cadb` |
| The global resource cache | `#f2f8ef` | `#3d8a26` |
| Bound to one device | `#eef6f6` | `#007a80` |
| Shared by both render paths | `#fff8ec` | `#b4761a` |
| Scene-graph classes | `#ffffff` | `#8b93a7` |
