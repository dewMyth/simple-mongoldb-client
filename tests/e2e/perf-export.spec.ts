/**
 * Done when: exporting 1M docs keeps main-process memory < 300 MB.
 * Opt-in (seeding 1M documents takes a while): PERF=1 npm run test:e2e -- perf-export
 */
import { expect, test } from '@playwright/test'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { launchApp } from './app'

const N = 1_000_000
test.skip(!process.env.PERF, 'set PERF=1 to run the 1M-document export benchmark')

test('Done when: exporting 1M documents keeps main-process memory under 300 MB', async () => {
  test.setTimeout(15 * 60_000)
  const server = await MongoMemoryServer.create()
  const admin = await MongoClient.connect(server.getUri())
  const coll = admin.db('bench').collection<{ _id: number; [k: string]: unknown }>('orders')
  const t0 = Date.now()
  for (let b = 0; b < N / 10_000; b++)
    await coll.insertMany(
      Array.from({ length: 10_000 }, (_, i) => {
        const n = b * 10_000 + i
        return {
          _id: n,
          customer: { name: `Customer ${n % 5000}`, tier: ['gold', 'silver', 'bronze'][n % 3] },
          status: ['new', 'paid', 'shipped', 'cancelled'][n % 4],
          total: (n % 1000) + 0.99,
          items: [{ sku: `SKU-${n % 200}`, qty: (n % 5) + 1 }],
          createdAt: new Date(Date.UTC(2026, 0, 1) + n * 1000)
        }
      }),
      { ordered: false }
    )
  const seedMs = Date.now() - t0

  const file = join(mkdtempSync(join(tmpdir(), 'ms-perf-')), 'orders.jsonl')
  const { app, page } = await launchApp()
  try {
    await app.evaluate(({ dialog }, p) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: p
      })) as unknown as typeof dialog.showSaveDialog
    }, file)
    await page.getByTestId('new-connection').click()
    await page.getByTestId('conn-name').fill('Bench')
    await page.getByTestId('conn-uri').fill(server.getUri())
    await page.getByTestId('save-connect').click()
    await page.getByTestId('db-bench').click()
    await page.getByTestId('coll-bench.orders').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Export collection…' }).click()
    await page.getByTestId('export-format-jsonl').click()

    // Sample inside the main process every 10 ms (an export can finish in a few seconds).
    const baselineMem = await app.evaluate(() => process.memoryUsage())
    const baseline = baselineMem.rss
    await app.evaluate(() => {
      const g = globalThis as { __memPeak?: NodeJS.MemoryUsage; __memTimer?: ReturnType<typeof setInterval> }
      g.__memPeak = process.memoryUsage()
      g.__memTimer = setInterval(() => {
        const m = process.memoryUsage()
        if (m.rss > g.__memPeak!.rss) g.__memPeak = m
      }, 10)
    })
    const t1 = Date.now()
    await page.getByTestId('export-start').click()
    await expect(page.getByTestId('job-status')).toHaveAttribute('data-status', 'done', {
      timeout: 10 * 60_000
    })
    const exportMs = Date.now() - t1
    const atPeak = await app.evaluate(() => {
      const g = globalThis as { __memPeak?: NodeJS.MemoryUsage; __memTimer?: ReturnType<typeof setInterval> }
      clearInterval(g.__memTimer)
      return g.__memPeak!
    })
    const peak = atPeak.rss
    await expect(page.getByTestId('job-summary')).toContainText(`Exported ${N.toLocaleString()} documents`)

    const mb = (n: number) => Math.round(n / 1024 / 1024)
    console.log(
      `[perf-export] seed ${(seedMs / 1000).toFixed(1)} s · export ${N.toLocaleString()} docs in ${(exportMs / 1000).toFixed(1)} s ` +
        `(${Math.round(N / (exportMs / 1000)).toLocaleString()} docs/s) · file ${mb(statSync(file).size)} MB · ` +
        `main RSS ${mb(baseline)} MB → peak ${mb(peak)} MB ` +
        `(heap ${mb(baselineMem.heapTotal)} → ${mb(atPeak.heapTotal)} MB, external ${mb(baselineMem.external)} → ${mb(atPeak.external)} MB)`
    )
    expect(peak).toBeLessThan(300 * 1024 * 1024)
  } finally {
    await app.close()
    await admin.close()
    await server.stop()
  }
})
