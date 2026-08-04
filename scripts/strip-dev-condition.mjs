#!/usr/bin/env node
// The "development" export condition points every entry at src/, which is how the packages in
// this repo resolve each other with no build step in between (see README, "Setup"). src/ is not
// in the tarball, so the condition must not reach the registry: a bundler that matches
// "development" - Vite does, in dev, out of the box - resolves the package to a file that does
// not exist and fails with "Failed to resolve entry for package".
//
// The strip has to happen BEFORE `changeset publish` starts rather than inside each package's
// prepack. npm builds the manifest it sends to the registry from the package.json it read before
// prepack runs, but packs the directory after, so a prepack-based strip yields a correct tarball
// attached to registry metadata that still advertises the condition - which is what 0.2.1 did.
// Installs were fine, `npm view @mvpaint/engine exports` was not. Stripping first makes both agree.
//
// The strip also drops the prepublishOnly guard described below, so consumers do not unpack a
// manifest pointing at a repo path they do not have.
//
// Modes:
//   strip / restore   across every publishable workspace package; run from anywhere
//   publish           strip, run `changeset publish`, restore whatever happens
//   assert            fail if the package in the current directory still carries the condition.
//                     Each package runs this as prepublishOnly, so a bare `npm publish` that
//                     bypasses `npm run release` aborts instead of shipping the bug again.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BACKUP = 'package.json.prepack-backup'

const manifestPath = (dir) => join(dir, 'package.json')
const backupPath = (dir) => join(dir, BACKUP)
const readManifest = (dir) => JSON.parse(readFileSync(manifestPath(dir), 'utf8'))

// Everything under packages/ that npm would actually publish. Derived rather than listed so a new
// package is covered the day it is added, which is exactly the day nobody remembers this file.
function publishablePackages() {
  const packagesDir = join(ROOT, 'packages')
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name))
    .filter((dir) => existsSync(manifestPath(dir)) && !readManifest(dir).private)
}

// Every "development" key anywhere in the exports tree, however deeply the conditions nest.
function withoutDevelopment(exportsField) {
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    delete node.development
    for (const value of Object.values(node)) walk(value)
  }
  walk(exportsField)
  return exportsField
}

function hasDevelopment(exportsField) {
  return JSON.stringify(exportsField ?? null).includes('"development"')
}

function strip(dir) {
  // A leftover backup means an earlier run died before it could restore. That backup is the real
  // manifest and the one on disk is the stripped copy, so recover before stripping again.
  if (existsSync(backupPath(dir))) renameSync(backupPath(dir), manifestPath(dir))

  const raw = readFileSync(manifestPath(dir), 'utf8')
  const pkg = JSON.parse(raw)
  if (!hasDevelopment(pkg.exports) && pkg.scripts?.prepublishOnly === undefined) return

  withoutDevelopment(pkg.exports)
  // The prepublishOnly guard goes too. It runs `../../scripts/`, a path that does not exist once
  // the package is unpacked in someone's node_modules, so shipping it would leave every consumer
  // looking at a manifest that references a file they do not have. Nothing is lost by removing
  // it: it exists to catch a publish that skipped the strip, and the strip is what removes it -
  // a bypassing publish reads the manifest with the guard still in place. The release path gets
  // the same check from publish() below rather than from npm.
  if (pkg.scripts) delete pkg.scripts.prepublishOnly
  writeFileSync(backupPath(dir), raw)
  writeFileSync(manifestPath(dir), JSON.stringify(pkg, null, 2) + '\n')
}

function restore(dir) {
  if (existsSync(backupPath(dir))) renameSync(backupPath(dir), manifestPath(dir))
}

function assertClean(dir) {
  const pkg = readManifest(dir)
  if (!hasDevelopment(pkg.exports)) return
  console.error(
    `${pkg.name}: the "development" export condition is still in package.json. It points at src/,\n` +
      'which is not in the tarball, so publishing this would break every consumer whose bundler\n' +
      'matches that condition. Publish with `npm run release`, which strips it first.'
  )
  process.exit(1)
}

function publish(passthroughArgs) {
  const packages = publishablePackages()
  const changesetBin = createRequire(import.meta.url).resolve('@changesets/cli/bin.js')

  for (const dir of packages) strip(dir)
  try {
    // The check npm used to run as prepublishOnly, which the strip has just removed from these
    // manifests. Inside the try so a failure still restores the tree - and a throw rather than
    // process.exit for the same reason, since exiting would skip the finally.
    for (const dir of packages) {
      const pkg = readManifest(dir)
      if (hasDevelopment(pkg.exports)) {
        throw new Error(`${pkg.name}: exports still carry the development condition after stripping`)
      }
    }

    // stdio is inherited so the "New tag:" lines stay on this process's stdout, where the
    // changesets GitHub action reads them to work out what it published.
    const { status, error } = spawnSync(process.execPath, [changesetBin, 'publish', ...passthroughArgs], {
      cwd: ROOT,
      stdio: 'inherit',
    })
    if (error) throw error
    return status ?? 1
  } finally {
    for (const dir of packages) restore(dir)
  }
}

const [mode, ...rest] = process.argv.slice(2)

switch (mode) {
  case 'strip':
    for (const dir of publishablePackages()) strip(dir)
    break
  case 'restore':
    for (const dir of publishablePackages()) restore(dir)
    break
  case 'assert':
    assertClean(resolve(process.cwd()))
    break
  case 'publish':
    process.exit(publish(rest))
    break
  default:
    console.error('usage: strip-dev-condition.mjs strip|restore|assert|publish')
    process.exit(1)
}
