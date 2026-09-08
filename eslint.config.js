import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'generated/**', 'node_modules/**', 'coverage/**', '**/.mercato/**'],
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Build and mirror scripts run in Node, not in the app runtime.
    files: ['scripts/**/*.{js,mjs}', '*.mjs'],
    languageOptions: { globals: globals.node },
  },
)
