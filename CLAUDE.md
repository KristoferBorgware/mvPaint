# Working in this repository

## Comments

Comments in this codebase are dense and explanatory by design. Match that. The rules below are
about what a comment says, not how much.

### Document the present, not the past

A comment describes the code as it is. It is not a changelog, a migration note, or a record of
what something used to be. A reader arriving today has no memory of a previous version and does
not need one.

Do not write: `used to`, `no longer`, `any more`, `previously`, `now means`, `all along`,
`finally`, `has been changed to`, `this replaces`.

```ts
// NO  - The engine no longer bundles a fallback font, so `fonts` is now required for text.
// YES - The engine ships no typeface. `Text` draws once `fonts` supplies a set.
```

History belongs in git, and in `.changeset/` entries — those DO describe what changed, because
telling an upgrading consumer what moved is exactly their job.

### State the behaviour, not the disaster averted

Say what the code does. Do not build a case for it out of what would happen otherwise. Skip the
counterfactual chain and the argument; the reader wants the fact.

```ts
// NO  - Without this the layer size would be -Infinity, and every uv would scale wrong, so we
//       return 1x1 instead.
// YES - An empty set is 1x1, the size the placeholder texture is allocated at.
```

A short "so that" clause is fine when it names a real constraint (`Held here rather than passed
through the scene contract, because build() is synchronous`). An escalating if-then-therefore is
not.

### Code is not a monetary system

No economic metaphors. Not `cost`, `pay`, `pays for itself`, `buy`, `cheap`, `expensive`,
`worth it`, `budget`, `price`, `dividend`, `tax`.

Name the actual resource — bytes, a fetch, a round trip, a draw call, an allocation, a frame,
milliseconds.

```ts
// NO  - A scene of rectangles pays nothing for the text lane, and the placeholder is the
//       cheapest thing that satisfies the bind group.
// YES - A scene of rectangles issues no font request, and the placeholder is one texel, the
//       smallest thing the bind group accepts.
```

### Keep the register plain

Technical documentation, not prose. Avoid flourishes that carry no information — `that is the
whole shape of the thing`, `the honest demonstration`, `not optional politeness`, `is the
point`. If deleting a clause loses no fact, delete it.

## Applying this

These rules apply to code comments, doc comments, and the prose in `README.md` /
`ARCHITECTURE.md`. When editing an existing comment, bring it into line. Do not sweep unrelated
comments in files you are not otherwise touching unless asked.
