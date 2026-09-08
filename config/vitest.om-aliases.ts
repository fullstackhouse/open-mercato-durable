import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

// The published @open-mercato packages use multi-star `exports` patterns
// (e.g. "./*/*/*") that Vite's resolver does not support (one "*" per pattern).
// Hosts consume them through Next/ts-jest, which tolerate them; for vitest we
// alias deep imports straight to the packages' shipped TypeScript sources.
// Resolution starts at the calling package so hoisting differences don't matter.
export function omSourceAliases(fromDir: string) {
  // `createRequire`, not bare `require`: vitest loads this config as ESM.
  const require = createRequire(path.join(fromDir, 'package.json'))

  // Those same `exports` patterns rewrite "./package.json" to "./src/package.json",
  // so the manifest is not resolvable by name. Resolve the entry point and walk up.
  const src = (pkg: string) => {
    const name = `@open-mercato/${pkg}`
    let dir = path.dirname(require.resolve(name, { paths: [fromDir] }))
    for (;;) {
      const manifest = path.join(dir, 'package.json')
      if (fs.existsSync(manifest)) {
        try {
          if (JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name) return path.join(dir, 'src')
        } catch {
          /* keep walking */
        }
      }
      const parent = path.dirname(dir)
      if (parent === dir) throw new Error(`vitest.om-aliases: could not locate the ${name} package root`)
      dir = parent
    }
  }

  return [
    { find: /^@open-mercato\/core\/(.*)$/, replacement: `${src('core')}/$1` },
    { find: /^@open-mercato\/shared\/(.*)$/, replacement: `${src('shared')}/$1` },
    { find: /^@open-mercato\/events\/(.*)$/, replacement: `${src('events')}/$1` },
    { find: /^@open-mercato\/queue\/(.*)$/, replacement: `${src('queue')}/$1` },
  ]
}
