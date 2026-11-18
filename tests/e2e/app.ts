import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Environment for the Electron child. ELECTRON_RUN_AS_NODE leaks in from VS Code / other Electron hosts
 * and would make the app start as plain Node, so it is always removed.
 */
export function electronEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  return { ...env, NODE_ENV: 'test', ...extra }
}

/** Launches the built app with an isolated user-data dir so tests never touch real settings. */
export async function launchApp(): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = mkdtempSync(join(tmpdir(), 'mongo-studio-e2e-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: electronEnv()
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, userData }
}
