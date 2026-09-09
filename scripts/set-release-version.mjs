#!/usr/bin/env node
// Sets the version semantic-release computed, across both packages.
//
//   node scripts/set-release-version.mjs 0.2.0
//
// The two packages release in lockstep, at one version. They are not independent things that
// happen to live together: the mirror is generated against a pinned core, the compat probe
// asserts the seams the adopter decorates, and the harness exercises both — a change to either
// is validated against the other, and shipping them at drifting versions would invent a
// combination nothing has run.
//
// It also rewrites the adopter's dependency on the mechanism to `^<version>`, which is what
// keeps that range honest without anyone remembering to. Yarn still links the workspace
// locally, because the workspace's version satisfies the range.
//
// That rewrite lands in `yarn.lock` as a descriptor, so the lockfile is stale the moment this
// runs. The release refreshes it with a real `yarn install --no-immutable` and commits it
// alongside the manifests — without that, the release itself is fine and the *next* CI run
// fails on `yarn install --immutable`, a failure that points at the commit after the guilty one.
//
// It has to be a real install. `--mode update-lockfile` looks like the tighter tool and is the
// wrong one: it resolves without fetching, so it writes a lockfile with no checksums — a 25k
// line rewrite that every later `--immutable` install rejects. `--no-immutable` is needed
// because yarn defaults to immutable whenever CI is set.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MECHANISM = '@fullstackhouse/open-mercato-durable-work'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`set-release-version: expected a semver version, got ${JSON.stringify(version ?? '')}`)
  process.exit(1)
}

const write = (relative, mutate) => {
  const file = path.join(ROOT, relative)
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  mutate(manifest)
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

write('packages/durable-work/package.json', (manifest) => {
  manifest.version = version
})

write('packages/data-sync-durable/package.json', (manifest) => {
  manifest.version = version
  // The peer is what forbids a second copy of the mechanism in one process — it exports a
  // process-wide registry, and two copies would leave job kinds registered in one while the
  // worker reads the other. Pinning the range to the release keeps that guarantee specific
  // rather than "any version at all".
  if (manifest.peerDependencies?.[MECHANISM]) manifest.peerDependencies[MECHANISM] = `^${version}`
  if (manifest.devDependencies?.[MECHANISM]) manifest.devDependencies[MECHANISM] = `^${version}`
})

console.log(`set-release-version: both packages at ${version}, adopter peer ^${version}`)
