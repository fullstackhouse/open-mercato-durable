// Per-file esbuild transpile: dist/ mirrors src/ one-to-one. The Open Mercato CLI
// resolves package-backed modules from node_modules/<pkg>/dist/modules/<id>/…, so
// the file layout is the contract (same shape as open-mercato/official-modules).
import * as esbuild from 'esbuild'
import { glob } from 'glob'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'))

const entryPoints = await glob('src/**/*.{ts,tsx}', {
  cwd: __dirname,
  ignore: ['**/__tests__/**', '**/__integration__/**', '**/*.test.ts', '**/*.test.tsx'],
  absolute: true,
})

if (entryPoints.length === 0) {
  console.error('No entry points found!')
  process.exit(1)
}

// esbuild leaves relative specifiers as written; Node ESM needs explicit .js.
const addJsExtension = {
  name: 'add-js-extension',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return
      const outputFiles = await glob('dist/**/*.js', { cwd: __dirname, absolute: true })
      for (const file of outputFiles) {
        const fileDir = dirname(file)
        let content = readFileSync(file, 'utf-8')
        const rewrite = (spec) => {
          if (spec.endsWith('.js') || spec.endsWith('.json')) return spec
          const resolved = join(fileDir, spec)
          if (existsSync(resolved) && existsSync(join(resolved, 'index.js'))) return `${spec}/index.js`
          return `${spec}.js`
        }
        content = content.replace(/from\s+["'](\.[^"']+)["']/g, (m, p) => m.replace(p, rewrite(p)))
        content = content.replace(/import\s*\(\s*["'](\.[^"']+)["']\s*\)/g, (m, p) => m.replace(p, rewrite(p)))
        writeFileSync(file, content)
      }
    })
  },
}

// Non-TS assets (module i18n JSON, migration snapshots) must exist under dist/ too.
const copyAssets = {
  name: 'copy-assets',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return
      const assets = await glob('src/**/*.json', { cwd: __dirname, absolute: true })
      for (const file of assets) {
        const dest = join(__dirname, 'dist', relative(join(__dirname, 'src'), file))
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(file, dest)
      }
    })
  },
}

await esbuild.build({
  entryPoints,
  outdir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  jsx: 'automatic',
  plugins: [addJsExtension, copyAssets],
})

console.log(`${pkg.name} built (${entryPoints.length} files)`)
