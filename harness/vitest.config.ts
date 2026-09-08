import { defineConfig } from 'vitest/config'

// Every suite is parameterised by DURABLE_TRANSPORT (memory | bullmq | pgboss).
// Real Postgres/Redis come from testcontainers unless HARNESS_PG_URL / HARNESS_REDIS_URL
// are set (CI provides services), see src/env.ts.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/suites/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
})
