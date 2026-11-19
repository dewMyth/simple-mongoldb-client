import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@renderer': resolve(import.meta.dirname, 'src/renderer/src')
    }
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/renderer/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    // On GitHub Actions, failures also become annotations (readable without the job log).
    reporters: process.env['GITHUB_ACTIONS'] ? ['default', 'github-actions'] : ['default'],
    testTimeout: 60_000,
    hookTimeout: 180_000
  }
})
