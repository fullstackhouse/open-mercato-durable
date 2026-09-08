import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

import manifest from '../mirror.manifest.json'

// Guards the three findings of the phase-0 mirror spike (docs/adr/0006). Each is a case
// where the Open Mercato generator reads a module's own file statically and therefore
// cannot see through `export * from '@open-mercato/core/...'`. Losing any of them is
// silent — the app boots, the module is registered, and only the affected contract is
// missing — so they are asserted rather than trusted.
const pkgDir = path.resolve(__dirname, '..', '..')
const moduleDir = path.join(pkgDir, 'src', 'modules', 'data_sync')
const require = createRequire(path.join(pkgDir, 'package.json'))

function corePackageRoot(): string {
  // The `exports` map rewrites "./package.json" to "./src/package.json"; walk up instead.
  let dir = path.dirname(require.resolve('@open-mercato/core'))
  for (;;) {
    const file = path.join(dir, 'package.json')
    if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).name === '@open-mercato/core') return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('could not locate @open-mercato/core')
    dir = parent
  }
}

const coreModuleDir = path.join(corePackageRoot(), 'src', 'modules', 'data_sync')
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

function walk(dir: string, rel = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const next = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) return entry.name.startsWith('__') ? [] : walk(path.join(dir, entry.name), next)
    return /\.tsx?$/.test(entry.name) ? [next] : []
  })
}

const coreApiFiles = walk(path.join(coreModuleDir, 'api')).map((rel) => `api/${rel}`)
// Mirrors `detectExportedHttpMethods` in @open-mercato/cli: declarations and named
// re-export blocks, both by regex over the file's own text.
function methodsOf(source: string): string[] {
  const found = new Set<string>()
  for (const m of HTTP_METHODS) {
    if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b|export\\s+(?:const|let|var)\\s+${m}\\b`).test(source)) found.add(m)
  }
  for (const match of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part.trim().split(/\s+as\s+/i).pop()?.trim()
      if (name && HTTP_METHODS.includes(name)) found.add(name)
    }
  }
  return HTTP_METHODS.filter((m) => found.has(m))
}

describe('data_sync mirror shape', () => {
  it('mirrors the core version the manifest was generated from', () => {
    expect(manifest.coreVersion).toBe(JSON.parse(fs.readFileSync(path.join(corePackageRoot(), 'package.json'), 'utf8')).version)
  })

  it('covers every core api file', () => {
    expect(coreApiFiles.length).toBeGreaterThan(0)
    for (const rel of coreApiFiles) expect(fs.existsSync(path.join(moduleDir, rel))).toBe(true)
  })

  // Finding 1: `detectExportedHttpMethods` is a regex over the file's own text.
  it('names every HTTP method core exports, so the route registers with the same methods', () => {
    for (const rel of coreApiFiles) {
      const expected = methodsOf(fs.readFileSync(path.join(coreModuleDir, rel), 'utf8'))
      if (!expected.length) continue
      expect({ rel, methods: methodsOf(fs.readFileSync(path.join(moduleDir, rel), 'utf8')) }).toEqual({ rel, methods: expected })
    }
  })

  // Finding 2: route `metadata` is read by AST, and carries requireAuth/requireFeatures.
  it('copies the route metadata literal rather than re-exporting it', () => {
    for (const rel of coreApiFiles) {
      const core = fs.readFileSync(path.join(coreModuleDir, rel), 'utf8')
      if (!methodsOf(core).length || !/export\s+const\s+metadata\s*=\s*\{/.test(core)) continue
      expect({ rel, copied: /export const metadata = \{/.test(fs.readFileSync(path.join(moduleDir, rel), 'utf8')) })
        .toEqual({ rel, copied: true })
    }
  })

  // Finding 3: entity ids and fields come from @Entity() classes a stub does not have,
  // so they ship as the package-level `generated/` descriptor the CLI looks for.
  it('ships an entity descriptor listing every entity core declares', () => {
    const coreEntities = [...fs.readFileSync(path.join(coreModuleDir, 'data', 'entities.ts'), 'utf8')
      .matchAll(/export\s+class\s+(\w+)/g)].map((m) => m[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase())
    expect(coreEntities.length).toBeGreaterThan(0)

    const ids = fs.readFileSync(path.join(pkgDir, 'generated', 'entities.ids.generated.ts'), 'utf8')
    for (const entity of coreEntities) {
      expect({ entity, declared: ids.includes(`"${entity}": "data_sync:${entity}"`) }).toEqual({ entity, declared: true })
      expect(fs.existsSync(path.join(pkgDir, 'generated', 'entities', entity, 'index.ts'))).toBe(true)
    }
  })

  // `data/entities.ts` must stay a re-export: the app spreads our namespace into MikroORM's
  // entity list, so copying the classes would register duplicates instead of core's.
  it('keeps the entities module a re-export so core keeps class identity', () => {
    const ours = fs.readFileSync(path.join(moduleDir, 'data', 'entities.ts'), 'utf8')
    expect(ours).toContain("export * from '@open-mercato/core/modules/data_sync/data/entities'")
    expect(ours).not.toMatch(/export\s+class\s/)
  })
})
