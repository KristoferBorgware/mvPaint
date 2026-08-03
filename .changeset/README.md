# Changesets

Every change that should reach npm brings a **changeset** with it: a small file in this folder
saying which packages it affects, how far to move their version numbers, and one sentence about
what changed. Nothing else in the repo records that, and nothing else can - only the person
making a change knows whether it breaks anybody.

```bash
npm run changeset
```

Pick the packages, pick patch/minor/major, write the sentence. That writes a markdown file here;
commit it alongside the code it describes.

## What happens next

You never edit a version number by hand, and there is no bump step before a build.

1. Your PR merges to `master` carrying its changeset.
2. `.github/workflows/release.yml` sees pending changesets and opens (or updates) a PR titled
   **"Version Packages"**. That PR is the bump: new versions in every affected `package.json`,
   the changesets folded into each `CHANGELOG.md`, dependency ranges between the packages
   brought back into line, and the changeset files deleted.
3. Merging that PR publishes the new versions to npm.

So the bump is a reviewable diff you approve, not something you remember to do. Several PRs can
land between steps 2 and 3 - the Version Packages PR just keeps updating itself until you merge
it, which is how a release ends up covering a batch of changes rather than one.

## What does not need one

`@mvpaint/example-app` and `@mvpaint/scripts` are private and never published, so a change that
touches only those needs no changeset. Neither do CI config, tests or docs. If you skip one and
later decide the change should ship, add the changeset in a follow-up commit - the versioning
runs off these files, not off git history.

## Choosing the bump

Both published packages are pre-1.0, where the convention is that **minor** is the breaking one
and **patch** is everything else. Use major only for a deliberate 1.0.

- **patch** - a fix, or anything a consumer's existing code cannot notice.
- **minor** - new public API, or a change that could make existing code stop compiling or
  behave differently.
- **major** - reserved for 1.0 and beyond.

`@mvpaint/ttf` declares `@mvpaint/engine` as a peer dependency, so bumping the engine only drags
ttf along when the new version falls outside ttf's range. A normal engine release leaves ttf
alone.
