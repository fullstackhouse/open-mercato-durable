// Shared watch-mode helper for workspace packages: rebuilds a package's dist/ on
// every source change using the same esbuild options as its build.mjs.
//
//   import { watch } from '../../scripts/watch.mjs'
//   watch(__dirname)
import * as esbuild from 'esbuild'
import { glob } from 'glob'
import { spawn } from 'node:child_process'
import path from 'node:path'

export async function watch(packageDir) {
  const entryPoints = await glob('src/**/*.{ts,tsx}', {
    cwd: packageDir,
    ignore: ['**/__tests__/**', '**/__integration__/**', '**/*.test.ts', '**/*.test.tsx'],
    absolute: true,
  })
  const ctx = await esbuild.context({
    entryPoints,
    outdir: path.join(packageDir, 'dist'),
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    jsx: 'automatic',
    logLevel: 'info',
    plugins: [
      {
        name: 'rerun-build-script',
        setup(build) {
          // build.mjs also rewrites relative import extensions and copies assets;
          // re-run it after each incremental rebuild so dist/ stays publish-shaped.
          build.onEnd((result) => {
            if (result.errors.length > 0) return
            spawn(process.execPath, [path.join(packageDir, 'build.mjs')], { stdio: 'inherit' })
          })
        },
      },
    ],
  })
  await ctx.watch()
  console.log(`[watch] ${path.basename(packageDir)}: watching src/`)
}
