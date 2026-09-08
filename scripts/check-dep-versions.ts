/**
 * Checks that no package appears at conflicting major versions in production `dependencies`
 * across workspace package.json files.
 *
 * Run with: yarn check:dep-versions
 *
 * Background: with Yarn node-modules hoisting, a mismatch in major versions between a full dev
 * install and a production-focused install (`yarn workspaces focus --production`) can cause
 * different versions to be hoisted, leading to runtime errors in Docker that don't reproduce
 * locally. This script catches such drift before it reaches the CI/Docker build.
 *
 * Only production `dependencies` are checked — devDependencies and peerDependencies are excluded
 * because they cannot cause Docker hoisting issues.
 *
 * A second check covers the framework packages the sandbox and our packages BOTH install
 * (next, react, react-dom). Those must match exactly, devDependencies included: our packages
 * pin them only to typecheck against, but yarn hoists one copy and nests the other, and the app
 * then runs a mixed pair. That failure is not a version error — it is a Turbopack panic deep in
 * middleware compilation ("Expected to inject all imports"), with nothing pointing at the cause.
 */

import fs from 'fs'
import { globSync } from 'glob'

// Exclude apps that are not part of the production Docker image (e.g. docs site)
const WORKSPACE_PATTERNS = ['package.json', 'packages/*/package.json', 'apps/sandbox/package.json']

function majorOf(version: string): string | null {
  const cleaned = version.replace(/^[\^~>=<\s]+/, '').trim()
  const match = cleaned.match(/^(\d+)/)
  return match ? match[1] : null
}

function collectVersions(): Map<string, Map<string, string[]>> {
  // package → major → [sources]
  const index = new Map<string, Map<string, string[]>>()

  for (const pattern of WORKSPACE_PATTERNS) {
    const files = globSync(pattern, { cwd: process.cwd() })
    for (const file of files) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
      const deps: Record<string, string> = raw['dependencies'] ?? {}

      for (const [pkg, version] of Object.entries(deps)) {
        if (version.startsWith('workspace:')) continue
        const major = majorOf(version)
        if (!major) continue

        if (!index.has(pkg)) index.set(pkg, new Map())
        const majors = index.get(pkg)!
        if (!majors.has(major)) majors.set(major, [])
        majors.get(major)!.push(`${file} (${version})`)
      }
    }
  }

  return index
}

// Installed once per workspace but shared by hoisting: an exact-version split is a real bug,
// so these are compared across every dependency scope, not just production.
const EXACT_MATCH_PACKAGES = ['next', 'react', 'react-dom']

function collectExactVersions(): Map<string, Map<string, string[]>> {
  const index = new Map<string, Map<string, string[]>>()
  for (const pattern of WORKSPACE_PATTERNS) {
    for (const file of globSync(pattern, { cwd: process.cwd() })) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
      for (const scope of ['dependencies', 'devDependencies'] as const) {
        for (const [pkg, version] of Object.entries((raw[scope] ?? {}) as Record<string, string>)) {
          if (!EXACT_MATCH_PACKAGES.includes(pkg) || version.startsWith('workspace:')) continue
          if (!index.has(pkg)) index.set(pkg, new Map())
          const versions = index.get(pkg)!
          if (!versions.has(version)) versions.set(version, [])
          versions.get(version)!.push(`${file} (${scope})`)
        }
      }
    }
  }
  return index
}

const index = collectVersions()
let failed = false

for (const [pkg, versions] of collectExactVersions().entries()) {
  if (versions.size <= 1) continue

  failed = true
  console.error(`\n✖ ${pkg} is pinned at more than one version; yarn will install two copies`)
  for (const [version, sources] of versions.entries()) {
    console.error(`  ${version}:`)
    for (const src of sources) console.error(`    - ${src}`)
  }
  console.error(`  Fix: match apps/sandbox's pin (it is the app that actually runs).`)
}

for (const [pkg, majors] of index.entries()) {
  if (majors.size <= 1) continue

  failed = true
  console.error(`\n✖ Major version conflict in production dependencies: ${pkg}`)
  for (const [major, sources] of majors.entries()) {
    console.error(`  v${major}:`)
    for (const src of sources) console.error(`    - ${src}`)
  }
}

if (failed) {
  console.error(
    '\nFix: align all usages to the same version across workspaces.\n' +
      'If a conflict is unavoidable, add a "resolutions" entry in root package.json to pin the version.',
  )
  process.exit(1)
} else {
  console.log('✔ No version conflicts across workspaces.')
}
