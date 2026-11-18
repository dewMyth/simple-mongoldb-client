import { expect, test, type Page } from '@playwright/test'
import { MongoClient, ObjectId } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { launchApp } from './app'

let server: MongoMemoryServer
let admin: MongoClient
const firstId = new ObjectId('65f1c0a1b2c3d4e5f6a7b8c9')

test.beforeAll(async () => {
  test.setTimeout(180_000)
  server = await MongoMemoryServer.create()
  admin = await MongoClient.connect(server.getUri())
  await admin
    .db('shop')
    .collection('customers')
    .insertMany(
      Array.from({ length: 30 }, (_, i) => ({
        ...(i === 0 ? { _id: firstId } : {}),
        customer: { name: ['Ada', 'Grace', 'Linus'][i % 3], since: new Date(Date.UTC(2020, i % 12, 1)) },
        status: i % 2 ? 'paid' : 'pending',
        total: i * 10
      }))
    )
})

test.afterAll(async () => {
  await admin?.close()
  await server?.stop()
})

async function openCustomers(page: Page) {
  await page.getByTestId('new-connection').click()
  await page.getByTestId('conn-name').fill('Local')
  await page.getByTestId('conn-uri').fill(server.getUri())
  await page.getByTestId('save-connect').click()
  await page.getByTestId('db-shop').click()
  await page.getByTestId('coll-shop.customers').click()
  await expect(page.getByTestId('result-count')).toHaveText('30 documents')
}

async function clearFilter(page: Page) {
  await page.getByTestId('filter-editor').locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await expect(page.getByTestId('filter-editor').locator('.view-lines')).toHaveText('')
}

/**
 * Opens the query tools menu. A Radix menu's closed content stays mounted for its 150 ms exit
 * animation, and a click on the trigger in that window counts as an "outside" click that closes
 * the new menu, so wait for the previous one to unmount first.
 */
async function openTools(page: Page) {
  await expect(page.locator('[data-slot=dropdown-menu-content]')).toHaveCount(0)
  await page.getByTestId('query-tools').click()
}

const suggest = (page: Page) => page.locator('.suggest-widget.visible')
const filterText = (page: Page) =>
  page
    .getByTestId('filter-editor')
    .locator('.view-lines')
    .innerText()
    .then((t) => t.replace(/\u00a0/g, ' '))

test('Done when: typing `{ cus` suggests customer.name with its type; values and operators follow context', async () => {
  const { app, page } = await launchApp()
  try {
    await openCustomers(page)
    await clearFilter(page)

    await page.keyboard.type('{ cus')
    const row = suggest(page).locator('.monaco-list-row', { hasText: 'customer.name' })
    await expect(row).toBeVisible()
    await expect(row).toContainText('String · 100%')
    // The top-level "customer" object ranks first; narrowing picks the dotted path.
    await page.keyboard.type('tomer.n')
    await expect(suggest(page).locator('.monaco-list-row.focused')).toContainText('customer.name')
    await page.keyboard.press('Enter')
    await expect.poll(() => filterText(page)).toContain('{ "customer.name"')

    // Value suggestions from the sample (low-cardinality strings).
    await page.keyboard.type(': "')
    await expect(suggest(page).locator('.monaco-list-row', { hasText: 'Grace' })).toBeVisible()
    await expect(suggest(page)).toContainText('Linus')
    await page.keyboard.type('Gr')
    await page.keyboard.press('Enter')
    await expect.poll(() => filterText(page)).toMatch(/\{ "customer\.name": "Grace"\s*\}/)
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByTestId('result-count')).toHaveText('10 documents')

    // Field-level operators inside a field's value document, not top-level ones.
    await clearFilter(page)
    await page.keyboard.type('{ total: { $')
    await expect(suggest(page).locator('.monaco-list-row', { hasText: '$gte' })).toBeVisible()
    await expect(suggest(page).locator('.monaco-list-row', { hasText: '$or' })).toHaveCount(0)
    await page.keyboard.type('gte')
    await page.keyboard.press('Enter')
    await page.keyboard.type('250')
    await expect.poll(() => filterText(page)).toMatch(/\{ total: \{ \$gte: 250\s*\}\s*\}/)
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.getByTestId('result-count')).toHaveText('5 documents')
  } finally {
    await app.close()
  }
})

test('hover docs, convert to EJSON and back, export to code', async () => {
  const { app, page } = await launchApp()
  try {
    await openCustomers(page)
    await clearFilter(page)
    await page.keyboard.insertText(`{ _id: ObjectId("${firstId.toHexString()}"), total: { $lt: 5 } }`)

    // Hover on an operator.
    // The token span (" $lt: ") is centred on the operator. Monaco ignores a single synthetic
    // mousemove, so move there in steps like a real pointer.
    // Retried: a hover can be missed if the editor is still settling.
    await expect(async () => {
      const box = (await page
        .getByTestId('filter-editor')
        .locator('.view-line span span', { hasText: '$lt' })
        .boundingBox())!
      await page.mouse.move(box.x - 40, box.y + 40)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
      await expect(page.locator('.monaco-hover').filter({ hasText: 'less than' })).toBeVisible({
        timeout: 2000
      })
    }).toPass({ timeout: 15_000 })

    // Convert to canonical EJSON: still runs, then back to shell syntax.
    await openTools(page)
    await page.getByTestId('convert-canonical').click()
    await expect.poll(() => filterText(page)).toContain('"$oid"')
    await page.getByTestId('run-query').click()
    await expect(page.getByTestId('result-count')).toHaveText('1 document')
    await openTools(page)
    await page.getByTestId('convert-shell').click()
    await expect.poll(() => filterText(page)).toContain(`ObjectId("${firstId.toHexString()}")`)

    // Export to code: Python count, with no connection string in the output.
    await openTools(page)
    await page.getByTestId('export-code-item').click()
    await page.getByTestId('export-lang-python').click()
    await page.getByTestId('export-mode-count').click()
    const code = page.getByTestId('export-code')
    await expect(code).toContainText('client["shop"]["customers"]')
    await expect(code).toContainText('count_documents(')
    await expect(code).toContainText(`ObjectId("${firstId.toHexString()}")`)
    await expect(code).not.toContainText(server.getUri())
    await page.getByTestId('export-lang-go').click()
    await expect(code).toContainText('go.mongodb.org/mongo-driver/v2')
  } finally {
    await app.close()
  }
})
