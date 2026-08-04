---
"@mvpaint/engine": patch
"@mvpaint/ttf": patch
---

Publish registry metadata that matches the tarball. 0.2.1 shipped a correct tarball — the `development` export condition was stripped from the packaged `package.json`, so installs resolve to `dist/` — but the metadata npm recorded for it still advertised the condition, because npm builds that metadata from the manifest it reads before `prepack` runs. The strip now happens before `changeset publish` starts, so `npm view @mvpaint/engine exports` agrees with what actually installs.

The published manifest also no longer carries the repo's internal `prepublishOnly` guard, which referenced a path outside the package.
