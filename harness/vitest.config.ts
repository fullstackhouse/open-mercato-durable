import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

// Every suite is parameterised by DURABLE_TRANSPORT (memory | bullmq | pgboss).
// Real Postgres/Redis come from testcontainers unless HARNESS_PG_URL / HARNESS_REDIS_URL
// are set (CI provides services), see src/env.ts.
export default defineConfig({
  resolve: {
    alias: [
      // Vite does not resolve this package's `exports` subpaths the way Node does (verified:
      // `require.resolve` finds it, Vite does not), and importing the package root instead
      // would drag its whole Open Mercato module surface — React, Next — into a harness that
      // wants one SQL helper.
      {
        find: /^@fullstackhouse\/open-mercato-data-sync-durable\/(.*)$/,
        replacement: fileURLToPath(new URL('../packages/data-sync-durable/src/', import.meta.url)) + '$1',
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/suites/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
})
