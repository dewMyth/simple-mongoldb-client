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
  const orders = admin.db('shop').collection('orders')
  await orders.insertMany(
    Array.from({ length: 5000 }, (_, i) => ({
      i,
      status: ['new', 'paid', 'shipped', 'cancelled'][i % 4],
      total: i % 500,
      tags: ['a', 'b'],
      note: 'hello world',
      loc: { type: 'Point', coordinates: [i / 100, i / 200] },
      createdAt: new Date(Date.UTC(2026, 0, 1))
    }))
  )
  await orders.createIndex({ note: 'text' })
  await orders.createIndex({ loc: '2dsphere' })
  await orders.createIndex({ tags: 1 })
  await orders.createIndex({ createdAt: 1 }, { expireAfterSeconds: 86_400 * 365 * 10 })
  await orders.createIndex({ total: -1 }, { partialFilterExpression: { total: { $gt: 400 } } })
  await orders.createIndex({ i: 'hashed' })
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
  await expect(page.getByTestId('result-count')).toHaveText('5,000 documents')
}

async function setEditor(page: Page, testId: string, text: string) {
  const lines = page.getByTestId(testId).locator('.view-lines')
  await lines.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await expect(lines).toHaveText('')
  await page.keyboard.insertText(text)
}

test('Done when: explain shows COLLSCAN and suggests an index; creating it and re-running shows IXSCAN', async () => {
  const { app, page } = await launchApp()
  try {
    await openOrders(page)
    await setEditor(page, 'filter-editor', "{ status: 'paid', total: { $gt: 100 } }")
    await page.getByTestId('explain-query').click()

    await expect(page.getByTestId('explain-tab')).toBeVisible()
    await expect(page.getByTestId('explain-index')).toContainText('COLLSCAN')
    await expect(page.getByTestId('explain-hints')).toContainText('Collection scan')
    await expect(page.getByTestId('explain-summary')).toContainText('5,000')
    await expect(page.locator('[data-testid=plan-node][data-stage=COLLSCAN]')).toBeVisible()
    await expect(page.getByTestId('index-suggestion')).toContainText('{ status: 1, total: 1 }')

    await page.getByTestId('create-suggested-index').click()
    await expect(page.getByTestId('explain-index')).toContainText('status_1_total_1', { timeout: 15_000 })
    await expect(page.locator('[data-testid=plan-node][data-stage=IXSCAN]')).toBeVisible()
    await expect(page.getByTestId('explain-hints')).toHaveCount(0)
    expect((await admin.db('shop').collection('orders').indexes()).map((i) => i.name)).toContain(
      'status_1_total_1'
    )

    // Raw output is there too.
    await page.getByTestId('toggle-raw-explain').click()
    await expect(page.getByTestId('raw-explain')).toContainText('queryPlanner')
  } finally {
    await app.close()
  }
})

test('Done when: the index list matches getIndexes(), with every type labelled; create, hide and drop', async () => {
  const { app, page } = await launchApp()
  try {
    await openOrders(page)
    await page.getByTestId('open-indexes').click()
    await expect(page.getByTestId('indexes-tab')).toBeVisible()

    const expected = (await admin.db('shop').collection('orders').indexes()).map((i) => i.name)
    const rows = page.getByTestId('index-table').locator('tbody tr')
    await expect(rows).toHaveCount(expected.length)
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice(6)))).toEqual(
      expected
    )

    const kinds = (name: string) => page.getByTestId(`index-${name}`).getByTestId('index-kinds')
    await expect(kinds('note_text')).toHaveText('Text')
    await expect(kinds('loc_2dsphere')).toContainText('2dsphere')
    await expect(kinds('tags_1')).toContainText('Multikey')
    await expect(kinds('createdAt_1')).toContainText('TTL')
    await expect(kinds('total_-1')).toContainText('Partial')
    await expect(kinds('i_hashed')).toContainText('Hashed')

    // Create (unique) from the dialog.
    await page.getByTestId('create-index').click()
    await setEditor(page, 'index-keys', '{ i: 1 }')
    await page.getByLabel('Unique').click()
    await page.getByTestId('create-index-submit').click()
    await expect(kinds('i_1')).toContainText('Unique')

    // Hide, then drop (typing the name).
    await page.getByTestId('index-i_1').getByTestId('toggle-hidden').click()
    await expect(kinds('i_1')).toContainText('Hidden')
    await page.getByTestId('index-i_1').getByTestId('drop-index').click()
    await page.getByRole('alertdialog').getByRole('textbox').fill('i_1')
    await page.getByRole('alertdialog').getByRole('button', { name: 'Drop' }).click()
    await expect(page.getByTestId('index-i_1')).toHaveCount(0)
    expect((await admin.db('shop').collection('orders').indexes()).map((i) => i.name)).not.toContain('i_1')
  } finally {
    await app.close()
  }
})

test('explain from the aggregation builder', async () => {
  const { app, page } = await launchApp()
  try {
    await openOrders(page)
    await setEditor(page, 'filter-editor', "{ status: 'new' }")
    await page.getByTestId('open-aggregation').click()
    await expect(page.getByTestId('stage-status').first()).toHaveText(/documents/)
    await page.getByTestId('explain-pipeline').click()
    await expect(page.getByTestId('explain-tab')).toContainText('aggregate')
    await expect(page.getByTestId('explain-summary')).toBeVisible()
    await expect(page.getByTestId('explain-tree')).toContainText(/COLLSCAN|IXSCAN/)
  } finally {
    await app.close()
  }
})
