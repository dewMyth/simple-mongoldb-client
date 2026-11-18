import { expect, test, type Page } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { launchApp } from './app'

let server: MongoMemoryServer
let admin: MongoClient
const COLLS = Array.from({ length: 7 }, (_, i) => `c${i + 1}`)

test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await MongoMemoryServer.create()
  admin = await MongoClient.connect(server.getUri())
  for (const c of COLLS)
    await admin
      .db('shop')
      .collection(c)
      .insertMany(
        Array.from({ length: 60 }, (_, i) => ({
          i,
          coll: c,
          status: i % 2 ? 'paid' : 'new',
          customer: { name: `n${i}`, tags: ['a', 'b'] },
          createdAt: new Date(Date.UTC(2026, 0, 1 + (i % 28)))
        }))
      )
})

test.afterAll(async () => {
  await admin?.close()
  await server?.stop()
})

async function addConnection(page: Page, name: string, opts: { production?: boolean } = {}) {
  await page.getByTestId('new-connection').click()
  await page.getByTestId('conn-name').fill(name)
  await page.getByTestId('conn-uri').fill(server.getUri())
  if (opts.production) await page.getByLabel('Production (confirm every write)').click()
  await page.getByTestId('save-connect').click()
  await expect(page.getByTestId(`conn-${name}`)).toBeVisible()
}

/** Opens shop.<coll> on the n-th connected connection (sidebar order). */
async function openColl(page: Page, conn: number, coll: string) {
  const db = page.getByTestId('db-shop').nth(conn)
  if (
    !(await page
      .getByTestId(`coll-shop.${coll}`)
      .nth(conn)
      .isVisible()
      .catch(() => false))
  )
    await db.click()
  await page.getByTestId(`coll-shop.${coll}`).nth(conn).click()
}

const filterText = (page: Page, pane = 'primary') =>
  page
    .getByTestId(`pane-${pane}`)
    .getByTestId('filter-editor')
    .locator('.view-lines')
    .innerText()
    .then((t) => t.replace(/\u00a0/g, ' '))

async function setFilter(page: Page, text: string) {
  await page.getByTestId('pane-primary').getByTestId('filter-editor').locator('.view-lines').click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await expect(
    page.getByTestId('pane-primary').getByTestId('filter-editor').locator('.view-lines')
  ).toHaveText('')
  await page.keyboard.insertText(text)
}

test('Done when: restart restores all tabs with their queries (not re-run), pins and split view', async () => {
  const first = await launchApp()
  const userData = first.userData
  try {
    const { page } = first
    await addConnection(page, 'Local')
    await openColl(page, 0, 'c1')
    await setFilter(page, '{ status: "paid" }')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByTestId('result-count')).toHaveText('30 documents')
    await openColl(page, 0, 'c2')
    await expect(page.getByTestId('result-count')).toHaveText('60 documents')
    await setFilter(page, '{ i: { $lt: 5 } }') // typed but never run
    await openColl(page, 0, 'c3')
    await page.getByTestId('tab-shop.c3').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Pin' }).click()
    await page.getByTestId('tab-shop.c2').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Split right' }).click()
    await expect(page.getByTestId('pane-secondary')).toBeVisible()
    await page.waitForTimeout(600) // debounced save
  } finally {
    await first.app.close()
  }

  const second = await launchApp(userData)
  try {
    const { page } = second
    const tabs = page.getByRole('tab')
    await expect(tabs).toHaveCount(3)
    // Pinned first, then the rest in order.
    await expect(tabs.nth(0)).toHaveAttribute('data-testid', 'tab-shop.c3')
    await expect(tabs.nth(0)).toHaveAttribute('data-pinned', 'true')
    await expect(page.getByTestId('pane-secondary')).toBeVisible()

    // Not connected yet: the tab offers to connect and keeps the query.
    await expect(page.getByTestId('pane-secondary').getByTestId('reconnect-tab')).toContainText(
      '{ i: { $lt: 5 } }'
    )
    await page.getByTestId('pane-secondary').getByTestId('reconnect-button').click()

    // Restored queries are not re-run.
    await expect(page.getByTestId('pane-secondary').getByTestId('restored-hint')).toBeVisible()
    await expect.poll(() => filterText(page, 'secondary')).toContain('{ i: { $lt: 5 } }')

    // The secondary pane has focus (Connect was clicked there), so the tab opens in it.
    await page.getByTestId('tab-shop.c1').click()
    await expect(page.getByTestId('tab-shop.c1')).toHaveAttribute('data-pane', 'secondary')
    await expect.poll(() => filterText(page, 'secondary')).toContain('{ status: "paid" }')
    const secondary = page.getByTestId('pane-secondary')
    await expect(secondary.getByTestId('restored-hint')).toBeVisible()
    await secondary.getByTestId('run-query').click()
    await expect(secondary.getByTestId('result-count')).toHaveText('30 documents')

    // The pinned tab stays in the primary pane.
    await expect(page.getByTestId('pane-primary')).toHaveAttribute(
      'data-tab-id',
      (await page.getByTestId('tab-shop.c3').getAttribute('data-tab-id')) ?? ''
    )
  } finally {
    await second.app.close()
  }
})

test('tab menu: duplicate, close others, reopen closed (Cmd/Ctrl+Shift+T), split and close split', async () => {
  const { app, page } = await launchApp()
  try {
    await addConnection(page, 'Local')
    await openColl(page, 0, 'c1')
    await openColl(page, 0, 'c2')
    await openColl(page, 0, 'c3')
    // Cmd/Ctrl+click opens another tab for the same collection.
    await page.getByTestId('coll-shop.c1').click({ modifiers: ['ControlOrMeta'] })
    await expect(page.getByRole('tab')).toHaveCount(4)

    await page.getByTestId('tab-shop.c2').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Duplicate' }).click()
    await expect(page.getByTestId('tab-shop.c2')).toHaveCount(2)

    await page.getByTestId('tab-shop.c3').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close others' }).click()
    await expect(page.getByRole('tab')).toHaveCount(1)

    await page.keyboard.press('ControlOrMeta+Shift+T')
    await page.keyboard.press('ControlOrMeta+Shift+T')
    await expect(page.getByRole('tab')).toHaveCount(3)

    await page.getByTestId('tab-shop.c3').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Split down' }).click()
    await expect(page.getByTestId('main-panel')).toHaveAttribute('data-split', 'vertical')
    await expect(page.getByTestId('pane-secondary').getByTestId('result-count')).toHaveText('60 documents')
    await page.getByTestId('close-split').click()
    await expect(page.getByTestId('pane-secondary')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('command palette: jump to a collection, switch tabs, re-run a recent query', async () => {
  const { app, page } = await launchApp()
  try {
    await addConnection(page, 'Local')
    await openColl(page, 0, 'c1')
    await setFilter(page, '{ i: { $gte: 50 } }')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByTestId('result-count')).toHaveText('10 documents')

    // Jump to a collection that has no tab yet.
    await page.keyboard.press('ControlOrMeta+K')
    await page.getByTestId('palette-input').fill('shop.c5')
    await page.getByTestId('palette-coll-shop.c5').click()
    await expect(page.getByTestId('tab-shop.c5')).toHaveAttribute('data-pane', 'primary')

    // Switch back to an open tab (works while Monaco has focus too).
    await page.getByTestId('pane-primary').getByTestId('filter-editor').locator('.view-lines').click()
    await page.keyboard.press('ControlOrMeta+K')
    await page.getByTestId('palette-input').fill('tab c1')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('tab-shop.c1')).toHaveAttribute('data-pane', 'primary')

    // Re-run a recent query from another tab: opens its collection with the query and runs it.
    await page.getByTestId('tab-shop.c5').click()
    await setFilter(page, '{}')
    await page.keyboard.press('ControlOrMeta+K')
    await page.getByTestId('palette-input').fill('$gte: 50')
    await page.getByTestId('palette-recent').first().click()
    await expect(page.getByTestId('tab-shop.c1')).toHaveAttribute('data-pane', 'primary')
    await expect(page.getByTestId('result-count')).toHaveText('10 documents')
  } finally {
    await app.close()
  }
})

test('production connections: red border and a confirmation before every write', async () => {
  const { app, page } = await launchApp()
  try {
    await addConnection(page, 'Prod', { production: true })
    await openColl(page, 0, 'c6')
    await expect(page.getByTestId('tab-shop.c6')).toHaveAttribute('data-production', 'true')
    await expect(page.getByTestId('pane-primary')).toHaveAttribute('data-production', 'true')

    const insert = async () => {
      await page.getByTestId('insert-button').click()
      const ed = page.getByTestId('insert-editor').locator('.view-lines')
      await ed.click()
      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.press('Backspace')
      await expect(ed).toHaveText('')
      await page.keyboard.insertText('{ prodTest: 1 }')
      await page.getByTestId('insert-submit').click()
    }

    // Declining stops the write.
    await insert()
    await expect(page.getByTestId('production-confirm-action')).toHaveText('Insert 1 document into shop.c6.')
    await page.getByTestId('production-cancel').click()
    await expect(page.getByTestId('production-confirm')).toHaveCount(0)
    expect(await admin.db('shop').collection('c6').countDocuments({ prodTest: 1 })).toBe(0)
    await page.keyboard.press('Escape')

    // Confirming lets it through.
    await insert()
    await page.getByTestId('production-proceed').click()
    await expect.poll(() => admin.db('shop').collection('c6').countDocuments({ prodTest: 1 })).toBe(1)
  } finally {
    await app.close()
  }
})

test('Done when: 20 tabs across 3 connections switch in under 100 ms', async () => {
  test.setTimeout(240_000)
  const { app, page } = await launchApp()
  try {
    for (const name of ['One', 'Two', 'Three']) await addConnection(page, name)
    let opened = 0
    for (let conn = 0; conn < 3 && opened < 20; conn++)
      for (const c of COLLS) {
        if (opened === 20) break
        await openColl(page, conn, c)
        await expect(page.getByTestId('pane-primary').getByTestId('result-count')).toHaveText(/\d+ documents/)
        opened++
      }
    const tabs = page.getByRole('tab')
    await expect(tabs).toHaveCount(20)
    // Results are already loaded in every tab, so a switch is pure UI work. Measure from the
    // mousedown to the second animation frame after it (the new tab has been painted).
    const ids = await tabs.evaluateAll((els) => els.map((e) => e.getAttribute('data-tab-id')!))
    const times: number[] = []
    for (const id of [...ids, ...ids.slice().reverse()]) {
      const ms = await page.evaluate(async (tabId) => {
        const el = document.querySelector(`[data-tab-id="${tabId}"][role=tab]`)!
        const t0 = performance.now()
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const shown = document.querySelector('[data-testid=pane-primary]')?.getAttribute('data-tab-id')
        if (shown !== tabId) throw new Error(`tab ${tabId} not shown`)
        return performance.now() - t0
      }, id)
      times.push(ms)
    }
    times.sort((a, b) => a - b)
    const p50 = times[Math.floor(times.length / 2)]!
    const max = times.at(-1)!
    console.log(
      `tab switch over ${times.length} switches: p50 ${p50.toFixed(1)} ms, max ${max.toFixed(1)} ms`
    )
    expect(max).toBeLessThan(100)
  } finally {
    await app.close()
  }
})
