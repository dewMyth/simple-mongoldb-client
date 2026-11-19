import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
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
  return { ...env, NODE_ENV: 'test', MONGO_STUDIO_E2E: '1', ...extra }
}

/**
 * Playwright's Electron support sometimes loses its DevTools connection to the page while the
 * app itself is fine (the window stays open on the right URL, with no navigation or renderer
 * crash: see the main-side events below). Launches are retried when that happens before the app
 * has rendered, `app.close()` can't hang on a lost connection, and every occurrence is logged
 * with evidence ("[e2e] …") so it stays visible.
 */
const LAUNCH_ATTEMPTS = 2

/**
 * Launches the built app with an isolated user-data dir so tests never touch real settings.
 * Pass a previous run's `userData` to simulate a restart.
 */
export async function launchApp(
  existingUserData?: string
): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = existingUserData ?? mkdtempSync(join(tmpdir(), 'mongo-studio-e2e-'))
  for (let attempt = 1; ; attempt++) {
    try {
      return { ...(await launchOnce(userData)), userData }
    } catch (err) {
      if (attempt >= LAUNCH_ATTEMPTS) throw err
      console.log(
        `[e2e] Launch attempt ${attempt} failed, retrying: ${(err as Error).message.split('\n')[0]}`
      )
    }
  }
}

async function launchOnce(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const t0 = Date.now()
  const exe = process.env['E2E_EXECUTABLE']
  const args = [`--user-data-dir=${userData}`]
  // Headless Linux has no desktop session to pick the keyring from (see scripts/linux-e2e.sh).
  if (process.platform === 'linux') args.push('--password-store=gnome-libsecret')
  const app = await electron.launch(
    // E2E_EXECUTABLE runs the tests against a packaged app (see tests/e2e/smoke.spec.ts).
    exe ? { executablePath: exe, args, env: electronEnv() } : { args: ['.', ...args], env: electronEnv() }
  )
  // Keep the main process's output: it's the evidence if something goes wrong.
  const output: string[] = []
  app.process().stdout?.on('data', (d) => output.push(String(d)))
  app.process().stderr?.on('data', (d) => output.push(String(d)))
  // Kills the app and every process it started: on Linux, Chromium's zygote/GPU/renderer processes
  // outlive a killed main process and keep Playwright's pipes open (the worker then never tears down).
  const pid = app.process().pid
  const kill = (tree = descendants(pid)) => {
    for (const p of [...tree, pid]) {
      try {
        if (p) process.kill(p, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
  const report = (what: string) =>
    console.log(`[e2e] ${what} (pid ${app.process().pid}).\nMain output:\n${output.join('').slice(-4000)}`)

  let closing = false
  const close = app.close.bind(app)
  // A lost connection would otherwise make close() hang until the worker teardown timeout.
  app.close = async () => {
    closing = true
    const tree = descendants(pid) // before closing: afterwards the survivors are re-parented
    await Promise.race([close(), new Promise((r) => setTimeout(r, 10_000))])
    kill(tree)
  }

  let page: Page
  try {
    page = await app.firstWindow({ timeout: 30_000 })
    await page.waitForLoadState('domcontentloaded')
    // The app has rendered (and the page is still attached).
    await page.getByTestId('tab-bar').waitFor({ timeout: 30_000 })
    // A fixed window size on every OS, whatever the screen (CI screens are small, and Monaco
    // soft-wraps narrow editors, which changes the rendered text tests read).
    // E2E_WINDOW=900x600 runs the suite at another size (e.g. to check narrow layouts).
    const size = /^(\d+)x(\d+)$/.exec(process.env['E2E_WINDOW'] ?? '1400x900')
    if (size)
      await app.evaluate(
        ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]?.setSize(w!, h!),
        [Number(size[1]), Number(size[2])]
      )
  } catch (err) {
    const state = await Promise.race([
      app
        .evaluate(({ app: a, BrowserWindow }) => ({
          ready: a.isReady(),
          windows: BrowserWindow.getAllWindows().map(
            (w) => `${w.isDestroyed() ? 'destroyed' : 'open'} ${w.webContents.getURL()}`
          )
        }))
        .then((s) => JSON.stringify(s)),
      new Promise<string>((r) => setTimeout(() => r('main process unresponsive'), 3000))
    ]).catch((e: Error) => `evaluate failed: ${e.message}`)
    closing = true
    kill()
    throw new Error(
      `App didn't come up after ${Date.now() - t0} ms (${state}; ${(err as Error).message.split('\n')[0]}).\nMain output:\n${output.join('').slice(-3000)}`,
      { cause: err }
    )
  }

  // Main-side record of what happens to the window, read back if the page closes unexpectedly.
  await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as { __e2eEvents?: string[] }
    const events: string[] = (g.__e2eEvents = [])
    const at = () => new Date().toISOString().slice(11, 23)
    for (const win of BrowserWindow.getAllWindows()) {
      const wc = win.webContents
      win.on('closed', () => events.push(`${at()} window closed`))
      wc.on('did-start-navigation', (d) =>
        events.push(`${at()} navigation ${d.url} main=${d.isMainFrame} same=${d.isSameDocument}`)
      )
      wc.on('render-process-gone', (_e, d) =>
        events.push(`${at()} renderer gone: ${d.reason} (${d.exitCode})`)
      )
      wc.on('destroyed', () => events.push(`${at()} webContents destroyed`))
      wc.on('unresponsive', () => events.push(`${at()} unresponsive`))
    }
  })
  page.on('crash', () => report('Renderer crashed'))
  page.on('console', (m) => m.type() === 'error' && output.push(`[renderer error] ${m.text()}\n`))
  page.on('pageerror', (e) => output.push(`[renderer exception] ${e.message}\n`))
  page.on('close', () => {
    if (closing) return
    void Promise.race([
      app.evaluate(({ BrowserWindow }) => ({
        events: (globalThis as { __e2eEvents?: string[] }).__e2eEvents ?? [],
        windows: BrowserWindow.getAllWindows().map(
          (w) => `${w.isDestroyed() ? 'destroyed' : 'open'} ${w.webContents.getURL()}`
        )
      })),
      new Promise((r) => setTimeout(() => r('main unresponsive'), 3000))
    ])
      .then((state) =>
        report(
          `Page closed unexpectedly; main state: ${JSON.stringify(state)}; pages: ${app.windows().length}`
        )
      )
      .catch((e: Error) => report(`Page closed unexpectedly; evaluate failed: ${e.message}`))
  })
  app.process().on('exit', (code, signal) => {
    if (!closing) report(`Main process exited unexpectedly with code ${code}, signal ${signal}`)
  })
  return { app, page }
}

/** Process ids started (transitively) by `pid`. Empty on Windows, where the process tree is killed differently. */
function descendants(pid: number | undefined): number[] {
  if (!pid || process.platform === 'win32') return []
  let table: string
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
  } catch {
    return []
  }
  const children = new Map<number, number[]>()
  for (const line of table.split('\n')) {
    const [c, p] = line.trim().split(/\s+/).map(Number)
    if (c && p) children.set(p, [...(children.get(p) ?? []), c])
  }
  const out: number[] = []
  const walk = (p: number) => {
    for (const c of children.get(p) ?? []) {
      out.push(c)
      walk(c)
    }
  }
  walk(pid)
  return out
}
