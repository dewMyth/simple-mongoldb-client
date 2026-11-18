import { expect, test, type Page } from '@playwright/test'
import { MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { launchApp } from './app'

let server: MongoMemoryServer
let admin: MongoClient

test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await MongoMemoryServer.create()
  admin = await MongoClient.connect(server.getUri())
  await admin
    .db('shop')
    .collection('orders')
    .insertMany(
      Array.from({ length: 300 }, (_, i) => ({
        i,
        name: i % 3 === 0 ? `dew-${i}` : `other-${i}`,
        createdAt: new Date(Date.UTC(2025, 6 + (i % 12), 1))
      }))
    )
})

test.afterAll(async () => {
  await admin?.close()
  await server?.stop()
})

async function openOrders(page: Page) {
  await page.getByTestId('new-connection').click()
  await page.getByTestId('conn-name').fill('Local')
  await page.getByTestId('conn-uri').fill(server.getUri())
  await page.getByTestId('save-connect').click()
  await page.getByTestId('db-shop').click()
  await page.getByTestId('coll-shop.orders').click()
  await expect(page.getByTestId('result-count')).toHaveText('300 documents')
}

/**
 * Focus a Monaco editor. Monaco 0.57 takes input through an EditContext element; its hidden
 * <textarea> is only an IME helper, and focusing that steals keystrokes from the editor.
 */
async function focusEditor(page: Page, testId: string) {
  await page.getByTestId(testId).locator('.monaco-editor .view-lines').click()
}

/** Replace the filter editor's text and run with Cmd/Ctrl+Enter. */
async function runFilter(page: Page, text: string) {
  await focusEditor(page, 'filter-editor')
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(text)
  await page.keyboard.press('ControlOrMeta+Enter')
}

async function serverOps() {
  return admin
    .db('admin')
    .aggregate([
      { $currentOp: { allUsers: true, idleCursors: true } },
      {
        $match: {
          $or: [
            { 'command.comment': /^mongo-studio:/ },
            { 'cursor.originatingCommand.comment': /^mongo-studio:/ }
          ]
        }
      }
    ])
    .toArray()
}

test('runs Compass-style queries, shows counts, errors, options and history', async () => {
  const { app, page } = await launchApp()
  try {
    await openOrders(page)
    await expect(page.getByTestId('json-tree').first().locator('[data-type="date"]')).toContainText('2025-')

    await runFilter(page, '{ name: /^dew/i, createdAt: { $gte: ISODate("2026-01-01") } }')
    await expect(page.getByTestId('result-count')).toHaveText('50 documents')

    // Parse errors show inline and nothing runs.
    await runFilter(page, '{ name: foo() }')
    await expect(page.getByText(/Unsupported expression/).first()).toBeVisible()
    await expect(page.getByTestId('filter-editor')).toHaveClass(/border-destructive/)

    // Options: projection + sort + limit.
    await runFilter(page, '{ i: { $lt: 10 } }')
    await expect(page.getByTestId('result-count')).toHaveText('10 documents')
    await page.getByTestId('toggle-options').click()
    await page.getByTestId('limit-input').fill('3')
    await focusEditor(page, 'sort-editor')
    await page.keyboard.insertText('{ i: -1 }')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByTestId('json-tree')).toHaveCount(3)
    await expect(page.getByTestId('json-tree').first().locator('[data-path="i"]')).toContainText('9')

    // ↑ in the filter recalls the previous query.
    await focusEditor(page, 'filter-editor')
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('ArrowUp')
    await expect(page.getByTestId('filter-editor')).toContainText('$lt')

    // Cmd/Ctrl+Shift+F pretty-prints in shell syntax, keeping types.
    // Wait for each editor state: keystrokes racing the history recall can leave stray brackets.
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('Backspace')
    await expect(page.getByTestId('filter-editor').locator('.view-lines')).toHaveText('')
    await page.keyboard.insertText('{a:NumberLong("5"),b:{c:1}}')
    await expect(page.getByTestId('filter-editor').locator('.view-lines')).toHaveText(
      '{a:NumberLong("5"),b:{c:1}}'
    )
    await page.keyboard.press('ControlOrMeta+Shift+F')
    await expect(page.getByTestId('filter-editor')).toContainText("NumberLong('5')")
    await expect(page.getByTestId('filter-editor').locator('.view-line')).toHaveCount(6)
  } finally {
    await app.close()
  }
})

test('Esc cancels a long query and frees it on the server', async () => {
  const { app, page } = await launchApp()
  try {
    await openOrders(page)
    await runFilter(page, '{ $where: "sleep(100) || true" }') // ~10 s for the first batch
    await expect(page.getByTestId('cancel-query')).toBeVisible()
    await expect.poll(async () => (await serverOps()).length, { timeout: 5000 }).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await expect(page.getByText('Query cancelled')).toBeVisible({ timeout: 3000 })
    await expect.poll(async () => (await serverOps()).length, { timeout: 5000 }).toBe(0)
  } finally {
    await app.close()
  }
})

test('closing a tab with a running query kills it on the server', async () => {
  const { app, page } = await launchApp()
  try {
    await openOrders(page)
    // Paging fetches each page in one batch, so nothing stays open once a page has loaded.
    await expect.poll(async () => (await serverOps()).length, { timeout: 5000 }).toBe(0)
    await runFilter(page, '{ $where: "sleep(100) || true" }')
    await expect.poll(async () => (await serverOps()).length, { timeout: 5000 }).toBeGreaterThan(0)
    await page.getByRole('tab').getByLabel('Close tab').click()
    await expect.poll(async () => (await serverOps()).length, { timeout: 5000 }).toBe(0)
  } finally {
    await app.close()
  }
})

test('a query left running in a background tab is killed by "Close others"', async () => {
  const { app, page } = await launchApp()
  try {
    await openOrders(page)
    await runFilter(page, '{ $where: "sleep(100) || true" }')
    await expect.poll(async () => (await serverOps()).length, { timeout: 5000 }).toBeGreaterThan(0)
    // Open another tab (Cmd/Ctrl+click); the first keeps running in the background.
    await page.getByTestId('coll-shop.orders').click({ modifiers: ['ControlOrMeta'] })
    await expect(page.getByRole('tab')).toHaveCount(2)
    expect((await serverOps()).length).toBeGreaterThan(0)
    await page.getByRole('tab').nth(1).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close others' }).click()
    await expect(page.getByRole('tab')).toHaveCount(1)
    await expect.poll(async () => (await serverOps()).length, { timeout: 5000 }).toBe(0)
  } finally {
    await app.close()
  }
})

test('pages through results 25 at a time', async () => {
  const { app, page } = await launchApp()
  const firstI = () =>
    page.getByTestId('json-tree').first().locator('[data-path="i"] [data-testid="json-value"]').textContent()
  try {
    await openOrders(page)
    await runFilter(page, '{}')
    await page.getByTestId('toggle-options').click()
    await focusEditor(page, 'sort-editor')
    await page.keyboard.insertText('{ i: 1 }')
    await page.keyboard.press('ControlOrMeta+Enter')

    const pager = page.getByTestId('pager')
    await expect(page.getByTestId('page-range')).toHaveText('1–25')
    await expect(pager).toContainText('of 12')
    await expect.poll(firstI).toBe('0')
    await expect(page.getByTestId('page-prev')).toBeDisabled()
    await expect(page.getByTestId('page-first')).toBeDisabled()

    await page.getByTestId('page-next').click()
    await expect(page.getByTestId('page-range')).toHaveText('26–50')
    await expect.poll(firstI).toBe('25')

    await page.getByTestId('page-last').click()
    await expect(page.getByTestId('page-range')).toHaveText('276–300')
    await expect(page.getByTestId('page-next')).toBeDisabled()
    await expect.poll(firstI).toBe('275')

    await page.getByTestId('page-prev').click()
    await expect(page.getByTestId('page-range')).toHaveText('251–275')

    // Jump straight to page 5.
    await page.getByTestId('page-input').fill('5')
    await page.getByTestId('page-input').press('Enter')
    await expect(page.getByTestId('page-range')).toHaveText('101–125')
    await expect.poll(firstI).toBe('100')

    await page.getByTestId('page-first').click()
    await expect(page.getByTestId('page-range')).toHaveText('1–25')

    // Paging never leaves a cursor open on the server.
    expect((await serverOps()).length).toBe(0)

    // The user's own limit caps the pages: limit 60 → 3 pages, the last with 10 documents.
    await page.getByTestId('limit-input').fill('60')
    await page.getByTestId('limit-input').press('Enter')
    await expect(pager).toContainText('of 3')
    await page.getByTestId('page-last').click()
    await expect(page.getByTestId('page-range')).toHaveText('51–60')
    await expect(page.getByTestId('result-count')).toHaveText('60 documents')

    // A new Find starts again at page 1.
    await page.getByTestId('run-query').click()
    await expect(page.getByTestId('page-range')).toHaveText('1–25')
  } finally {
    await app.close()
  }
})
