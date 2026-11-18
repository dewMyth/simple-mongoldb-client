import { expect, test } from '@playwright/test'
import { electronEnv, launchApp } from './app'

test('launches with the expected window title and layout', async () => {
  const { app, page } = await launchApp()
  try {
    await expect(page).toHaveTitle('Mongo Studio')
    await expect(page.getByTestId('sidebar')).toBeVisible()
    await expect(page.getByTestId('tab-bar')).toBeVisible()
    await expect(page.getByTestId('main-panel')).toBeVisible()
    await expect(page.getByTestId('status-bar')).toContainText('v0.1.0')
  } finally {
    await app.close()
  }
})

test('renderer has no Node.js access', async () => {
  const { app, page } = await launchApp()
  try {
    const globals = await page.evaluate(() => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (globalThis as unknown as { process?: unknown }).process,
      module: typeof (globalThis as unknown as { module?: unknown }).module,
      api: typeof window.api,
      invoke: typeof window.api?.invoke
    }))
    expect(globals).toEqual({
      require: 'undefined',
      process: 'undefined',
      module: 'undefined',
      api: 'object',
      invoke: 'function'
    })
  } finally {
    await app.close()
  }
})

test('window.open and external navigation are blocked', async () => {
  const { app, page } = await launchApp()
  try {
    const opened = await page.evaluate(() => window.open('https://example.com') === null)
    expect(opened).toBe(true)
    expect(app.windows()).toHaveLength(1)
    const before = page.url()
    await page.evaluate(() => {
      window.location.href = 'https://example.com'
    })
    await page.waitForTimeout(300)
    expect(page.url()).toBe(before)
  } finally {
    await app.close()
  }
})

test('theme toggle cycles and persists across restarts', async () => {
  const first = await launchApp()
  const html = first.page.locator('html')
  const toggle = first.page.getByTestId('theme-toggle')
  await toggle.click() // system -> light
  await expect(html).not.toHaveClass(/dark/)
  await toggle.click() // light -> dark
  await expect(html).toHaveClass(/dark/)
  await first.app.close()

  const { _electron } = await import('@playwright/test')
  const app = await _electron.launch({ args: ['.', `--user-data-dir=${first.userData}`], env: electronEnv() })
  try {
    const page = await app.firstWindow()
    await expect(page.locator('html')).toHaveClass(/dark/)
  } finally {
    await app.close()
  }
})

test('IPC rejects invalid input and unknown channels', async () => {
  const { app, page } = await launchApp()
  try {
    const result = await page.evaluate(async () => {
      const bad = await window.api.invoke('settings:setTheme', 'purple' as never)
      let unknown = ''
      try {
        await window.api.invoke('nope' as never)
      } catch (e) {
        unknown = (e as Error).message
      }
      return { bad, unknown }
    })
    expect(result.bad).toMatchObject({ ok: false, error: { validation: true } })
    expect(result.unknown).toContain('Unknown IPC channel')
  } finally {
    await app.close()
  }
})
