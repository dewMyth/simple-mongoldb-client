/**
 * Measures Phase 5's performance budgets against the built app (run `npm run build` first) and a
 * server seeded by scripts/seed-bench.ts.
 *
 *   npx tsx scripts/bench-ui.ts mongodb://127.0.0.1:27999 [pagesToVisit=2000]
 *
 * Prints a Markdown report and writes the raw numbers to bench-results.json.
 */
import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URI = process.argv[2] ?? 'mongodb://127.0.0.1:27999'
const PAGES = Number(process.argv[3] ?? 2000)
const RUNS = 5

interface PageMeasure {
  startTime: number
  duration: number
  queryMs: number
  renderMs: number
  viewMode: string
  docs: number
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? NaN
}
const round = (n: number) => Math.round(n * 10) / 10

async function measures(page: Page): Promise<PageMeasure[]> {
  return page.evaluate(() =>
    performance.getEntriesByName('ms:page').map(
      (e) =>
        ({
          startTime: e.startTime,
          duration: e.duration,
          ...((e as PerformanceMeasure).detail as object)
        }) as never
    )
  )
}

/** Runs `action` and returns the page measure it produces. */
async function nextMeasure(page: Page, action: () => Promise<void>): Promise<PageMeasure> {
  // Only accept a measure that starts after the action: a page measure from the previous action
  // can land late (it's recorded two animation frames after paint).
  const since = await page.evaluate(() => performance.now())
  await action()
  for (let i = 0; i < 600; i++) {
    const fresh = (await measures(page)).filter((m) => m.startTime >= since)
    if (fresh.length) return fresh[fresh.length - 1]!
    await page.waitForTimeout(25)
  }
  throw new Error('No page measure recorded within 15 s')
}

async function rendererMemory(app: ElectronApplication, page: Page) {
  await page.evaluate(() => (globalThis as unknown as { gc?: () => void }).gc?.())
  await page.waitForTimeout(500)
  const heap = await page.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0
  )
  const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics())
  const renderer = metrics.find((m) => m.type === 'Tab')
  const browser = metrics.find((m) => m.type === 'Browser')
  return {
    rendererJsHeapMB: round(heap / 1048576),
    rendererWorkingSetMB: round((renderer?.memory.workingSetSize ?? 0) / 1024),
    mainWorkingSetMB: round((browser?.memory.workingSetSize ?? 0) / 1024)
  }
}

/**
 * In-page scripts are plain strings: tsx (esbuild) wraps named functions in a `__name` helper that
 * doesn't exist inside the page, so serialized callbacks with inner functions would fail.
 */
const SCROLL_SCRIPT = `new Promise((resolve) => {
  const el = document.querySelector('[data-testid="results-list"]')
  const deltas = []
  let last = performance.now()
  let dir = 1
  const start = last
  function step(now) {
    deltas.push(now - last)
    last = now
    el.scrollTop += 40 * dir
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) dir = -1
    if (el.scrollTop <= 0) dir = 1
    if (now - start < 4000) return requestAnimationFrame(step)
    deltas.shift()
    const sorted = [...deltas].sort((a, b) => a - b)
    resolve({
      frames: deltas.length,
      fps: (deltas.length / (now - start)) * 1000,
      p95FrameMs: sorted[Math.floor(sorted.length * 0.95)],
      // Slow = longer than 1.5x a 60 Hz frame.
      slowFrames: deltas.filter((d) => d > 25).length,
      refreshHz: 1000 / sorted[Math.floor(sorted.length / 2)]
    })
  }
  requestAnimationFrame(step)
})`

/** Scrolls the results list with rAF for ~4 s; reports frame statistics. */
async function scrollFps(page: Page) {
  return page.evaluate(SCROLL_SCRIPT) as Promise<{
    frames: number
    fps: number
    p95FrameMs: number
    slowFrames: number
    refreshHz: number
  }>
}

async function startLongTasks(page: Page) {
  await page.evaluate(`(() => {
    window.__long = []
    new PerformanceObserver((list) => window.__long.push(...list.getEntries().map((e) => e.duration))).observe({ type: 'longtask' })
  })()`)
}
const longTasks = (page: Page) => page.evaluate(() => (window as unknown as { __long: number[] }).__long)

async function main() {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  const userData = mkdtempSync(join(tmpdir(), 'mongo-studio-bench-'))
  const app = await _electron.launch({
    args: ['.', `--user-data-dir=${userData}`, '--js-flags=--expose-gc', '--enable-precise-memory-info'],
    env
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  const results: Record<string, unknown> = {
    uri: URI.replace(/\/\/[^@]*@/, '//'),
    date: new Date().toISOString()
  }

  try {
    await page.getByTestId('new-connection').click()
    await page.getByTestId('conn-name').fill('bench')
    await page.getByTestId('conn-uri').fill(URI)
    await page.getByTestId('save-connect').click()
    await page.getByTestId('db-bench').click()
    await page.getByTestId('coll-bench.docs').click()
    await page.getByTestId('page-range').waitFor()
    const find = () => page.getByTestId('run-query').click()

    // (a) First page per view.
    const firstPage: Record<string, unknown> = {}
    for (const view of ['tree', 'json', 'table'] as const) {
      await page.getByTestId(`view-${view}`).click()
      const runs: PageMeasure[] = []
      for (let i = 0; i < RUNS; i++) runs.push(await nextMeasure(page, find))
      firstPage[view] = {
        totalMs: round(median(runs.map((r) => r.duration))),
        queryMs: round(median(runs.map((r) => r.queryMs))),
        renderMs: round(median(runs.map((r) => r.renderMs)))
      }
    }
    results['firstPage'] = firstPage

    // Deep page: "Last" on 1M documents means skip ≈ 999,975.
    await page.getByTestId('view-tree').click()
    await nextMeasure(page, find)
    const last = await nextMeasure(page, () => page.getByTestId('page-last').click())
    results['lastPage'] = {
      totalMs: round(last.duration),
      queryMs: round(last.queryMs),
      renderMs: round(last.renderMs),
      range: await page.getByTestId('page-range').textContent()
    }
    await nextMeasure(page, () => page.getByTestId('page-first').click())

    // (b) Scrolling a fully expanded page.
    await page.getByTestId('expand-all').click()
    await page.waitForTimeout(500)
    results['scrollTree'] = await scrollFps(page)
    await page.getByTestId('expand-all').click()
    await page.getByTestId('view-json').click()
    await page.waitForTimeout(500)
    results['scrollJson'] = await scrollFps(page)
    await page.getByTestId('view-tree').click()

    // (c) Memory after paging through PAGES × 25 documents.
    results['memoryBefore'] = await rendererMemory(app, page)
    const t0 = Date.now()
    for (let i = 0; i < PAGES; i++) {
      const expected = `${((i + 1) * 25 + 1).toLocaleString()}–` // matches the app (1,001–1,025)
      await page.getByTestId('page-next').click()
      await page.getByTestId('page-range').filter({ hasText: expected }).waitFor({ timeout: 15_000 })
      if ((i + 1) % 500 === 0) console.error(`  paged ${(i + 1) * 25} documents`)
    }
    results['paging'] = { pages: PAGES, documents: PAGES * 25, seconds: round((Date.now() - t0) / 1000) }
    results['memoryAfter'] = await rendererMemory(app, page)

    // (d) ~10 MB documents.
    await page.getByTestId('db-bench').click()
    await page.getByTestId('db-bench').click()
    await page.getByTestId('coll-bench.huge').click({ modifiers: ['ControlOrMeta'] })
    await page.getByTestId('page-range').waitFor()
    const huge: Record<string, unknown> = {}
    for (const view of ['tree', 'json', 'table'] as const) {
      await page.getByTestId(`view-${view}`).click()
      await startLongTasks(page)
      const m = await nextMeasure(page, find)
      const lt = await longTasks(page)
      huge[view] = {
        totalMs: round(m.duration),
        queryMs: round(m.queryMs),
        renderMs: round(m.renderMs),
        longestBlockMs: round(Math.max(0, ...lt)),
        longTasks: lt.length
      }
    }
    // Expanding the 10 MB array (first 50 of ~170k items).
    await page.getByTestId('view-tree').click()
    await startLongTasks(page)
    const t1 = performance.now()
    await page.locator('[data-path="array"]').first().click()
    await page.locator('[data-path="array.49"]').first().waitFor()
    huge['expandArrayMs'] = round(performance.now() - t1)
    huge['expandArrayLongestBlockMs'] = round(Math.max(0, ...(await longTasks(page))))
    results['huge'] = huge
    results['memoryEnd'] = await rendererMemory(app, page)
  } finally {
    await app.close()
  }

  writeFileSync('bench-results.json', JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
}

void main()
