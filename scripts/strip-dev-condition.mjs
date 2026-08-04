#!/usr/bin/env node
// The "development" export condition points every entry at src/, which is how the
// monorepo resolves sibling packages without a build step (see README, "Setup").
// But src/ is not part of the published tarball, so the condition must not reach
// the registry: bundlers that match "development" out of the box (Vite dev, for
// one) would resolve the package to a file that does not exist and fail with
// "Failed to resolve entry for package".
//
// Wired as prepack/postpack in each publishable package, so `npm pack` and
// `changeset publish` strip the condition from the manifest that lands in the
// tarball and restore the original file afterwards:
//   "prepack":  "node ../../scripts/strip-dev-condition.mjs strip",
//   "postpack": "node ../../scripts/strip-dev-condition.mjs restore"
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

const MANIFEST = 'package.json'
const BACKUP = 'package.json.prepack-backup'

const mode = process.argv[2]

if (mode === 'strip') {
  // A leftover backup means an earlier pack died before postpack ran; the backup
  // holds the real manifest, so recover it before stripping again.
  if (existsSync(BACKUP)) renameSync(BACKUP, MANIFEST)

  const raw = readFileSync(MANIFEST, 'utf8')
  const pkg = JSON.parse(raw)
  const strip = (node) => {
    if (node === null || typeof node !== 'object') return
    delete node.development
    for (const value of Object.values(node)) strip(value)
  }
  strip(pkg.exports)
  writeFileSync(BACKUP, raw)
  writeFileSync(MANIFEST, JSON.stringify(pkg, null, 2) + '\n')
} else if (mode === 'restore') {
  if (existsSync(BACKUP)) renameSync(BACKUP, MANIFEST)
} else {
  console.error('usage: strip-dev-condition.mjs strip|restore')
  process.exit(1)
}
