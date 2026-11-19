import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  // One retry: Playwright's Electron support occasionally loses the page connection while the app
  // is fine (see tests/e2e/app.ts). Retried tests are reported as "flaky", not hidden.
  retries: 1,
  reporter: process.env['CI'] ? 'github' : 'list'
})
