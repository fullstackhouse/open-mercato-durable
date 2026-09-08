import { defineConfig } from 'vitest/config'
import { omSourceAliases } from '../../config/vitest.om-aliases'

export default defineConfig({
  // MikroORM entities in @open-mercato sources use legacy decorators.
  esbuild: {
    tsconfigRaw: {
      compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false },
    },
  },
  resolve: { alias: omSourceAliases(__dirname) },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/__integration__/**'],
  },
})
